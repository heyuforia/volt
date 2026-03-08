use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter};

// ── Built-in Language Server Configs ──
//
// Priority order: most specific marker files first, most generic last.
// First match wins (single LSP at a time per project).

struct BuiltinServer {
    id: &'static str,
    name: &'static str,
    marker_files: &'static [&'static str],
    command: &'static str,
    args: &'static [&'static str],
}

const BUILTIN_SERVERS: &[BuiltinServer] = &[
    BuiltinServer {
        id: "dart",
        name: "Dart",
        marker_files: &["pubspec.yaml"],
        command: "dart",
        args: &["language-server", "--protocol=lsp"],
    },
    BuiltinServer {
        id: "rust",
        name: "Rust",
        marker_files: &["Cargo.toml"],
        command: "rust-analyzer",
        args: &[],
    },
    BuiltinServer {
        id: "go",
        name: "Go",
        marker_files: &["go.mod"],
        command: "gopls",
        args: &[],
    },
    BuiltinServer {
        id: "c_cpp",
        name: "C/C++",
        marker_files: &["CMakeLists.txt", "compile_commands.json"],
        command: "clangd",
        args: &[],
    },
    BuiltinServer {
        id: "python",
        name: "Python",
        marker_files: &["pyproject.toml", "requirements.txt", "setup.py"],
        command: "pylsp",
        args: &[],
    },
    BuiltinServer {
        id: "typescript",
        name: "TypeScript",
        marker_files: &["tsconfig.json", "jsconfig.json", "package.json"],
        command: "typescript-language-server",
        args: &["--stdio"],
    },
];

// ── Language Detection ──

fn detect_language(project_path: &str) -> Option<&'static BuiltinServer> {
    let root = Path::new(project_path);
    for server in BUILTIN_SERVERS {
        for marker in server.marker_files {
            if root.join(marker).exists() {
                return Some(server);
            }
        }
    }
    None
}

// ── Binary Resolution ──

