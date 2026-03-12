import { invoke } from '@tauri-apps/api/core';
import { escapeAttr } from './utils.js';

let panelEl = null;
let visible = false;
let config = null;
let escapeHandler = null;

export function initSettings(getConfig, onConfigChanged) {
  config = getConfig();

  const statusRight = document.getElementById('status-right');
  const btn = document.createElement('button');
  btn.id = 'btn-settings';
  btn.className = 'status-settings-btn';
  btn.textContent = '\u2699';
  btn.title = 'Settings (Ctrl+,)';
  btn.addEventListener('click', () => toggleSettings(getConfig, onConfigChanged));
  statusRight.insertBefore(btn, statusRight.firstChild);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && e.key === ',') {
      e.preventDefault();
      toggleSettings(getConfig, onConfigChanged);
    }
  });
}

function toggleSettings(getConfig, onConfigChanged) {
  if (visible) closeSettings();
  else openSettings(getConfig, onConfigChanged);
}

function openSettings(getConfig, onConfigChanged) {
  config = getConfig();
  if (!config) return;
  visible = true;

  panelEl = document.createElement('div');
  panelEl.id = 'settings-overlay';
  panelEl.innerHTML = `
    <div class="settings-panel">
      <div class="settings-header">
        <div class="settings-tabs">
          <button class="settings-tab active" data-tab="ui">Settings</button>
          <button class="settings-tab" data-tab="json">Config JSON</button>
        </div>
        <button class="settings-close" id="btn-close-settings">\u00d7</button>
      </div>

      <div class="settings-tab-content" id="settings-tab-ui">
        <div class="settings-body">
          <div class="settings-section">Terminal</div>

          <div class="settings-row">
            <div class="settings-row-info">
              <span class="settings-row-label">Font Size</span>
              <span class="settings-row-desc">Terminal text size in pixels</span>
            </div>
            <input type="number" class="settings-input-sm" id="set-font-size" min="8" max="32"
              value="${config.terminal?.fontSize || 14}" />
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <span class="settings-row-label">Scrollback</span>
              <span class="settings-row-desc">Lines of history to keep</span>
            </div>
            <input type="number" class="settings-input-sm" id="set-scrollback" min="500" max="50000" step="500"
              value="${config.terminal?.scrollback || 5000}" />
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <span class="settings-row-label">Shell</span>
              <span class="settings-row-desc">Path to shell binary</span>
            </div>
            <input type="text" class="settings-input-wide" id="set-shell"
              placeholder="auto-detect"
              value="${escapeAttr(config.terminal?.shell || '')}" />
          </div>

          <div class="settings-section">Editor</div>

          <div class="settings-row">
            <div class="settings-row-info">
              <span class="settings-row-label">Auto Save</span>
              <span class="settings-row-desc">Automatically save files after editing</span>
            </div>
            <label class="settings-toggle">
              <input type="checkbox" id="set-auto-save" ${config.editor?.autoSave !== false ? 'checked' : ''} />
              <span class="settings-toggle-slider"></span>
            </label>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <span class="settings-row-label">Auto Save Delay</span>
              <span class="settings-row-desc">Milliseconds after last edit before saving</span>
            </div>
            <input type="number" class="settings-input-sm" id="set-auto-save-delay" min="500" max="10000" step="100"
              value="${config.editor?.autoSaveDelay || 1500}" />
          </div>

          <div class="settings-section">File Tree</div>

          <div class="settings-row">
            <div class="settings-row-info">
              <span class="settings-row-label">Hidden Patterns</span>
              <span class="settings-row-desc">Comma-separated folders/files to hide</span>
            </div>
          </div>
          <div class="settings-row-full">
            <input type="text" class="settings-input-full" id="set-ignored"
              value="${escapeAttr((config.ignoredPatterns || []).join(', '))}" />
          </div>
        </div>
        <div class="settings-footer">
          <span class="settings-hint">~/.volt/config.json</span>
          <button class="settings-save" id="btn-save-settings">Save</button>
        </div>
      </div>

      <div class="settings-tab-content hidden" id="settings-tab-json">
        <div class="settings-json-wrap">
          <textarea class="settings-json-editor" id="set-json" spellcheck="false"></textarea>
          <span class="settings-json-error hidden" id="json-error"></span>
        </div>
        <div class="settings-footer">
          <span class="settings-hint">Raw config — be careful with syntax</span>
          <button class="settings-save" id="btn-save-json">Save JSON</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panelEl);

  // Close on Escape
  escapeHandler = (e) => {
    if (e.key === 'Escape') closeSettings();
  };
  document.addEventListener('keydown', escapeHandler);

  // Populate JSON editor with pretty-printed config (excluding window state)
  const jsonEditor = document.getElementById('set-json');
  const editableConfig = { ...config };
  delete editableConfig.window; // don't expose window state — it's auto-managed
  jsonEditor.value = JSON.stringify(editableConfig, null, 2);

  // Tab switching
  panelEl.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      panelEl.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.getElementById('settings-tab-ui').classList.toggle('hidden', target !== 'ui');
      document.getElementById('settings-tab-json').classList.toggle('hidden', target !== 'json');
    });
  });

  panelEl.addEventListener('click', (e) => {
    if (e.target === panelEl) closeSettings();
  });

  document.getElementById('btn-close-settings').addEventListener('click', closeSettings);

  // Save from UI tab
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const fontSize = parseInt(document.getElementById('set-font-size').value) || 14;
    const scrollback = parseInt(document.getElementById('set-scrollback').value) || 5000;
    const shell = document.getElementById('set-shell').value.trim();
    const autoSave = document.getElementById('set-auto-save').checked;
    const autoSaveDelay = parseInt(document.getElementById('set-auto-save-delay').value) || 1500;
    const ignored = document.getElementById('set-ignored').value
      .split(',').map(s => s.trim()).filter(Boolean);

    config.terminal = { fontSize, scrollback, shell };
    config.editor = { autoSave, autoSaveDelay };
    config.ignoredPatterns = ignored;

    try {
      await invoke('save_config', { config });
      if (onConfigChanged) onConfigChanged(config);
      closeSettings();
    } catch (err) {
      showSaveError(panelEl, `Failed to save: ${err}`);
    }
  });

  // Save from JSON tab
  document.getElementById('btn-save-json').addEventListener('click', async () => {
    const errorEl = document.getElementById('json-error');
    errorEl.classList.add('hidden');

    let parsed;
    try {
      parsed = JSON.parse(jsonEditor.value);
    } catch (err) {
      errorEl.textContent = `Invalid JSON: ${err.message}`;
      errorEl.classList.remove('hidden');
      return;
    }

    // Preserve window state (auto-managed, not user-editable)
    parsed.window = config.window;
    config = { ...config, ...parsed };

    try {
      await invoke('save_config', { config });
      if (onConfigChanged) onConfigChanged(config);
      closeSettings();
    } catch (err) {
      errorEl.textContent = `Save failed: ${err}`;
      errorEl.classList.remove('hidden');
    }
  });
}

function showSaveError(panel, message) {
  if (!panel) return;
  let errEl = panel.querySelector('.settings-save-error');
  if (!errEl) {
    errEl = document.createElement('span');
    errEl.className = 'settings-save-error';
    errEl.style.cssText = 'color:#f44747;font-size:11px;font-family:"JetBrains Mono",monospace;margin-top:6px;display:block;';
    const footer = panel.querySelector('#settings-tab-ui .settings-footer');
    if (footer) footer.appendChild(errEl);
  }
  errEl.textContent = message;
}

function closeSettings() {
  visible = false;
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler);
    escapeHandler = null;
  }
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
  }
}
