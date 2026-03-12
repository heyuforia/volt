use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub struct FileWatcherState {
    watcher: Option<RecommendedWatcher>,
    watched: HashSet<PathBuf>,
}

impl FileWatcherState {
    pub fn new(app_handle: AppHandle) -> Self {
        let watcher = RecommendedWatcher::new(
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
        )
        .ok();

        Self {
            watcher,
            watched: HashSet::new(),
        }
    }
}

/// Separate watcher for recursive directory monitoring (file tree updates).
/// Emits "directory-changed" on Create, Remove, and Rename events.
pub struct DirWatcherState {
    watcher: Option<RecommendedWatcher>,
    watched_root: Option<PathBuf>,
}

impl DirWatcherState {
    pub fn new(app_handle: AppHandle) -> Self {
        let watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    if matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))
                    ) {
                        for path in &event.paths {
                            let path_str = path.to_string_lossy().to_string();
                            let _ = app_handle.emit("directory-changed", &path_str);
                        }
                    }
                }
            },
            notify::Config::default(),
        )
        .ok();

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
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    if s.watched.contains(&p) {
        return Ok(());
    }
    if s.watched.len() >= MAX_WATCHES {
        return Err("Maximum file watch limit reached".to_string());
    }
    if let Some(watcher) = &mut s.watcher {
        watcher
            .watch(&p, RecursiveMode::NonRecursive)
            .map_err(|e| format!("Watch failed: {}", e))?;
        s.watched.insert(p);
    }
    Ok(())
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
    s.watched.remove(&p);
    Ok(())
}

#[tauri::command]
pub fn unwatch_all_files(
    state: tauri::State<'_, Mutex<FileWatcherState>>,
) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let paths: Vec<PathBuf> = s.watched.drain().collect();
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

    if let Some(watcher) = &mut s.watcher {
        watcher
            .watch(&p, RecursiveMode::Recursive)
            .map_err(|e| format!("Directory watch failed: {}", e))?;
        s.watched_root = Some(p);
    }
    Ok(())
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
