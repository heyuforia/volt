use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub struct FileWatcherState {
    watcher: Option<RecommendedWatcher>,
    watched: Vec<PathBuf>,
}

impl FileWatcherState {
    pub fn new(app_handle: AppHandle) -> Self {
        let watcher = match RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    if matches!(
                        event.kind,
                        EventKind::Modify(_) | EventKind::Create(_)
                    ) {
                        for path in &event.paths {
                            let path_str = path.to_string_lossy().to_string();
                            let _ = app_handle.emit("file-changed", &path_str);
                        }
                    }
                }
            },
            notify::Config::default(),
        ) {
            Ok(w) => Some(w),
            Err(e) => {
                eprintln!("Warning: failed to create file watcher: {}", e);
                None
            }
        };

        Self {
            watcher,
            watched: Vec::new(),
        }
    }
}

/// Separate watcher for recursive directory monitoring (file tree updates).
/// Emits "directory-changed" on Create, Remove, and Rename events.
pub struct DirWatcherState {
    watcher: Option<RecommendedWatcher>,
    watched_root: Option<PathBuf>,
}

/// Directories whose changes should NOT trigger a tree refresh.
const IGNORED_SEGMENTS: &[&str] = &[
    ".git",
    "node_modules",
    ".dart_tool",
    ".idea",
    ".vscode",
    "target",       // Rust build output
    "__pycache__",
    ".cache",
    "build",
];

fn is_noisy_path(path: &std::path::Path) -> bool {
    for component in path.components() {
        if let std::path::Component::Normal(s) = component {
            let s = s.to_string_lossy();
            if IGNORED_SEGMENTS.contains(&s.as_ref())
                || s.ends_with(".volt-swap")
                || s.ends_with(".volt-tmp")
            {
                return true;
            }
        }
    }
    false
}

impl DirWatcherState {
    pub fn new(app_handle: AppHandle) -> Self {
        let watcher = match RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    if matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))
                    ) {
                        for path in &event.paths {
                            if is_noisy_path(path) {
                                continue;
                            }
                            let path_str = path.to_string_lossy().to_string();
                            let _ = app_handle.emit("directory-changed", &path_str);
                        }
                    }
                }
            },
            notify::Config::default(),
        ) {
            Ok(w) => Some(w),
            Err(e) => {
                eprintln!("Warning: failed to create directory watcher: {}", e);
                None
            }
        };

        Self {
            watcher,
            watched_root: None,
        }
    }
}

const MAX_WATCHES: usize = 10_000;

#[tauri::command]
pub fn watch_file(
    path: String,
    state: tauri::State<'_, Mutex<FileWatcherState>>,
) -> Result<(), String> {
    crate::fs::validate_path(&path)?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    if s.watched.contains(&p) {
        return Ok(());
    }
    if s.watched.len() >= MAX_WATCHES {
        if let Some(oldest) = s.watched.first().cloned() {
            if let Some(watcher) = &mut s.watcher {
                let _ = watcher.unwatch(&oldest);
            }
            s.watched.remove(0);
        }
    }
    match &mut s.watcher {
        Some(watcher) => {
            watcher
                .watch(&p, RecursiveMode::NonRecursive)
                .map_err(|e| format!("Watch failed: {}", e))?;
            s.watched.push(p);
            Ok(())
        }
        None => Err("File watcher unavailable".to_string()),
    }
}

#[tauri::command]
pub fn unwatch_file(
    path: String,
    state: tauri::State<'_, Mutex<FileWatcherState>>,
) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    if let Some(watcher) = &mut s.watcher {
        let _ = watcher.unwatch(&p);
    }
    s.watched.retain(|x| x != &p);
    Ok(())
}

#[tauri::command]
pub fn unwatch_all_files(
    state: tauri::State<'_, Mutex<FileWatcherState>>,
) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let paths: Vec<PathBuf> = s.watched.drain(..).collect();
    if let Some(watcher) = &mut s.watcher {
        for p in &paths {
            let _ = watcher.unwatch(p);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn watch_directory(
    path: String,
    state: tauri::State<'_, Mutex<DirWatcherState>>,
) -> Result<(), String> {
    crate::fs::validate_path(&path)?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);

    // Unwatch previous root if different
    if let Some(old) = s.watched_root.take() {
        if old == p {
            s.watched_root = Some(old);
            return Ok(());
        }
        if let Some(watcher) = &mut s.watcher {
            let _ = watcher.unwatch(&old);
        }
    }

    match &mut s.watcher {
        Some(watcher) => {
            watcher
                .watch(&p, RecursiveMode::Recursive)
                .map_err(|e| format!("Directory watch failed: {}", e))?;
            s.watched_root = Some(p);
            Ok(())
        }
        None => Err("Directory watcher unavailable".to_string()),
    }
}

#[tauri::command]
pub fn unwatch_directory(
    state: tauri::State<'_, Mutex<DirWatcherState>>,
) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    if let Some(old) = s.watched_root.take() {
        if let Some(watcher) = &mut s.watcher {
            let _ = watcher.unwatch(&old);
        }
    }
    Ok(())
}