/// Search PATH for an executable by name.
fn find_on_path(name: &str) -> Option<String> {
    let path_var = std::env::var("PATH").unwrap_or_default();

    #[cfg(target_os = "windows")]
    let separator = ';';
    #[cfg(not(target_os = "windows"))]
    let separator = ':';

    for dir in path_var.split(separator) {
        let dir_path = Path::new(dir);

        #[cfg(target_os = "windows")]
        {
            for ext in &[".exe", ".cmd", ".bat"] {
                let candidate = dir_path.join(format!("{}{}", name, ext));
                if candidate.exists() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let candidate = dir_path.join(name);
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Dart needs special resolution because Flutter SDK bundles dart.bat
/// which wraps a cached dart.exe inside the SDK cache directory.
fn find_dart_executable() -> Option<String> {
    let path_var = std::env::var("PATH").unwrap_or_default();

    #[cfg(target_os = "windows")]
    let separator = ';';
    #[cfg(not(target_os = "windows"))]
    let separator = ':';

    for dir in path_var.split(separator) {
        let dir = Path::new(dir);

        #[cfg(target_os = "windows")]
        {
            let dart_exe = dir.join("dart.exe");
            if dart_exe.exists() {
                return Some(dart_exe.to_string_lossy().to_string());
            }

            let dart_bat = dir.join("dart.bat");
            if dart_bat.exists() {
                // Flutter SDK: the real dart.exe lives in cache/dart-sdk/bin/
                let cache_dart = dir.join("cache").join("dart-sdk").join("bin").join("dart.exe");
                if cache_dart.exists() {
                    return Some(cache_dart.to_string_lossy().to_string());
                }
                return Some(dart_bat.to_string_lossy().to_string());
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let dart = dir.join("dart");
            if dart.exists() {
                return Some(dart.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Resolve the binary path and args for a language server.
fn resolve_server_binary(server: &BuiltinServer) -> Option<(String, Vec<String>)> {
    // Check user config for overrides first
    if let Ok(config) = crate::config::load_config() {
        if let Some(user_override) = config.lsp_servers.get(server.id) {
            return Some((
                user_override.command.clone(),
                user_override.args.clone(),
            ));
        }
    }

    let args: Vec<String> = server.args.iter().map(|s| s.to_string()).collect();

    // Dart has special binary resolution (Flutter SDK cache)
    if server.id == "dart" {
        let binary = find_dart_executable()?;
        return Some((binary, args));
    }

    // Generic: search PATH
    let binary = find_on_path(server.command)?;
    Some((binary, args))
}

// ── LSP State ──

#[derive(Debug, Serialize, Clone)]
pub struct DiagnosticItem {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
struct AnalyzerDiagnostics {
    uri: String,
    diagnostics: Vec<DiagnosticItem>,
}

struct LspState {
    process: Option<Child>,
    writer: Option<Box<dyn Write + Send>>,
    request_id: u64,
}

static LSP: std::sync::LazyLock<Mutex<LspState>> =
    std::sync::LazyLock::new(|| Mutex::new(LspState {
        process: None,
        writer: None,
        request_id: 0,
    }));

fn next_request_id() -> Result<u64, String> {
    let mut state = LSP.lock().map_err(|e| format!("Lock error: {}", e))?;
    state.request_id += 1;
    Ok(state.request_id)
}

// ── LSP Protocol ──

fn send_lsp_message(writer: &mut dyn Write, msg: &serde_json::Value) -> Result<(), String> {
    let content = serde_json::to_string(msg)
        .map_err(|e| format!("Failed to serialize LSP message: {}", e))?;
    let header = format!("Content-Length: {}\r\n\r\n", content.len());
    writer.write_all(header.as_bytes())
        .map_err(|e| format!("Failed to write LSP header: {}", e))?;
    writer.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write LSP content: {}", e))?;
    writer.flush()
        .map_err(|e| format!("Failed to flush LSP: {}", e))?;
    Ok(())
}

fn uri_to_relative(uri: &str, root: &str) -> String {
    // On Windows: file:///C:/foo → C:\foo (strip 3 slashes)
    // On Unix:    file:///home/foo → /home/foo (strip 2 slashes to keep leading /)
    #[cfg(target_os = "windows")]
    let path = uri.strip_prefix("file:///").unwrap_or(uri);
    #[cfg(not(target_os = "windows"))]
    let path = uri.strip_prefix("file://").unwrap_or(uri);

    #[cfg(target_os = "windows")]
    let (path, root_normalized) = (
        path.replace('/', "\\"),
        root.replace('/', "\\"),
    );
    #[cfg(not(target_os = "windows"))]
    let (path, root_normalized) = (
        path.to_string(),
        root.to_string(),
    );

    path.strip_prefix(&root_normalized)
        .unwrap_or(&path)
        .trim_start_matches(std::path::MAIN_SEPARATOR)
        .to_string()
}

// ── Tauri Commands ──

/// Start the LSP server for the detected language in the given project.
/// Returns the language name on success, None if no supported language detected.
#[tauri::command]
pub fn start_analyzer(app: AppHandle, project_path: String) -> Result<Option<String>, String> {
    stop_analyzer_internal()?;

    let server = match detect_language(&project_path) {
        Some(s) => s,
        None => return Ok(None),
    };

    let (binary, args) = resolve_server_binary(server)
        .ok_or_else(|| {
            format!(
                "{} project detected, but '{}' not found on PATH",
                server.name, server.command
            )
        })?;

    let mut cmd = Command::new(&binary);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start {} language server: {}", server.name, e))?;

    let stdin = child.stdin.take()
        .ok_or("Failed to get LSP stdin")?;
    let stdout = child.stdout.take()
        .ok_or("Failed to get LSP stdout")?;

    {
        let mut state = LSP.lock().map_err(|e| format!("Lock error: {}", e))?;
        state.process = Some(child);
        state.writer = Some(Box::new(stdin));
        state.request_id = 0;
    }

    // Send LSP initialize request
    let init_id = next_request_id()?;
    let init_msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": std::process::id(),
            "rootUri": format!("file:///{}", project_path.replace('\\', "/").trim_start_matches('/')),
            "capabilities": {
                "textDocument": {
                    "publishDiagnostics": {
                        "relatedInformation": true
                    }
                }
            }
        }
    });

    {
        let mut state = LSP.lock().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(ref mut writer) = state.writer {
            send_lsp_message(writer.as_mut(), &init_msg)?;
        }
    }

    // Reader thread — reads LSP responses and emits events to frontend
    let read_app = app.clone();
    let root_path = project_path.clone();
    let expected_init_id = init_id;
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut initialized = false;

        loop {
            let mut header = String::new();
            let mut content_length: usize = 0;

            loop {
                header.clear();
                match reader.read_line(&mut header) {
                    Ok(0) => {
                        let _ = read_app.emit("analyzer-stopped", ());
                        return;
                    }
                    Ok(_) => {
                        let trimmed = header.trim();
                        if trimmed.is_empty() {
                            break;
                        }
                        if let Some(len_str) = trimmed.strip_prefix("Content-Length: ") {
                            content_length = len_str.parse().unwrap_or(0);
                        }
                    }
                    Err(_) => {
                        let _ = read_app.emit("analyzer-stopped", ());
                        return;
                    }
                }
            }

            if content_length == 0 {
                continue;
            }

            let mut body = vec![0u8; content_length];
            match std::io::Read::read_exact(&mut reader, &mut body) {
                Ok(_) => {}
                Err(_) => {
                    let _ = read_app.emit("analyzer-stopped", ());
                    return;
                }
            }

            let content = String::from_utf8_lossy(&body);
            let msg: serde_json::Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // Handle initialize response → send initialized notification
            if !initialized {
                if msg.get("id").and_then(|v| v.as_u64()) == Some(expected_init_id) && msg.get("result").is_some() {
                    initialized = true;
                    let notif = serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "initialized",
                        "params": {}
                    });
                    if let Ok(mut state) = LSP.lock() {
                        if let Some(ref mut writer) = state.writer {
                            let _ = send_lsp_message(writer.as_mut(), &notif);
                        }
                    }
                }
                continue;
            }

            // Handle textDocument/publishDiagnostics notification
            if msg.get("method").and_then(|m| m.as_str()) == Some("textDocument/publishDiagnostics") {
                if let Some(params) = msg.get("params") {
                    let uri = params["uri"].as_str().unwrap_or("").to_string();
                    let diags = params["diagnostics"].as_array();

                    let items: Vec<DiagnosticItem> = diags
                        .map(|arr| {
                            arr.iter().map(|d| {
                                let severity = match d["severity"].as_u64() {
                                    Some(1) => "error",
                                    Some(2) => "warning",
                                    _ => "info",
                                };
                                let range = &d["range"]["start"];
                                DiagnosticItem {
                                    file: uri_to_relative(&uri, &root_path),
                                    line: range["line"].as_u64().unwrap_or(0) as u32 + 1,
                                    column: range["character"].as_u64().unwrap_or(0) as u32 + 1,
                                    severity: severity.to_string(),
                                    message: d["message"].as_str().unwrap_or("").to_string(),
                                }
                            }).collect()
                        })
                        .unwrap_or_default();

                    let _ = read_app.emit("analyzer-diagnostics", AnalyzerDiagnostics {
                        uri,
                        diagnostics: items,
                    });
                }
            }
        }
    });

    Ok(Some(server.name.to_string()))
}

fn stop_analyzer_internal() -> Result<(), String> {
    let mut state = LSP.lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(ref mut writer) = state.writer {
        let shutdown = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 999999,
            "method": "shutdown",
            "params": null
        });
        let _ = send_lsp_message(writer.as_mut(), &shutdown);

        let exit = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "exit",
            "params": null
        });
        let _ = send_lsp_message(writer.as_mut(), &exit);
    }

    if let Some(ref mut process) = state.process {
        let _ = process.kill();
        let _ = process.wait();
    }

    state.process = None;
    state.writer = None;
    state.request_id = 0;

    Ok(())
}

#[tauri::command]
pub fn stop_analyzer() -> Result<(), String> {
    stop_analyzer_internal()
}
