use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

/// Find the largest prefix of `bytes` that ends on a complete UTF-8 boundary.
/// Returns `bytes.len()` when the final byte completes (or is ASCII).
/// Otherwise returns the index of the first byte of the trailing incomplete
/// multi-byte sequence so the caller can carry it to the next read.
fn utf8_safe_split(bytes: &[u8]) -> usize {
    let len = bytes.len();
    if len == 0 {
        return 0;
    }
    // Scan backwards (at most 3 bytes) to find the last leading byte
    let start = len.saturating_sub(3);
    let mut i = len;
    while i > start {
        i -= 1;
        let b = bytes[i];
        if b & 0x80 == 0 {
            // ASCII — everything up to and including this byte is complete
            return len;
        }
        if b & 0xC0 != 0x80 {
            // Leading byte: determine expected sequence length
            let expected = if b & 0xE0 == 0xC0 {
                2
            } else if b & 0xF0 == 0xE0 {
                3
            } else if b & 0xF8 == 0xF0 {
                4
            } else {
                1 // invalid leading byte — pass through for lossy conversion
            };
            return if len - i >= expected { len } else { i };
        }
        // Continuation byte (10xxxxxx) — keep scanning backwards
    }
    // All checked bytes are continuation bytes (orphaned) — pass through
    len
}

type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct PtyInstance {
    writer: PtyWriter,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
}

// Global PTY registry
static PTY_REGISTRY: std::sync::LazyLock<Mutex<HashMap<String, PtyInstance>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

const MAX_TERMINALS: usize = 20;

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
    {
        let registry = PTY_REGISTRY.lock().map_err(|e| format!("Lock error: {}", e))?;
        if registry.len() >= MAX_TERMINALS {
            return Err(format!("Maximum terminal limit ({}) reached", MAX_TERMINALS));
        }
    }
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

    // portable-pty's CommandBuilder starts with an empty environment, so we
    // must forward the parent process env explicitly. Without this, macOS
    // GUI-launched Volt spawns shells with no PATH/HOME, and — critically —
    // no TERM, which puts zsh's line editor into dumb mode and breaks
    // Backspace/Enter/arrow keys.
    for (key, val) in std::env::vars() {
        cmd.env(key, val);
    }
    // Force a sane TERM even if the parent didn't have one set.
    cmd.env("TERM", "xterm-256color");

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
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if carry.is_empty() {
                        // Fast path: no leftover bytes from previous read
                        let split = utf8_safe_split(&buf[..n]);
                        let data = String::from_utf8_lossy(&buf[..split]).to_string();
                        if !data.is_empty() {
                            let _ = read_app.emit(
                                "terminal-output",
                                TerminalOutput {
                                    id: read_id.clone(),
                                    data,
                                },
                            );
                        }
                        if split < n {
                            carry.extend_from_slice(&buf[split..n]);
                        }
                    } else {
                        // Slow path: combine carry + new bytes
                        carry.extend_from_slice(&buf[..n]);
                        let split = utf8_safe_split(&carry);
                        if split > 0 {
                            let data = String::from_utf8_lossy(&carry[..split]).to_string();
                            let _ = read_app.emit(
                                "terminal-output",
                                TerminalOutput {
                                    id: read_id.clone(),
                                    data,
                                },
                            );
                        }
                        if split < carry.len() {
                            let remaining = carry[split..].to_vec();
                            carry = remaining;
                        } else {
                            carry.clear();
                        }
                    }
                }
                Err(_) => break,
            }
        }
        // Flush any remaining carry bytes on EOF/error
        if !carry.is_empty() {
            let data = String::from_utf8_lossy(&carry).to_string();
            let _ = read_app.emit(
                "terminal-output",
                TerminalOutput {
                    id: read_id.clone(),
                    data,
                },
            );
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
    if cols == 0 || rows == 0 {
        return Ok(());
    }
    let clamped_cols = cols.min(500);
    let clamped_rows = rows.min(200);
    if clamped_cols != cols || clamped_rows != rows {
        eprintln!("Warning: terminal resize clamped from {}x{} to {}x{}", cols, rows, clamped_cols, clamped_rows);
    }
    let cols = clamped_cols;
    let rows = clamped_rows;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_utf8_safe_split_ascii() {
        assert_eq!(utf8_safe_split(b"hello"), 5);
    }

    #[test]
    fn test_utf8_safe_split_empty() {
        assert_eq!(utf8_safe_split(b""), 0);
    }

    #[test]
    fn test_utf8_safe_split_complete_2byte() {
        // "ñ" = 0xC3 0xB1
        assert_eq!(utf8_safe_split(&[0xC3, 0xB1]), 2);
    }

    #[test]
    fn test_utf8_safe_split_incomplete_2byte() {
        // 'A' + leading byte of 2-byte sequence, missing continuation
        assert_eq!(utf8_safe_split(&[0x41, 0xC3]), 1);
    }

    #[test]
    fn test_utf8_safe_split_complete_3byte() {
        // "中" = 0xE4 0xB8 0xAD
        assert_eq!(utf8_safe_split(&[0xE4, 0xB8, 0xAD]), 3);
    }

    #[test]
    fn test_utf8_safe_split_incomplete_3byte_2of3() {
        // 'A' + first 2 bytes of "中"
        assert_eq!(utf8_safe_split(&[0x41, 0xE4, 0xB8]), 1);
    }

    #[test]
    fn test_utf8_safe_split_incomplete_3byte_1of3() {
        // 'A' + just the leading byte of a 3-byte sequence
        assert_eq!(utf8_safe_split(&[0x41, 0xE4]), 1);
    }

    #[test]
    fn test_utf8_safe_split_complete_4byte() {
        // "😀" = 0xF0 0x9F 0x98 0x80
        assert_eq!(utf8_safe_split(&[0xF0, 0x9F, 0x98, 0x80]), 4);
    }

    #[test]
    fn test_utf8_safe_split_incomplete_4byte() {
        // 'A' + first 2 bytes of a 4-byte emoji
        assert_eq!(utf8_safe_split(&[0x41, 0xF0, 0x9F]), 1);
    }

    #[test]
    fn test_utf8_safe_split_ascii_then_incomplete() {
        // "hello" + incomplete 3-byte
        assert_eq!(utf8_safe_split(&[b'h', b'e', b'l', b'l', b'o', 0xE4, 0xB8]), 5);
    }

    #[test]
    fn test_utf8_safe_split_mixed_complete() {
        // "A中B" = 0x41, 0xE4, 0xB8, 0xAD, 0x42
        assert_eq!(utf8_safe_split(&[0x41, 0xE4, 0xB8, 0xAD, 0x42]), 5);
    }

    #[test]
    fn test_utf8_safe_split_orphan_continuation() {
        // Orphan continuation bytes are passed through for lossy handling
        assert_eq!(utf8_safe_split(&[0x80, 0x80]), 2);
    }
}
