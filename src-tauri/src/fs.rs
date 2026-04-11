use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Stores the pre-canonicalized project root (set once when a folder is opened).
static PROJECT_ROOT: std::sync::LazyLock<Mutex<Option<PathBuf>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// Cached canonical path to ~/.volt/ (resolved lazily on first successful access).
static CACHED_VOLT_DIR: std::sync::LazyLock<Mutex<Option<PathBuf>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// Get the canonical ~/.volt/ path, caching after first successful resolution.
fn get_canonical_volt_dir() -> Option<PathBuf> {
    if let Ok(cache) = CACHED_VOLT_DIR.lock() {
        if cache.is_some() {
            return cache.clone();
        }
    }
    let dir = dirs::home_dir()?.join(".volt");
    let canonical = fs::canonicalize(&dir).ok()?;
    if let Ok(mut cache) = CACHED_VOLT_DIR.lock() {
        *cache = Some(canonical.clone());
    }
    Some(canonical)
}

/// Set the current project root (called when a folder is opened).
/// Canonicalizes immediately so validate_path doesn't repeat the work.
pub fn set_project_root(path: Option<PathBuf>) {
    if let Ok(mut root) = PROJECT_ROOT.lock() {
        *root = path.and_then(|p| fs::canonicalize(&p).ok());
    }
}

/// Validate that a path is within the project root or ~/.volt/ config dir.
/// Returns the canonicalized path on success.
///
/// Callers should use the returned `PathBuf` for the actual operation instead
/// of the raw frontend string — operating on the canonical form closes the
/// TOCTOU window where a symlink component could be swapped between validation
/// and use.
pub(crate) fn validate_path(path: &str) -> Result<PathBuf, String> {
    let target = fs::canonicalize(path)
        .or_else(|_| {
            // File may not exist yet (create_file) — canonicalize parent
            let p = Path::new(path);
            if let Some(parent) = p.parent() {
                let canon_parent = fs::canonicalize(parent)?;
                Ok(canon_parent.join(p.file_name().unwrap_or_default()))
            } else {
                Err(std::io::Error::new(std::io::ErrorKind::NotFound, "Invalid path"))
            }
        })
        .map_err(|e| format!("Path validation failed: {}", e))?;

    // Always allow ~/.volt/ config directory (cached canonical path)
    if let Some(volt_dir) = get_canonical_volt_dir() {
        if target.starts_with(&volt_dir) {
            return Ok(target);
        }
    }

    // Check against project root (pre-canonicalized at set time)
    if let Ok(root) = PROJECT_ROOT.lock() {
        if let Some(ref canon_root) = *root {
            if target.starts_with(canon_root) {
                return Ok(target);
            }
        }
    }

    Err("Path is outside the project directory".to_string())
}

#[derive(Debug, Serialize)]
pub struct FileContent {
    pub content: String,
    pub language: String,
    pub file_name: String,
}

#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
}

const DEFAULT_IGNORED: &[&str] = &[
    ".git",
    "build",
    ".dart_tool",
    "node_modules",
    ".gradle",
    "target",
];

#[tauri::command]
pub fn read_directory(path: String, ignored: Option<Vec<String>>) -> Result<Vec<DirectoryEntry>, String> {
    // Validate but walk the raw frontend path: `fs::canonicalize` on Windows
    // returns UNC-prefixed paths (\\?\C:\...), and returning those in entries
    // breaks the frontend's relative-path computations in file-tree.js
    // (git decoration, gitignore dimming, breadcrumbs) and the tab-dedup
    // comparison in terminal.js. Operating on the raw path after validation
    // keeps the frontend's path format consistent with what it passed in.
    validate_path(&path)?;
    let dir_path = Path::new(&path);
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let ignored_patterns: Vec<String> = ignored.unwrap_or_else(|| {
        DEFAULT_IGNORED.iter().map(|s| s.to_string()).collect()
    });

    let mut entries: Vec<DirectoryEntry> = Vec::new();
    let read_dir = fs::read_dir(dir_path).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        if ignored_patterns.iter().any(|p| p == &name) {
            continue;
        }
        // Hide internal swap/temp files from the file tree
        if name.ends_with(".volt-swap") || name.ends_with(".volt-tmp") {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let is_hidden = name.starts_with('.');

        entries.push(DirectoryEntry {
            path: entry.path().to_string_lossy().to_string(),
            name,
            is_dir: metadata.is_dir(),
            is_hidden,
        });
    }

    // Sort: folders first, then files. Both alphabetical case-insensitive.
    // Uses byte-level ASCII comparison to avoid allocating new Strings per comparison.
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.as_bytes().iter()
                .map(|c| c.to_ascii_lowercase())
                .cmp(b.name.as_bytes().iter().map(|c| c.to_ascii_lowercase())),
        }
    });

    Ok(entries)
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

