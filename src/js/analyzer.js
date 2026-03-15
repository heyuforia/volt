import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentFolder } from './app.js';

let analyzerRunning = false;
let diagnosticsMap = {}; // uri -> diagnostics[]
let panelVisible = false;
let lastCrashTime = 0;
let cachedDiagnostics = null; // cached sorted array, invalidated on update
let onHeightChange = null;
let onRestarted = null;
let onDiagnosticClick = null;

const statusLint = document.getElementById('status-lint');

// ── Diagnostics panel (created dynamically) ──
let panelEl = null;

function createPanel(initialHeight) {
  panelEl = document.createElement('div');
  panelEl.id = 'diagnostics-panel';
  panelEl.className = 'diagnostics-panel hidden';
  if (initialHeight) panelEl.style.height = `${initialHeight}px`;
  panelEl.innerHTML = `
    <div class="diag-resizer"></div>
    <div class="diag-header">
      <span class="diag-title">PROBLEMS</span>
      <div class="diag-actions">
        <button class="diag-btn" id="btn-restart-analyzer" title="Restart analyzer">↻</button>
        <button class="diag-btn" id="btn-close-diag" title="Close">×</button>
      </div>
    </div>
    <div class="diag-list" id="diag-list"></div>
  `;
  document.getElementById('main-area').appendChild(panelEl);

  document.getElementById('btn-close-diag').addEventListener('click', togglePanel);
  document.getElementById('btn-restart-analyzer').addEventListener('click', async () => {
    const folder = getCurrentFolder();
    if (folder) {
      await restartAnalyzer(folder);
    }
  });

  // Resize drag
  const resizer = panelEl.querySelector('.diag-resizer');
  let startY = 0;
  let startHeight = 0;
  let saveTimer = null;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startHeight = panelEl.offsetHeight;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e) => {
      const delta = startY - e.clientY; // up = bigger
      const maxH = window.innerHeight * 0.6;
      const newHeight = Math.max(80, Math.min(maxH, startHeight + delta));
      panelEl.style.height = `${newHeight}px`;
    };

    const onMouseUp = () => {
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Debounced save
      if (onHeightChange) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          onHeightChange(panelEl.offsetHeight);
        }, 300);
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ── Public API ──

export function initAnalyzer(initialHeight, heightChangeCallback, restartedCallback, diagnosticClickCallback) {
  onHeightChange = heightChangeCallback || null;
  onRestarted = restartedCallback || null;
  onDiagnosticClick = diagnosticClickCallback || null;
  createPanel(initialHeight);
  buildStatusLint();
  statusLint.classList.add('hidden');

  // Clicking the counts toggles the problems panel
  statusLint.addEventListener('click', (e) => {
    if (e.target.closest('.lint-restart')) return; // handled separately
    if (analyzerRunning || getAllDiagnostics().length > 0) {
      togglePanel();
    }
  });

  // Listen for analyzer crash — auto-restart once
  listen('analyzer-stopped', async () => {
    if (!analyzerRunning) return; // intentional stop, ignore

    analyzerRunning = false;
    const now = Date.now();
    const folder = getCurrentFolder();

    if (folder && (now - lastCrashTime) > 30000) {
      lastCrashTime = now;
      try {
        await startAnalyzer(folder);
        if (onRestarted) onRestarted();
      } catch (e) { console.warn('Failed to restart analyzer:', e); }
    } else {
      updateStatusBar();
    }
  });

  // Listen for diagnostics from Rust
  listen('analyzer-diagnostics', (event) => {
    const { uri, diagnostics } = event.payload;
    if (diagnostics.length === 0) {
      delete diagnosticsMap[uri];
    } else {
      diagnosticsMap[uri] = diagnostics;
    }
    cachedDiagnostics = null; // invalidate cache
    updateStatusBar();
    if (panelVisible) renderPanel();
  });
}

export async function startAnalyzer(projectPath) {
  try {
    const language = await invoke('start_analyzer', { projectPath });
    if (language) {
      // LSP started for detected language
      analyzerRunning = true;
      diagnosticsMap = {};
      cachedDiagnostics = null;
      statusLint.classList.remove('hidden');
      updateStatusBar();
    }
    // else: no supported language detected — lint stays hidden
  } catch (err) {
    // Language detected but server binary not found, or spawn failed
    analyzerRunning = false;
    statusLint.classList.remove('hidden');
    updateStatusBar();
    statusLint.title = String(err);
  }
}

