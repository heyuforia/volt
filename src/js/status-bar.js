import { invoke } from '@tauri-apps/api/core';

const statusResources = document.getElementById('status-resources');
let statsInterval = null;

export function initStatusBar() {
  updateStats();
  statsInterval = setInterval(updateStats, 5000);

  // Pause polling when window is hidden (minimized, other tab, etc.)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    } else {
      if (!statsInterval) {
        updateStats();
        statsInterval = setInterval(updateStats, 5000);
      }
    }
  });
}

async function updateStats() {
  try {
    const stats = await invoke('get_system_stats');
    const ram = Math.round(stats.ram_mb);
    const cpu = Math.round(stats.cpu_percent);
    statusResources.textContent = `RAM: ${ram} MB | CPU: ${cpu}%`;
  } catch (e) {
    console.warn('Failed to fetch system stats:', e);
    statusResources.textContent = 'RAM: \u2014 | CPU: \u2014';
  }
}
