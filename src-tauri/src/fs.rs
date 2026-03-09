use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static PROJECT_ROOT: std::sync::LazyLock<Mutex<Option<PathBuf>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// Set the current project root (called when a folder is opened).
pub fn set_project_root(path: Option<PathBuf>) {
    if let Ok(mut root) = PROJECT_ROOT.lock() {
        *root = path;
    }
}

/// Validate that a path is within the project root or ~/.volt/ config dir.
/// Returns the canonicalized path on success.
fn validate_path(path: &str) -> Result<PathBuf, String> {
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

    // Always allow ~/.volt/ config directory
    if let Some(home) = dirs::home_dir() {
        let volt_dir = home.join(".volt");
        if let Ok(canon_volt) = fs::canonicalize(&volt_dir) {
            if target.starts_with(&canon_volt) {
                return Ok(target);
            }
        }
    }

    // Check against project root
    if let Ok(root) = PROJECT_ROOT.lock() {
        if let Some(ref root_path) = *root {
            if let Ok(canon_root) = fs::canonicalize(root_path) {
                if target.starts_with(&canon_root) {
                    return Ok(target);
                }
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
    let file_path = Path::new(&path);
    if !file_path.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let metadata = fs::metadata(&path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("File too large (>5MB)".to_string());
    }

    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
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
    let file_path = Path::new(&path);
    if !file_path.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let metadata = fs::metadata(&path)
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

    let bytes = fs::read(&path)
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
    atomic_write(Path::new(&path), content.as_bytes())
}

// ── Swap files (crash recovery) ──

fn swap_path(path: &str) -> PathBuf {
    let p = Path::new(path);
    let name = p.file_name().unwrap_or_default().to_string_lossy();
    p.with_file_name(format!(".{}.volt-swap", name))
}

#[tauri::command]
pub fn write_swap_file(path: String, content: String) -> Result<(), String> {
    fs::write(swap_path(&path), &content)
        .map_err(|e| format!("Failed to write swap file: {}", e))
}

#[tauri::command]
pub fn check_swap_file(path: String) -> Option<String> {
    let sp = swap_path(&path);
    if sp.is_file() {
        fs::read_to_string(&sp).ok()
    } else {
        None
    }
}

#[tauri::command]
pub fn delete_swap_file(path: String) -> Result<(), String> {
    let sp = swap_path(&path);
    if sp.exists() {
        fs::remove_file(&sp).map_err(|e| format!("Failed to delete swap file: {}", e))?;
    }
    Ok(())
}

// ── File operations ──

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    validate_path(&path)?;
    let p = Path::new(&path);
    if p.exists() {
        return Err("File already exists".into());
    }
    fs::write(&path, "").map_err(|e| format!("Failed to create file: {}", e))
}

#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    validate_path(&path)?;
    let p = Path::new(&path);
    if p.exists() {
        return Err("Directory already exists".into());
    }
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {}", e))
}

#[tauri::command]
pub fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    validate_path(&old_path)?;
    validate_path(&new_path)?;
    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    validate_path(&path)?;
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete: {}", e))
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete: {}", e))
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
        if name.starts_with('.') { continue; }
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, ignored, files, depth + 1)?;
        } else {
            files.push(path);
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
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let ignored_patterns: Vec<String> = ignored.unwrap_or_else(|| {
        DEFAULT_IGNORED.iter().map(|s| s.to_string()).collect()
    });
    let mut full_paths = Vec::new();
    collect_files_recursive(root, &ignored_patterns, &mut full_paths, 0)?;
    let files: Vec<String> = full_paths
        .iter()
        .filter_map(|p| p.strip_prefix(root).ok())
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

#[tauri::command]
pub async fn search_in_files(
    path: String,
    query: String,
    ignored: Option<Vec<String>>,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    tokio::task::spawn_blocking(move || {
        search_in_files_inner(path, query, ignored)
    })
    .await
    .map_err(|e| format!("Search task failed: {}", e))?
}

fn search_in_files_inner(
    path: String,
    query: String,
    ignored: Option<Vec<String>>,
) -> Result<Vec<SearchMatch>, String> {
    let root = Path::new(&path);
    let ignored_patterns: Vec<String> = ignored.unwrap_or_else(|| {
        DEFAULT_IGNORED.iter().map(|s| s.to_string()).collect()
    });
    let mut full_paths = Vec::new();
    collect_files_recursive(root, &ignored_patterns, &mut full_paths, 0)?;

    let query_lower: Vec<u8> = query.bytes().map(|b| b.to_ascii_lowercase()).collect();
    let mut results = Vec::new();

    for file_path in &full_paths {
        if results.len() >= 200 { break; }
        let metadata = match fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > 1024 * 1024 { continue; }

        let bytes = match fs::read(file_path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if is_binary(&bytes) { continue; }

        let content = String::from_utf8_lossy(&bytes);
        let file_name = file_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let path_str = file_path.to_string_lossy().to_string();

        for (i, line) in content.lines().enumerate() {
            if results.len() >= 200 { break; }
            if let Some(col) = find_ascii_case_insensitive(line.as_bytes(), &query_lower) {
                results.push(SearchMatch {
                    path: path_str.clone(),
                    file_name: file_name.clone(),
                    line_number: i + 1,
                    line_content: line.chars().take(200).collect(),
                    column: col + 1,
                });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub fn open_in_file_manager(path: String) -> Result<(), String> {
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