async function restartAnalyzer(folder) {
  // Set analyzerRunning to false FIRST so the 'analyzer-stopped' event
  // from the old process dying is ignored (treated as intentional stop)
  analyzerRunning = false;
  try {
    await invoke('stop_analyzer');
  } catch (e) { console.warn('Failed to stop analyzer:', e); }
  diagnosticsMap = {};
  cachedDiagnostics = null;
  await startAnalyzer(folder);
}

export async function stopAnalyzer() {
  try {
    await invoke('stop_analyzer');
  } catch (e) { console.warn('Failed to stop analyzer:', e); }
  analyzerRunning = false;
  diagnosticsMap = {};
  cachedDiagnostics = null;
  statusLint.classList.add('hidden');
  if (panelVisible) togglePanel();
}

// ── Internals ──

function getAllDiagnostics() {
  if (cachedDiagnostics) return cachedDiagnostics;
  const all = [];
  for (const uri in diagnosticsMap) {
    for (const d of diagnosticsMap[uri]) {
      all.push({ ...d, _uri: uri });
    }
  }
  // Sort: errors first, then warnings, then info
  const order = { error: 0, warning: 1, info: 2 };
  all.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  cachedDiagnostics = all;
  return all;
}

function buildStatusLint() {
  statusLint.innerHTML = `
    <span class="lint-errors" title="Errors"><span class="lint-icon" style="color:#f44747">✗</span> <span class="lint-count" id="lint-error-count">0</span></span>
    <span class="lint-warnings" title="Warnings"><span class="lint-icon" style="color:#e5a235">⚠</span> <span class="lint-count" id="lint-warn-count">0</span></span>
    <span class="lint-info" title="Info"><span class="lint-icon" style="color:#569cd6">ℹ</span> <span class="lint-count" id="lint-info-count">0</span></span>
    <button class="lint-restart" title="Restart analyzer">↻</button>
  `;

  statusLint.querySelector('.lint-restart').addEventListener('click', async (e) => {
    e.stopPropagation();
    const folder = getCurrentFolder();
    if (folder) {
      await restartAnalyzer(folder);
    }
  });
}

function updateStatusBar() {
  const errorEl = document.getElementById('lint-error-count');
  const warnEl = document.getElementById('lint-warn-count');
  const infoEl = document.getElementById('lint-info-count');
  if (!errorEl) return;

  if (!analyzerRunning) {
    errorEl.textContent = '—';
    warnEl.textContent = '—';
    infoEl.textContent = '—';
    statusLint.title = 'No analysis active';
    return;
  }

  const all = getAllDiagnostics();
  let errors = 0, warnings = 0, infos = 0;
  for (const d of all) {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
    else infos++;
  }

  errorEl.textContent = errors;
  warnEl.textContent = warnings;
  infoEl.textContent = infos;
  statusLint.title = `${errors} errors, ${warnings} warnings, ${infos} info`;
}

function togglePanel() {
  panelVisible = !panelVisible;
  panelEl.classList.toggle('hidden', !panelVisible);
  if (panelVisible) renderPanel();
}

function renderPanel() {
  const list = document.getElementById('diag-list');
  const all = getAllDiagnostics();
  let errors = 0, warnings = 0;
  for (const d of all) {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
  }

  const title = panelEl.querySelector('.diag-title');
  title.textContent = `PROBLEMS (${errors} error${errors !== 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''})`;

  if (all.length === 0) {
    list.innerHTML = '<div class="diag-empty">No problems detected</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const d of all) {
    const icon = d.severity === 'error' ? '\u2717' : d.severity === 'warning' ? '\u26A0' : '\u2139';
    const color = d.severity === 'error' ? '#f44747' : d.severity === 'warning' ? '#e5a235' : '#7a7a8a';

    const item = document.createElement('div');
    item.className = 'diag-item';

    const iconEl = document.createElement('span');
    iconEl.className = 'diag-icon';
    iconEl.style.color = color;
    iconEl.textContent = icon;

    const fileEl = document.createElement('span');
    fileEl.className = 'diag-file';
    fileEl.textContent = `${d.file}:${d.line}:${d.column}`;

    const msgEl = document.createElement('span');
    msgEl.className = 'diag-message';
    msgEl.textContent = d.message;

    item.appendChild(iconEl);
    item.appendChild(fileEl);
    item.appendChild(msgEl);

    // Click to open file at the diagnostic location
    item.addEventListener('click', () => {
      if (onDiagnosticClick) onDiagnosticClick(d.file, d.line);
    });

    fragment.appendChild(item);
  }
  list.innerHTML = '';
  list.appendChild(fragment);
}
