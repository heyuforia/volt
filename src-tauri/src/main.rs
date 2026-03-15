#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

mod config;
mod flutter;
mod fs;
mod git;
mod instance;
mod lsp;
mod pty;
mod system;
mod watcher;

fn main() {
    // Per-folder single instance: if another Volt process already has our
    // last folder open, focus that window and exit before ours even appears.
    if let Ok(cfg) = config::load_config() {
        if let Some(ref folder) = cfg.last_folder {
            if instance::try_focus_existing(folder) {
                std::process::exit(0);
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let file_watcher = watcher::FileWatcherState::new(app.handle().clone());
            app.manage(std::sync::Mutex::new(file_watcher));

            let dir_watcher = watcher::DirWatcherState::new(app.handle().clone());
            app.manage(std::sync::Mutex::new(dir_watcher));

            // Disable WebView2 browser accelerator keys (Ctrl+Tab, etc.)
            // so they reach our JavaScript keydown handlers instead.
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| unsafe {
                        use webview2_com::Microsoft::Web::WebView2::Win32::*;
                        use windows_core::Interface;
                        let result: Result<(), windows_core::Error> = (|| {
                            let settings: ICoreWebView2Settings3 = webview
                                .controller()
                                .CoreWebView2()?
                                .Settings()?
                                .cast()?;
                            let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
                            Ok(())
                        })();
                        if let Err(e) = result {
                            eprintln!("Warning: failed to configure WebView2 settings: {}", e);
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            config::check_config_health,
            fs::read_directory,
            fs::open_in_file_manager,
            fs::open_url,
            fs::read_file,
            fs::read_image_file,
            fs::save_file,
            fs::create_file,
            fs::create_directory,
            fs::rename_path,
            fs::delete_path,
            fs::list_all_files,
            fs::search_in_files,
            fs::write_swap_file,
            fs::check_swap_file,
            fs::delete_swap_file,
            git::git_status,
            flutter::detect_project_type,
            flutter::list_emulators,
            flutter::launch_emulator,
            instance::check_folder_instance,
            instance::acquire_folder_lock,
            instance::release_folder_lock,
            lsp::start_analyzer,
            lsp::stop_analyzer,
            lsp::lsp_did_open,
            lsp::lsp_did_change,
            lsp::lsp_did_save,
            lsp::lsp_did_close,
            pty::spawn_terminal,
            pty::write_terminal,
            pty::resize_terminal,
            pty::kill_terminal,
            system::get_system_stats,
            watcher::watch_file,
            watcher::unwatch_file,
            watcher::unwatch_all_files,
            watcher::watch_directory,
            watcher::unwatch_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Volt");
}
