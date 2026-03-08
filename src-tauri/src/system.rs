use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use sysinfo::{Pid, System};

#[derive(Debug, Serialize)]
pub struct SystemStats {
    pub ram_mb: f64,
    pub cpu_percent: f32,
}

static SYS: std::sync::LazyLock<Mutex<System>> =
    std::sync::LazyLock::new(|| Mutex::new(System::new()));

static INITIALIZED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn get_system_stats() -> Result<SystemStats, String> {
    let pid = Pid::from_u32(std::process::id());
    let mut sys = SYS.lock().map_err(|e| format!("Lock error: {}", e))?;

    // First call: baseline refresh so next call can compute CPU delta.
    // CPU will read 0% on first call — acceptable, next poll (5s later) will be accurate.
    if !INITIALIZED.load(Ordering::Relaxed) {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        INITIALIZED.store(true, Ordering::Relaxed);
    }

    sys.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
    );

    if let Some(process) = sys.process(pid) {
        Ok(SystemStats {
            ram_mb: process.memory() as f64 / 1_048_576.0,
            cpu_percent: process.cpu_usage(),
        })
    } else {
        Ok(SystemStats {
            ram_mb: 0.0,
            cpu_percent: 0.0,
        })
    }
}
