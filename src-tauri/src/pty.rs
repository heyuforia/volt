use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct PtyInstance {
    writer: PtyWriter,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
}

// Global PTY registry
static PTY_REGISTRY: std::sync::LazyLock<Mutex<HashMap<String, PtyInstance>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

static TERMINAL_COUNTER: std::sync::LazyLock<Mutex<u32>> =
    std::sync::LazyLock::new(|| Mutex::new(0));

fn next_terminal_id() -> Result<String, String> {
    let mut counter = TERMINAL_COUNTER.lock().map_err(|e| format!("Lock error: {}", e))?;
    *counter += 1;
    Ok(format!("terminal-{}", counter))
}

#[derive(Debug, Serialize, Clone)]
struct TerminalOutput {
    id: String,
    data: String,
}

#[derive(Debug, Serialize, Clone)]
struct TerminalExit {
    id: String,
    code: i32,
}

#[tauri::command]
pub fn spawn_terminal(
    app: AppHandle,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell_cmd = shell.unwrap_or_else(|| {
        #[cfg(target_os = "windows")]
        {
            let pwsh7 = std::path::Path::new("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
            if pwsh7.exists() {
                return pwsh7.to_string_lossy().to_string();
            }
            "powershell.exe".to_string()
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        }
    });

    let working_dir = cwd.unwrap_or_else(|| {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string())
    });

    let mut cmd = CommandBuilder::new(&shell_cmd);
    cmd.cwd(&working_dir);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Drop slave immediately — we only need the master side
    drop(pair.slave);

    let id = next_terminal_id()?;

    let writer: PtyWriter = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?,
    ));

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> =
        Arc::new(Mutex::new(Some(pair.master)));

    {
        let mut registry = PTY_REGISTRY.lock().map_err(|e| format!("Lock error: {}", e))?;
        registry.insert(
            id.clone(),
            PtyInstance {
                writer: writer.clone(),
                master: master.clone(),
            },
        );
    }

    // Reader thread: reads PTY output and emits events to frontend
    let read_id = id.clone();
    let read_app = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = read_app.emit(
                        "terminal-output",
                        TerminalOutput {
                            id: read_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // Waiter thread: waits for child process to exit
    let exit_id = id.clone();
    thread::spawn(move || {
        let mut child = child;
        let status = child.wait();
        let code = match status {
            Ok(exit) => {
                if exit.success() {
                    0
                } else {
                    1
                }
            }
            Err(_) => -1,
        };
        let _ = app.emit(
            "terminal-exit",
            TerminalExit {
                id: exit_id.clone(),
                code,
            },
        );
        // Clean up from registry
        if let Ok(mut registry) = PTY_REGISTRY.lock() {
            registry.remove(&exit_id);
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn write_terminal(id: String, data: String) -> Result<(), String> {
    let writer = {
        let registry = PTY_REGISTRY.lock().map_err(|e| format!("Lock error: {}", e))?;
        let instance = registry
            .get(&id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?;
        instance.writer.clone()
    }; // registry lock dropped here

    let mut writer = writer.lock().map_err(|e| format!("Lock error: {}", e))?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn resize_terminal(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let master = {
        let registry = PTY_REGISTRY.lock().map_err(|e| format!("Lock error: {}", e))?;
        let instance = registry
            .get(&id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?;
        instance.master.clone()
    }; // registry lock dropped here

    let master_lock = master.lock().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(ref m) = *master_lock {
        m.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn kill_terminal(id: String) -> Result<(), String> {
    let mut registry = PTY_REGISTRY.lock().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(instance) = registry.remove(&id) {
        // Drop master to close the PTY
        if let Ok(mut master_lock) = instance.master.lock() {
            *master_lock = None;
        }
    }
    Ok(())
}
