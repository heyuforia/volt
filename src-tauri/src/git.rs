use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Debug, Serialize, Clone)]
pub struct GitStatus {
    /// Map of relative path → status code ("M", "A", "D", "U", "?")
    pub files: HashMap<String, String>,
    /// Relative paths of gitignored files/directories (dirs have trailing "/")
    pub ignored: Vec<String>,
    /// The git repo root (so frontend can compute relative paths)
    pub root: String,
}

/// Cached git status to avoid re-running git on every file tree refresh.
/// TTL: 2 seconds. Keyed by git root path.
struct GitCache {
    root: String,
    result: GitStatus,
    timestamp: Instant,
}

static GIT_CACHE: std::sync::LazyLock<Mutex<Option<GitCache>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

const GIT_CACHE_TTL_MS: u128 = 2000;

/// Walk up from `start` to find the nearest `.git` directory.
fn find_git_root(start: &Path) -> Option<&Path> {
    let mut current = start;
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        current = current.parent()?;
    }
}

/// Parse `git status --porcelain --ignored` output into a path → status map
/// and a list of ignored paths. Porcelain format: XY PATH
fn parse_porcelain(output: &str) -> (HashMap<String, String>, Vec<String>) {
    let mut map = HashMap::new();
    let mut ignored = Vec::new();
    for line in output.lines() {
        if line.len() < 4 {
            continue;
        }
        let index_status = line.as_bytes()[0];
        let work_status = line.as_bytes()[1];
        // Skip the space at position 2; path starts at position 3
        let path = &line[3..];

        // Ignored files: !! prefix
        if index_status == b'!' && work_status == b'!' {
            ignored.push(path.to_string());
            continue;
        }

        // For renamed files, porcelain shows "old -> new" — take the new path
        let path = if let Some(arrow) = path.find(" -> ") {
            &path[arrow + 4..]
        } else {
            path
        };

        let status = match (index_status, work_status) {
            (b'?', b'?') => "U",         // Untracked
            (b'A', _) => "A",             // Added (staged)
            (b'D', _) | (_, b'D') => "D", // Deleted
            (_, b'M') | (b'M', _) => "M", // Modified
            (b'R', _) => "M",             // Renamed (show as modified)
            _ => continue,
        };

        map.insert(path.to_string(), status.to_string());
    }
    (map, ignored)
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    tokio::task::spawn_blocking(move || git_status_inner(&path))
        .await
        .map_err(|e| format!("Git status task failed: {}", e))?
}

fn git_status_inner(path: &str) -> Result<GitStatus, String> {
    let dir = Path::new(path);
    let git_root = find_git_root(dir).ok_or_else(|| "Not a git repository".to_string())?;
    let root_str = git_root.to_string_lossy().to_string();

    // Check cache: return cached result if still fresh
    if let Ok(cache) = GIT_CACHE.lock() {
        if let Some(ref cached) = *cache {
            if cached.root == root_str
                && cached.timestamp.elapsed().as_millis() < GIT_CACHE_TTL_MS
            {
                return Ok(cached.result.clone());
            }
        }
    }

    let output = Command::new("git")
        .args(["status", "--porcelain", "--ignored"])
        .current_dir(git_root)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let (files, ignored) = parse_porcelain(&stdout);

    let result = GitStatus {
        files,
        ignored,
        root: root_str.clone(),
    };

    // Update cache
    if let Ok(mut cache) = GIT_CACHE.lock() {
        *cache = Some(GitCache {
            root: root_str,
            result: result.clone(),
            timestamp: Instant::now(),
        });
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_porcelain_empty() {
        let (files, ignored) = parse_porcelain("");
        assert!(files.is_empty());
        assert!(ignored.is_empty());
    }

    #[test]
    fn test_parse_porcelain_modified() {
        let (files, _) = parse_porcelain(" M src/main.rs\n");
        assert_eq!(files.get("src/main.rs").map(|s| s.as_str()), Some("M"));
    }

    #[test]
    fn test_parse_porcelain_staged_modified() {
        let (files, _) = parse_porcelain("M  src/lib.rs\n");
        assert_eq!(files.get("src/lib.rs").map(|s| s.as_str()), Some("M"));
    }

    #[test]
    fn test_parse_porcelain_added() {
        let (files, _) = parse_porcelain("A  new_file.txt\n");
        assert_eq!(files.get("new_file.txt").map(|s| s.as_str()), Some("A"));
    }

    #[test]
    fn test_parse_porcelain_deleted() {
        let (files, _) = parse_porcelain(" D removed.txt\n");
        assert_eq!(files.get("removed.txt").map(|s| s.as_str()), Some("D"));
    }

    #[test]
    fn test_parse_porcelain_untracked() {
        let (files, _) = parse_porcelain("?? untracked.txt\n");
        assert_eq!(files.get("untracked.txt").map(|s| s.as_str()), Some("U"));
    }

    #[test]
    fn test_parse_porcelain_renamed() {
        let (files, _) = parse_porcelain("R  old.txt -> new.txt\n");
        assert_eq!(files.get("new.txt").map(|s| s.as_str()), Some("M"));
        assert!(files.get("old.txt").is_none());
    }

    #[test]
    fn test_parse_porcelain_multiple() {
        let output = " M file1.rs\nA  file2.rs\n?? file3.rs\n D file4.rs\n";
        let (files, _) = parse_porcelain(output);
        assert_eq!(files.len(), 4);
        assert_eq!(files["file1.rs"], "M");
        assert_eq!(files["file2.rs"], "A");
        assert_eq!(files["file3.rs"], "U");
        assert_eq!(files["file4.rs"], "D");
    }

    #[test]
    fn test_parse_porcelain_short_line_ignored() {
        let (files, _) = parse_porcelain("ab\n");
        assert!(files.is_empty());
    }

    #[test]
    fn test_parse_porcelain_ignored() {
        let output = "!! dist/\n!! CLAUDE.md\n M src/main.rs\n";
        let (files, ignored) = parse_porcelain(output);
        assert_eq!(files.len(), 1);
        assert_eq!(ignored.len(), 2);
        assert_eq!(ignored[0], "dist/");
        assert_eq!(ignored[1], "CLAUDE.md");
    }
}