fn detect_language(ext: &str) -> &'static str {
    match ext {
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "ts" | "mts" | "cts" | "tsx" => "typescript",
        "rs" => "rust",
        "py" | "pyw" => "python",
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        "json" | "jsonc" => "json",
        "yaml" | "yml" => "yaml",
        "md" | "mdx" => "markdown",
        "dart" => "dart",
        "toml" => "toml",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "xml" | "svg" => "html",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        _ => "plain",
    }
}

#[tauri::command]
pub fn read_file(path: String) -> Result<FileContent, String> {
    let file_path = validate_path(&path)?;
    if !file_path.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let metadata = fs::metadata(&file_path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("File too large (>5MB)".to_string());
    }

    let bytes = fs::read(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;
    if is_binary(&bytes) {
        return Err("Binary file".to_string());
    }

    let content = String::from_utf8_lossy(&bytes).to_string();
    let file_name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let language = detect_language(&ext).to_string();

    Ok(FileContent {
        content,
        language,
        file_name,
    })
}

// ── Image files ──

#[derive(Debug, Serialize)]
pub struct ImageContent {
    pub data: String,
    pub mime: String,
    pub file_name: String,
    pub size: u64,
}

fn detect_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        "tiff" | "tif" => Some("image/tiff"),
        _ => None,
    }
}

#[tauri::command]
pub fn read_image_file(path: String) -> Result<ImageContent, String> {
    let file_path = validate_path(&path)?;
    if !file_path.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let metadata = fs::metadata(&file_path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let size = metadata.len();
    if size > 20 * 1024 * 1024 {
        return Err("Image too large (>20MB)".to_string());
    }

    let ext = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = detect_mime(&ext)
        .ok_or_else(|| format!("Unsupported image format: {}", ext))?
        .to_string();

    let bytes = fs::read(&file_path)
        .map_err(|e| format!("Failed to read image: {}", e))?;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);

    let file_name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(ImageContent { data, mime, file_name, size })
}

/// Write content to a file atomically: write to a temp file in the same
/// directory, then rename over the original.  This prevents data loss if
/// the process crashes (or Windows bluescreens) mid-write.
pub(crate) fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let temp = path.with_file_name(format!(
        ".{}.volt-tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));

    fs::write(&temp, content)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    fs::rename(&temp, path).map_err(|e| {
        // Clean up temp file on rename failure
        let _ = fs::remove_file(&temp);
        format!("Failed to finalize write: {}", e)
    })
}

#[tauri::command]
pub fn save_file(path: String, content: String) -> Result<(), String> {
    let canonical = validate_path(&path)?;
    atomic_write(&canonical, content.as_bytes())
}

// ── Swap files (crash recovery) ──

fn swap_path(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{}.volt-swap", name))
}

#[tauri::command]
pub fn write_swap_file(path: String, content: String) -> Result<(), String> {
    let canonical = validate_path(&path)?;
    fs::write(swap_path(&canonical), &content)
        .map_err(|e| format!("Failed to write swap file: {}", e))
}

#[tauri::command]
pub fn check_swap_file(path: String) -> Result<Option<String>, String> {
    let canonical = validate_path(&path)?;
    let sp = swap_path(&canonical);
    if sp.is_file() {
        Ok(fs::read_to_string(&sp).ok())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn delete_swap_file(path: String) -> Result<(), String> {
    let canonical = validate_path(&path)?;
    let sp = swap_path(&canonical);
    if sp.exists() {
        fs::remove_file(&sp).map_err(|e| format!("Failed to delete swap file: {}", e))?;
    }
    Ok(())
}

// ── File operations ──

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let canonical = validate_path(&path)?;
    if canonical.exists() {
        return Err("File already exists".into());
    }
    fs::write(&canonical, "").map_err(|e| format!("Failed to create file: {}", e))
}

#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    let canonical = validate_path(&path)?;
    if canonical.exists() {
        return Err("Directory already exists".into());
    }
    fs::create_dir_all(&canonical).map_err(|e| format!("Failed to create directory: {}", e))
}

#[tauri::command]
pub fn rename_path(old_path: String, new_path: String, force: Option<bool>) -> Result<(), String> {
    let old_canonical = validate_path(&old_path)?;
    let new_canonical = validate_path(&new_path)?;
    // Case-only rename on case-insensitive filesystems (Windows, default
    // macOS) canonicalizes both paths to the same buffer — allow that and
    // use the raw frontend strings for the actual rename so the new casing
    // is preserved.
    let case_only_rename = old_canonical == new_canonical;
    // Reject overwrite unless the caller explicitly opted in via `force`
    // (e.g. the file tree's drag-drop flow after the user confirms a
    // "Replace?" prompt). Without `force`, fs::rename would silently
    // clobber the destination; the default-deny here protects against both
    // accidental clobber in the UI and a compromised frontend calling
    // rename_path directly.
    if !case_only_rename && !force.unwrap_or(false) && new_canonical.exists() {
        return Err("Destination already exists".into());
    }
    if case_only_rename {
        // Both paths have been validated above; the small TOCTOU window
        // here is the cost of preserving case-only renames on Windows.
        fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))
    } else {
        fs::rename(&old_canonical, &new_canonical).map_err(|e| format!("Failed to rename: {}", e))
    }
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let canonical = validate_path(&path)?;
    if canonical.is_dir() {
        fs::remove_dir_all(&canonical).map_err(|e| format!("Failed to delete: {}", e))
    } else {
        fs::remove_file(&canonical).map_err(|e| format!("Failed to delete: {}", e))
    }
}

