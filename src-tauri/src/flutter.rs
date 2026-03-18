use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Emitter};

// ── Helpers ──

/// Build a Command that works with .bat files on Windows.
/// On Windows, runs via `cmd /C <program> <args>` so .bat resolution works.
/// On other platforms, runs the program directly.
#[cfg(target_os = "windows")]
fn bat_command(program: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("cmd");
    let mut all_args = vec!["/C", program];
    all_args.extend_from_slice(args);
    cmd.args(&all_args);
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(not(target_os = "windows"))]
fn bat_command(program: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd
}

// ── Project Type Detection ──

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectType {
    pub id: String,
    pub name: String,
    pub has_emulator: bool,
}

struct ProjectDef {
    id: &'static str,
    name: &'static str,
    marker_files: &'static [&'static str],
    has_emulator: bool,
}

const PROJECT_TYPES: &[ProjectDef] = &[
    ProjectDef { id: "flutter", name: "Flutter", marker_files: &["pubspec.yaml"], has_emulator: true },
    ProjectDef { id: "rust", name: "Rust", marker_files: &["Cargo.toml"], has_emulator: false },
    ProjectDef { id: "go", name: "Go", marker_files: &["go.mod"], has_emulator: false },
    ProjectDef { id: "python", name: "Python", marker_files: &["pyproject.toml", "requirements.txt", "setup.py"], has_emulator: false },
    ProjectDef { id: "c_cpp", name: "C/C++", marker_files: &["CMakeLists.txt", "compile_commands.json"], has_emulator: false },
    ProjectDef { id: "node", name: "Node.js", marker_files: &["package.json"], has_emulator: false },
];

#[tauri::command]
pub fn detect_project_type(path: String) -> Option<ProjectType> {
    let root = Path::new(&path);
    for def in PROJECT_TYPES {
        for marker in def.marker_files {
            if root.join(marker).exists() {
                return Some(ProjectType {
                    id: def.id.to_string(),
                    name: def.name.to_string(),
                    has_emulator: def.has_emulator,
                });
            }
        }
    }
    None
}

// ── Emulator Management ──

#[derive(Debug, Serialize, Clone)]
pub struct Emulator {
    pub id: String,
    pub name: String,
    pub platform: String,
}

#[tauri::command]
pub fn list_emulators() -> Result<Vec<Emulator>, String> {
    let output = bat_command("flutter", &["emulators"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run 'flutter emulators': {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut emulators = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || !line.contains('•') {
            continue;
        }

        let parts: Vec<&str> = line.split('•').map(|s| s.trim()).collect();
        if parts.len() >= 3 {
            emulators.push(Emulator {
                id: parts[0].to_string(),
                name: parts[1].to_string(),
                platform: parts.last().unwrap_or(&"unknown").to_string(),
            });
        }
    }

    Ok(emulators)
}

fn is_safe_emulator_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[tauri::command]
pub fn launch_emulator(app: AppHandle, id: String, cold: Option<bool>) -> Result<(), String> {
    if !is_safe_emulator_id(&id) {
        return Err("Invalid emulator ID".to_string());
    }

    // Always use the emulator binary directly instead of `flutter emulators --launch`.
    // The Flutter CLI wrapper is a short-lived process that spawns the real emulator
    // separately — we can't monitor its lifecycle, and it handles first-boot (no
    // snapshot) inconsistently, often producing a black screen. Using the emulator
    // binary directly matches what VSCode's Flutter extension does via the daemon.
    let android_home = std::env::var("ANDROID_HOME")
        .or_else(|_| std::env::var("ANDROID_SDK_ROOT"))
        .unwrap_or_default();

    let emulator_path = if !android_home.is_empty() {
        let p = Path::new(&android_home).join("emulator").join("emulator");
        if p.exists() { p.to_string_lossy().to_string() } else { "emulator".to_string() }
    } else {
        "emulator".to_string()
    };

    let mut cmd = Command::new(&emulator_path);
    cmd.args(["-avd", &id]);
    if cold.unwrap_or(false) {
        cmd.arg("-no-snapshot-load");
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch emulator: {}", e))?;

    // The child process IS the emulator, so we can monitor it for both
    // normal and cold boot and reset the status bar when it exits.
    thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
        let _ = app.emit("emulator-exited", ());
    });

    Ok(())
}
