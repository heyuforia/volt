use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoltConfig {
    #[serde(default = "default_window")]
    pub window: WindowConfig,
    #[serde(default = "default_terminal")]
    pub terminal: TerminalConfig,
    #[serde(default = "default_editor")]
    pub editor: EditorConfig,
    #[serde(default = "default_ignored")]
    pub ignored_patterns: Vec<String>,
    #[serde(default)]
    pub last_folder: Option<String>,
    #[serde(default)]
    pub recent_folders: Vec<String>,
    #[serde(default)]
    pub lsp_servers: HashMap<String, LspServerOverride>,
    #[serde(default)]
    pub folder_states: HashMap<String, FolderState>,
    #[serde(default)]
    pub diagnostics_panel_height: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderState {
    #[serde(default)]
    pub tabs: Vec<SavedTab>,
    #[serde(default)]
    pub active_index: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub enum SavedTab {
    #[serde(rename = "terminal")]
    Terminal,
    #[serde(rename = "file")]
    File {
        path: String,
        #[serde(default = "default_one")]
        cursor_line: u32,
    },
}

fn default_one() -> u32 { 1 }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LspServerOverride {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowConfig {
    #[serde(default = "default_width")]
    pub width: u32,
    #[serde(default = "default_height")]
    pub height: u32,
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u32,
    #[serde(default = "default_true")]
    pub sidebar_visible: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConfig {
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_scrollback")]
    pub scrollback: u32,
    #[serde(default)]
    pub shell: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfig {
    #[serde(default = "default_true")]
    pub auto_save: bool,
    #[serde(default = "default_auto_save_delay")]
    pub auto_save_delay: u32,
}

fn default_auto_save_delay() -> u32 { 1500 }

fn default_width() -> u32 { 1400 }
fn default_height() -> u32 { 900 }
fn default_sidebar_width() -> u32 { 250 }
fn default_true() -> bool { true }
fn default_font_size() -> u32 { 14 }
fn default_scrollback() -> u32 { 5000 }

fn default_window() -> WindowConfig {
    WindowConfig {
        width: 1400, height: 900, x: None, y: None,
        sidebar_width: 250, sidebar_visible: true,
    }
}

fn default_terminal() -> TerminalConfig {
    TerminalConfig {
        font_size: 14, scrollback: 5000, shell: String::new(),
    }
}

fn default_editor() -> EditorConfig {
    EditorConfig { auto_save: true, auto_save_delay: 1500 }
}

fn default_ignored() -> Vec<String> {
    vec![
        ".git".into(), "build".into(), ".dart_tool".into(),
        "node_modules".into(), ".gradle".into(), "target".into(),
    ]
}

impl Default for VoltConfig {
    fn default() -> Self {
        Self {
            window: default_window(),
            terminal: default_terminal(),
            editor: default_editor(),
            ignored_patterns: default_ignored(),
            last_folder: None,
            recent_folders: Vec::new(),
            lsp_servers: HashMap::new(),
            folder_states: HashMap::new(),
            diagnostics_panel_height: None,
        }
    }
}

fn config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".volt")
}

fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

fn ensure_config_dir() -> Result<(), String> {
    let dir = config_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn load_config() -> Result<VoltConfig, String> {
    let path = config_path();
    if !path.exists() {
        let config = VoltConfig::default();
        save_config(config.clone())?;
        return Ok(config);
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let config: VoltConfig = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(_) => {
            // Back up corrupt config so the user can recover it
            let backup = path.with_extension("json.bak");
            let _ = fs::copy(&path, &backup);
            eprintln!("Warning: config.json was corrupt, backed up to config.json.bak");
            VoltConfig::default()
        }
    };

    Ok(config)
}

const MAX_FOLDER_STATES: usize = 50;

#[tauri::command]
pub fn save_config(mut config: VoltConfig) -> Result<(), String> {
    ensure_config_dir()?;

    // Prune folder_states to prevent unbounded growth
    if config.folder_states.len() > MAX_FOLDER_STATES {
        let recent: std::collections::HashSet<&String> =
            config.recent_folders.iter().collect();
        let to_remove: Vec<String> = config.folder_states.keys()
            .filter(|path| !recent.contains(path))
            .cloned()
            .collect();
        for path in to_remove {
            config.folder_states.remove(&path);
            if config.folder_states.len() <= MAX_FOLDER_STATES {
                break;
            }
        }
    }

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(config_path(), content)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}