// ── Recursive file listing (for quick open) ──

const MAX_DEPTH: usize = 64;
const MAX_FILES: usize = 100_000;

fn collect_files_recursive(dir: &Path, ignored: &[String], files: &mut Vec<PathBuf>, depth: usize) -> Result<(), String> {
    if depth >= MAX_DEPTH || files.len() >= MAX_FILES {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries.flatten() {
        if files.len() >= MAX_FILES { break; }
        let name = entry.file_name().to_string_lossy().to_string();
        if ignored.iter().any(|p| p == &name) { continue; }
        // Hide internal swap/temp files
        if name.ends_with(".volt-swap") || name.ends_with(".volt-tmp") { continue; }
        // Use file_type() instead of path.is_dir() — avoids an extra stat syscall
        // per entry (file_type is free on most filesystems via readdir d_type).
        // file_type() does NOT follow symlinks on Win/macOS/Linux, so is_symlink()
        // is authoritative here.
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        // Skip symlinks: a malicious project could ship `./link -> /etc` (or
        // ~/.ssh) and search_in_files would otherwise read and return file
        // content from outside the project root. Also prevents infinite
        // recursion from self-referential symlinks.
        if file_type.is_symlink() { continue; }
        if file_type.is_dir() {
            // Skip hidden directories (e.g. .git, .vscode) but not hidden files
            if name.starts_with('.') { continue; }
            collect_files_recursive(&entry.path(), ignored, files, depth + 1)?;
        } else {
            files.push(entry.path());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_all_files(path: String, ignored: Option<Vec<String>>) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        list_all_files_inner(path, ignored)
    })
    .await
    .map_err(|e| format!("File listing task failed: {}", e))?
}

fn list_all_files_inner(path: String, ignored: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let root = validate_path(&path)?;
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let ignored_patterns: Vec<String> = ignored.unwrap_or_else(|| {
        DEFAULT_IGNORED.iter().map(|s| s.to_string()).collect()
    });
    let mut full_paths = Vec::new();
    collect_files_recursive(&root, &ignored_patterns, &mut full_paths, 0)?;
    let files: Vec<String> = full_paths
        .iter()
        .filter_map(|p| p.strip_prefix(&root).ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    Ok(files)
}

// ── Search helpers ──

/// Case-insensitive substring search without allocation.
/// `needle` must already be ASCII-lowercased bytes.
fn find_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    let nlen = needle.len();
    if nlen == 0 { return Some(0); }
    if nlen > haystack.len() { return None; }
    'outer: for i in 0..=(haystack.len() - nlen) {
        for j in 0..nlen {
            if haystack[i + j].to_ascii_lowercase() != needle[j] {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

// ── Search in files ──

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub file_name: String,
    pub line_number: usize,
    pub line_content: String,
    pub column: usize,
}

#[derive(Debug, Serialize)]
pub struct SearchResults {
    pub results: Vec<SearchMatch>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn search_in_files(
    path: String,
    query: String,
    ignored: Option<Vec<String>>,
    is_regex: Option<bool>,
) -> Result<SearchResults, String> {
    if query.is_empty() {
        return Ok(SearchResults { results: Vec::new(), truncated: false });
    }
    tokio::task::spawn_blocking(move || {
        search_in_files_inner(path, query, ignored, is_regex.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("Search task failed: {}", e))?
}

/// Trait object for search matching — avoids duplicating the file-walk logic
/// for literal vs regex search.
trait LineMatcher: Sync {
    /// Returns the byte offset of the first match in `line`, or None.
    fn find_in(&self, line: &str) -> Option<usize>;
}

struct LiteralMatcher {
    query_lower: Vec<u8>,
}

impl LineMatcher for LiteralMatcher {
    fn find_in(&self, line: &str) -> Option<usize> {
        find_ascii_case_insensitive(line.as_bytes(), &self.query_lower)
    }
}

struct RegexMatcher {
    re: regex::Regex,
}

impl LineMatcher for RegexMatcher {
    fn find_in(&self, line: &str) -> Option<usize> {
        self.re.find(line).map(|m| m.start())
    }
}

fn search_in_files_inner(
    path: String,
    query: String,
    ignored: Option<Vec<String>>,
    is_regex: bool,
) -> Result<SearchResults, String> {
    // Validate but walk the raw path. The returned `SearchMatch.path` must
    // be in the same form the frontend already uses elsewhere so that
    // clicking a result can dedup against existing tabs — walking a
    // canonical UNC root on Windows would produce `\\?\C:\...` result paths
    // and break that match. Symlink safety is enforced inside
    // `collect_files_recursive`, not by canonicalizing the root.
    validate_path(&path)?;
    let root = Path::new(&path);
    let ignored_patterns: Vec<String> = ignored.unwrap_or_else(|| {
        DEFAULT_IGNORED.iter().map(|s| s.to_string()).collect()
    });
    let mut full_paths = Vec::new();
    collect_files_recursive(root, &ignored_patterns, &mut full_paths, 0)?;

    if full_paths.is_empty() {
        return Ok(SearchResults { results: Vec::new(), truncated: false });
    }

    // Build matcher: regex or case-insensitive literal
    let matcher: Box<dyn LineMatcher> = if is_regex {
        let re = regex::RegexBuilder::new(&query)
            .case_insensitive(true)
            .build()
            .map_err(|e| format!("Invalid regex: {}", e))?;
        Box::new(RegexMatcher { re })
    } else {
        Box::new(LiteralMatcher {
            query_lower: query.bytes().map(|b| b.to_ascii_lowercase()).collect(),
        })
    };

    let max_results: usize = 200;
    let total_found = std::sync::atomic::AtomicUsize::new(0);
    let num_threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(8);
    let chunk_size = full_paths.len().div_ceil(num_threads);

    let mut results = Vec::new();

    std::thread::scope(|s| {
        let handles: Vec<_> = full_paths
            .chunks(chunk_size)
            .map(|chunk| {
                let matcher = &matcher;
                let total_found = &total_found;
                s.spawn(move || {
                    let mut local_results = Vec::new();
                    for file_path in chunk {
                        if total_found.load(std::sync::atomic::Ordering::Relaxed) >= max_results {
                            break;
                        }
                        let metadata = match fs::metadata(file_path) {
                            Ok(m) => m,
                            Err(_) => continue,
                        };
                        if metadata.len() > 1024 * 1024 {
                            continue;
                        }

                        let bytes = match fs::read(file_path) {
                            Ok(b) => b,
                            Err(_) => continue,
                        };
                        if is_binary(&bytes) {
                            continue;
                        }

                        let content = String::from_utf8_lossy(&bytes);
                        let file_name = file_path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        let path_str = file_path.to_string_lossy().to_string();

                        for (i, line) in content.lines().enumerate() {
                            if total_found.load(std::sync::atomic::Ordering::Relaxed) >= max_results
                            {
                                break;
                            }
                            if let Some(col) = matcher.find_in(line)
                            {
                                local_results.push(SearchMatch {
                                    path: path_str.clone(),
                                    file_name: file_name.clone(),
                                    line_number: i + 1,
                                    line_content: line.chars().take(200).collect(),
                                    column: col + 1,
                                });
                                total_found.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            }
                        }
                    }
                    local_results
                })
            })
            .collect();

        for handle in handles {
            if let Ok(local) = handle.join() {
                results.extend(local);
            }
        }
    });

    let truncated = results.len() >= max_results;
    results.truncate(max_results);
    Ok(SearchResults { results, truncated })
}

/// Check if a path is a directory. No path validation — used by drag-and-drop
/// to distinguish folders from files before a project root is set.
/// Safe: returns only a boolean, no content is exposed.
#[tauri::command]
pub fn is_directory(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
pub fn open_in_file_manager(path: String) -> Result<(), String> {
    // Deliberately operate on the raw (post-validation) path here rather than
    // the canonical PathBuf returned by validate_path. fs::canonicalize on
    // Windows returns UNC-prefixed paths (\\?\C:\...) which explorer.exe can
    // render incorrectly. The TOCTOU risk on this command is limited to
    // "redirect explorer to a different folder", which is not a privilege
    // escalation — the user can already browse any folder themselves.
    validate_path(&path)?;
    let p = Path::new(&path);
    let dir = if p.is_file() {
        p.parent().unwrap_or(p)
    } else {
        p
    };

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    // Only allow http/https URLs
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http and https URLs are allowed".into());
    }

    #[cfg(target_os = "windows")]
    {
        // Use explorer.exe directly instead of cmd.exe to avoid command injection.
        // cmd /C start passes the URL through cmd's metacharacter interpreter,
        // allowing crafted URLs to execute arbitrary commands.
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(&url);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── detect_language ──

    #[test]
    fn test_detect_language_common() {
        assert_eq!(detect_language("rs"), "rust");
        assert_eq!(detect_language("js"), "javascript");
        assert_eq!(detect_language("ts"), "typescript");
        assert_eq!(detect_language("py"), "python");
        assert_eq!(detect_language("dart"), "dart");
        assert_eq!(detect_language("go"), "go");
        assert_eq!(detect_language("html"), "html");
        assert_eq!(detect_language("css"), "css");
        assert_eq!(detect_language("json"), "json");
        assert_eq!(detect_language("md"), "markdown");
        assert_eq!(detect_language("toml"), "toml");
        assert_eq!(detect_language("sh"), "shell");
    }

    #[test]
    fn test_detect_language_variants() {
        assert_eq!(detect_language("jsx"), "javascript");
        assert_eq!(detect_language("tsx"), "typescript");
        assert_eq!(detect_language("mjs"), "javascript");
        assert_eq!(detect_language("pyw"), "python");
        assert_eq!(detect_language("yml"), "yaml");
        assert_eq!(detect_language("htm"), "html");
        assert_eq!(detect_language("scss"), "css");
        assert_eq!(detect_language("mdx"), "markdown");
    }

    #[test]
    fn test_detect_language_unknown() {
        assert_eq!(detect_language("xyz"), "plain");
        assert_eq!(detect_language(""), "plain");
    }

    // ── is_binary ──

    #[test]
    fn test_is_binary_text() {
        assert!(!is_binary(b"Hello, world!\nLine 2\n"));
    }

    #[test]
    fn test_is_binary_with_null() {
        assert!(is_binary(b"Hello\x00world"));
    }

    #[test]
    fn test_is_binary_empty() {
        assert!(!is_binary(b""));
    }

    // ── find_ascii_case_insensitive ──

    #[test]
    fn test_find_case_insensitive_basic() {
        let haystack = b"Hello World";
        let needle = b"hello";
        assert_eq!(find_ascii_case_insensitive(haystack, needle), Some(0));
    }

    #[test]
    fn test_find_case_insensitive_middle() {
        let haystack = b"foo Bar baz";
        let needle = b"bar";
        assert_eq!(find_ascii_case_insensitive(haystack, needle), Some(4));
    }

    #[test]
    fn test_find_case_insensitive_not_found() {
        let haystack = b"Hello World";
        let needle = b"xyz";
        assert_eq!(find_ascii_case_insensitive(haystack, needle), None);
    }

    #[test]
    fn test_find_case_insensitive_empty_needle() {
        let haystack = b"Hello";
        assert_eq!(find_ascii_case_insensitive(haystack, b""), Some(0));
    }

    #[test]
    fn test_find_case_insensitive_needle_longer() {
        let haystack = b"Hi";
        let needle = b"hello";
        assert_eq!(find_ascii_case_insensitive(haystack, needle), None);
    }

    #[test]
    fn test_find_case_insensitive_exact() {
        let haystack = b"test";
        let needle = b"test";
        assert_eq!(find_ascii_case_insensitive(haystack, needle), Some(0));
    }
}
