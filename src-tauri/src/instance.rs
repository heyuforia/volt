use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{fs, thread};
use tauri::Manager;

// ── State ──

static INSTANCE_STATE: std::sync::LazyLock<Mutex<InstanceState>> =
    std::sync::LazyLock::new(|| Mutex::new(InstanceState { lock_path: None, shutdown: None }));

struct InstanceState {
    lock_path: Option<PathBuf>,
    shutdown: Option<Arc<AtomicBool>>,
}

// ── Paths ──

fn locks_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".volt")
        .join("locks")
}

fn folder_hash(folder: &str) -> String {
    let normalized = folder.replace('\\', "/").to_lowercase();
    let mut hasher = DefaultHasher::new();
    normalized.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn lock_path_for(folder: &str) -> PathBuf {
    locks_dir().join(format!("{}.lock", folder_hash(folder)))
}

// ── Core Logic ──

/// Try to focus an existing Volt instance that has this folder open.
/// Reads the lock file for the TCP port, connects, sends "volt-focus".
/// Returns true if an existing instance was found and focused.
pub fn try_focus_existing(folder: &str) -> bool {
    let lock = lock_path_for(folder);
    if !lock.exists() {
        return false;
    }

    let port_str = match fs::read_to_string(&lock) {
        Ok(s) => s,
        Err(_) => {
            let _ = fs::remove_file(&lock);
            return false;
        }
    };

    let port: u16 = match port_str.trim().parse() {
        Ok(p) => p,
        Err(_) => {
            let _ = fs::remove_file(&lock);
            return false;
        }
    };

    let addr: SocketAddr = match format!("127.0.0.1:{}", port).parse() {
        Ok(a) => a,
        Err(_) => {
            let _ = fs::remove_file(&lock);
            return false;
        }
    };

    // Try to connect — if the process is dead, this fails (stale lock)
    if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        let _ = stream.write_all(b"volt-focus");
        // Wait briefly for acknowledgment
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let mut ack = [0u8; 2];
        let _ = stream.read(&mut ack);
        return true;
    }

    // Connection failed — stale lock from a crashed instance, clean it up
    let _ = fs::remove_file(&lock);
    false
}

/// Create a lock file and start a TCP listener for focus requests.
/// The listener runs in a background thread until the lock is released.
fn create_lock(folder: &str, app: tauri::AppHandle) -> Result<(), String> {
    // Release any previous lock first (handles folder switching)
    release_lock_internal();

    // Bind to a random available port on localhost
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind focus listener: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get listener port: {}", e))?
        .port();

    // Non-blocking so the thread can check the shutdown flag between accepts
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set non-blocking: {}", e))?;

    // Create lock file with the port number
    let lock = lock_path_for(folder);
    if let Some(dir) = lock.parent() {
        if !dir.exists() {
            fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create locks dir: {}", e))?;
        }
    }
    fs::write(&lock, port.to_string())
        .map_err(|e| format!("Failed to write lock file: {}", e))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_clone = shutdown.clone();

    {
        let mut state = INSTANCE_STATE.lock().map_err(|e| format!("Lock error: {}", e))?;
        state.lock_path = Some(lock);
        state.shutdown = Some(shutdown);
    }

    // Background thread: listen for focus requests from other Volt instances.
    // Polls every 200ms and exits when the shutdown flag is set.
    thread::spawn(move || {
        loop {
            if shutdown_clone.load(Ordering::Relaxed) {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                    let mut buf = [0u8; 16];
                    if let Ok(n) = stream.read(&mut buf) {
                        if n >= 10 && &buf[..10] == b"volt-focus" {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                                let _ = w.request_user_attention(
                                    Some(tauri::UserAttentionType::Informational),
                                );
                            }
                            let _ = stream.write_all(b"ok");
                        }
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(200));
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

/// Remove the current lock file and signal the listener thread to exit.
fn release_lock_internal() {
    let Ok(mut state) = INSTANCE_STATE.lock() else { return };
    if let Some(ref lock_path) = state.lock_path {
        let _ = fs::remove_file(lock_path);
    }
    if let Some(ref shutdown) = state.shutdown {
        shutdown.store(true, Ordering::Relaxed);
    }
    state.lock_path = None;
    state.shutdown = None;
}

// ── Tauri Commands ──

/// Check if another Volt instance already has this folder open.
/// If so, sends a focus request to that instance and returns true.
#[tauri::command]
pub fn check_folder_instance(folder: String) -> bool {
    try_focus_existing(&folder)
}

/// Acquire a per-folder lock so other Volt instances know this folder is open.
#[tauri::command]
pub fn acquire_folder_lock(app: tauri::AppHandle, folder: String) -> Result<(), String> {
    create_lock(&folder, app)
}

/// Release the current folder lock (called on close or folder switch).
#[tauri::command]
pub fn release_folder_lock() {
    release_lock_internal()
}
