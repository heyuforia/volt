import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentFolder } from './app.js';
import { resolveFileIcon } from './file-tree.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

const tabList = document.getElementById('tab-list');
const terminalContainer = document.getElementById('terminal-container');
const btnNewTab = document.getElementById('btn-new-tab');

let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let terminalConfig = { fontSize: 14, scrollback: 5000, shell: '' };
const ptyToTab = new Map(); // ptyId -> tab (O(1) lookup for high-frequency output events)
let activationCallback = null;
let tabCloseCallback = null;

export function setTerminalConfig(cfg) {
  if (!cfg) return;
  if (cfg.fontSize) terminalConfig.fontSize = cfg.fontSize;
  if (cfg.scrollback) terminalConfig.scrollback = cfg.scrollback;
  if (cfg.shell !== undefined) terminalConfig.shell = cfg.shell;

  // Apply to existing tabs
  for (const tab of tabs) {
    if (tab.type === 'terminal') {
      if (cfg.fontSize) tab.terminal.options.fontSize = cfg.fontSize;
      if (cfg.scrollback) tab.terminal.options.scrollback = cfg.scrollback;
      requestAnimationFrame(() => fitTerminal(tab));
    } else if (tab.type === 'file' && cfg.fontSize && tab.editorView) {
      import('./editor.js').then(({ setEditorFontSize }) => {
        setEditorFontSize(tab.editorView, cfg.fontSize);
      });
    }
  }
}

export function addFileTab(tab) {
  tabs.push(tab);
  renderTabs();
  activateTab(tab.id);
}

const IS_WINDOWS = navigator.platform.startsWith('Win');
function pathsEqual(a, b) {
  if (IS_WINDOWS) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function findTabByFilePath(path) {
  return tabs.find(t => t.type === 'file' && pathsEqual(t.filePath, path)) || null;
}

export function getActiveTab() {
  return tabs.find(t => t.id === activeTabId) || null;
}

export function getUnsavedFileTabs() {
  return tabs.filter(t => t.type === 'file' && t.modified);
}

export function setActivationCallback(fn) {
  activationCallback = fn;
}

export function setTabCloseCallback(fn) {
  tabCloseCallback = fn;
}

export function getTerminalConfig() {
  return terminalConfig;
}

const TERMINAL_THEME = {
  background: '#141414',
  foreground: '#d4d4d4',
  cursor: '#b45dff',
  cursorAccent: '#141414',
  selectionBackground: 'rgba(180, 93, 255, 0.18)',
  selectionForeground: '#ffffff',
  black: '#181818',
  red: '#f44747',
  green: '#4ec9b0',
  yellow: '#f0c800',
  blue: '#569cd6',
  magenta: '#b45dff',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#7a7a8a',
  brightRed: '#f44747',
  brightGreen: '#4ec9b0',
  brightYellow: '#f0c800',
  brightBlue: '#569cd6',
  brightMagenta: '#c77dff',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff',
};

export async function initTerminals() {
  // Listen for PTY output
  await listen('terminal-output', (event) => {
    const { id, data } = event.payload;
    const tab = ptyToTab.get(id);
    if (tab) {
      tab.terminal.write(data);
    }
  });

  // Listen for PTY exit
  await listen('terminal-exit', (event) => {
    const { id } = event.payload;
    const tab = ptyToTab.get(id);
    if (tab) {
      tab.terminal.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
      tab.exited = true;
    }
  });

  // New tab button
  btnNewTab.addEventListener('click', () => createTerminalTab());

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+T — New tab
    if (e.ctrlKey && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      createTerminalTab();
    }
    // Ctrl+Shift+W — Close tab
    if (e.ctrlKey && e.shiftKey && e.key === 'W') {
      e.preventDefault();
      if (activeTabId) closeTab(activeTabId);
    }
    // Ctrl+Tab — Next tab (also Alt+Right as fallback since Ctrl+Tab is swallowed by webview)
    if ((e.ctrlKey && !e.shiftKey && e.key === 'Tab') || (e.altKey && e.key === 'ArrowRight')) {
      e.preventDefault();
      switchToNextTab(1);
    }
    // Ctrl+Shift+Tab — Previous tab (also Alt+Left as fallback)
    if ((e.ctrlKey && e.shiftKey && e.key === 'Tab') || (e.altKey && e.key === 'ArrowLeft')) {
      e.preventDefault();
      switchToNextTab(-1);
    }
  });

  // Resize observer
  const resizeObserver = new ResizeObserver(() => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.type === 'terminal') fitTerminal(tab);
  });
  resizeObserver.observe(terminalContainer);
}

export async function createTerminalTab() {
  tabCounter++;
  const tabId = `tab-${tabCounter}`;
  const name = `Terminal ${tabCounter}`;

  // Spawn PTY
  const cwd = getCurrentFolder() || undefined;
  const shell = terminalConfig.shell || undefined;
  let ptyId;
  try {
    ptyId = await invoke('spawn_terminal', { shell, cwd });
  } catch (err) {
    console.error('Failed to spawn terminal:', err);
    // Show error in a temporary terminal wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper active';
    wrapper.id = `tab-err-${tabCounter}`;

    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding:20px;color:#f44747;font-size:13px;';

    const title = document.createElement('p');
    title.style.cssText = 'margin-bottom:8px;font-weight:600;';
    title.textContent = 'Failed to start shell';

    const msg = document.createElement('p');
    msg.style.color = '#7a7a8a';
    msg.textContent = String(err);

    const hint = document.createElement('p');
    hint.style.cssText = 'color:#7a7a8a;margin-top:8px;';
    hint.textContent = 'Check that your shell exists on PATH.';

    errorDiv.appendChild(title);
    errorDiv.appendChild(msg);
    errorDiv.appendChild(hint);
    wrapper.appendChild(errorDiv);
    terminalContainer.appendChild(wrapper);
    setTimeout(() => wrapper.remove(), 8000);
    return;
  }

  // Create xterm instance
  const terminal = new Terminal({
    theme: TERMINAL_THEME,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Menlo', 'Consolas', 'Liberation Mono', monospace",
    fontSize: terminalConfig.fontSize,
    scrollback: terminalConfig.scrollback,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  // Terminal wrapper element
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.id = tabId;
  terminalContainer.appendChild(wrapper);

  terminal.open(wrapper);

  // Let specific combos bubble up to our global keydown handler
  // instead of being swallowed by xterm.js.
  // Ctrl+C: copy if selection exists, otherwise let xterm send SIGINT.
  // Ctrl+V: paste from clipboard.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.key === 'Tab') return false;
    if (e.ctrlKey && e.shiftKey && ['T', 'W', 'F'].includes(e.key)) return false;

    // Ctrl+C — copy selection (if any), otherwise let SIGINT through
    if (e.ctrlKey && !e.shiftKey && e.key === 'c') {
      if (terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection());
        terminal.clearSelection();
        return false; // prevent xterm from sending SIGINT
      }
      return true; // no selection → normal SIGINT
    }

    // Ctrl+Backspace — delete previous word
    if (e.ctrlKey && !e.shiftKey && e.key === 'Backspace') {
      let seq;
      if (IS_WINDOWS) {
        // ConPTY has two input processing modes depending on the child:
        // - Standard (PSReadLine): translates VT → INPUT_RECORDs. Standard VT
        //   can't encode Ctrl+Backspace, so we use win32-input-mode CSI format.
        // - VT passthrough (Claude Code, vim, etc.): child enables
        //   ENABLE_VIRTUAL_TERMINAL_INPUT, ConPTY passes bytes through directly.
        //   Standard ESC+DEL works here.
        // Detection: VT-aware apps enable bracketed paste mode (?2004h).
        // PSReadLine on Windows never does (confirmed, no support as of v2.4.5).
        const vtApp = terminal.modes.bracketedPasteMode;
        seq = vtApp ? '\x1b\x7f' : '\x1b[8;14;127;1;8;1_';
      } else {
        seq = '\x1b\x7f';
      }
      invoke('write_terminal', { id: ptyId, data: seq }).catch(() => {});
      return false;
    }

    // Ctrl+V — paste from clipboard
    if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
      e.preventDefault(); // block browser paste event (xterm listens for it too)
      navigator.clipboard.readText().then((text) => {
        if (text) invoke('write_terminal', { id: ptyId, data: text }).catch(() => {});
      }).catch(() => {});
      return false;
    }

    return true;
  });

  // Handle terminal input → PTY
  terminal.onData((data) => {
    invoke('write_terminal', { id: ptyId, data }).catch(() => {});
  });

  const tab = { id: tabId, type: 'terminal', name, ptyId, terminal, fitAddon, wrapper, exited: false };

  // Dynamic tab title from shell OSC sequences
  terminal.onTitleChange((title) => {
    if (title && tab.type === 'terminal') {
      // Clean up: show just the executable name or last path segment
      const clean = title.split(/[\\/]/).pop().replace(/\.exe$/i, '');
      tab.name = clean || title;
      renderTabs();
    }
  });

  tabs.push(tab);
  ptyToTab.set(ptyId, tab);

  renderTabs();
  activateTab(tabId);

  // Fit after a brief delay to ensure DOM is ready
  requestAnimationFrame(() => fitTerminal(tab));
}

// Mouse-based drag reorder (HTML5 drag-drop is unreliable in webviews)
let dragState = null;

function initTabDrag(tabEl, tab) {
  tabEl.addEventListener('mousedown', (e) => {
    // Only left-click, ignore close button
    if (e.button !== 0 || e.target.closest('.tab-close')) return;
    // Skip if this is the second click of a double-click
    if (e.detail >= 2) return;

    const startX = e.clientX;
    const threshold = 5;
    let dragging = false;

    const onMouseMove = (e) => {
      if (!dragging && Math.abs(e.clientX - startX) > threshold) {
        dragging = true;
        dragState = true;
        tabEl.classList.add('dragging');
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }
      if (!dragging) return;

      // Find which tab we're hovering over
      tabList.querySelectorAll('.tab').forEach(el => {
        el.classList.remove('drag-over-left', 'drag-over-right');
        if (el.dataset.tabId === tab.id) return;
        const rect = el.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right) {
          const midX = rect.left + rect.width / 2;
          el.classList.toggle('drag-over-left', e.clientX < midX);
          el.classList.toggle('drag-over-right', e.clientX >= midX);
        }
      });
    };

    const onMouseUp = (e) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (!dragging) return;

      tabEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Find drop target
      const targetEl = [...tabList.querySelectorAll('.tab')].find(el => {
        if (el.dataset.tabId === tab.id) return false;
        const rect = el.getBoundingClientRect();
        return e.clientX >= rect.left && e.clientX <= rect.right;
      });

      tabList.querySelectorAll('.tab').forEach(el => el.classList.remove('drag-over-left', 'drag-over-right'));

      if (targetEl) {
        const fromIdx = tabs.findIndex(t => t.id === tab.id);
        const targetTabId = targetEl.dataset.tabId;
        const rect = targetEl.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;

        const [moved] = tabs.splice(fromIdx, 1);
        let insertIdx = tabs.findIndex(t => t.id === targetTabId);
        if (e.clientX >= midX) insertIdx++;
        tabs.splice(insertIdx, 0, moved);
        renderTabs();
      }

      dragState = null;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function renderTabs() {
  tabList.innerHTML = '';
  if (tabs.length === 0) {
    showEmptyState();
    return;
  }
  hideEmptyState();
  for (const tab of tabs) {
    const tabEl = document.createElement('div');
    const typeClass = tab.type === 'file' ? ' tab-file' : ' tab-terminal';
    tabEl.className = `tab${typeClass}${tab.id === activeTabId ? ' active' : ''}`;
    tabEl.dataset.tabId = tab.id;

    // Tab icon
    const tabIcon = document.createElement('span');
    tabIcon.className = 'tab-icon';
    if (tab.type === 'terminal') {
      tabIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 12h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    } else {
      const img = document.createElement('img');
      img.className = 'tab-icon-img';
      img.src = resolveFileIcon(tab.name);
      tabIcon.appendChild(img);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';

    if (tab.type === 'file' && tab.modified) {
      const dot = document.createElement('span');
      dot.className = 'tab-modified';
      dot.textContent = '\u25CF';
      nameSpan.appendChild(dot);
    }

    nameSpan.appendChild(document.createTextNode(tab.name));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    // Double-click to rename (terminal tabs only)
    if (tab.type === 'terminal') {
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();

        const input = document.createElement('input');
        input.value = tab.name;
        input.style.cssText = 'background:#222222;border:1px solid #b45dff;color:#d4d4d4;font-size:12px;padding:0 4px;width:100px;outline:none;border-radius:2px;font-family:inherit;';
        nameSpan.replaceWith(input);
        input.focus();
        input.select();

        const finish = () => {
          tab.name = input.value || tab.name;
          renderTabs();
        };
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') finish();
          if (e.key === 'Escape') { input.value = tab.name; finish(); }
        });
      });
    }

    tabEl.addEventListener('click', () => {
      if (dragState) return;
      activateTab(tab.id);
    });

    tabEl.appendChild(tabIcon);
    tabEl.appendChild(nameSpan);
    tabEl.appendChild(closeBtn);
    tabList.appendChild(tabEl);

    initTabDrag(tabEl, tab);
  }

  // Detect overflow for scroll fade
  requestAnimationFrame(() => {
    tabList.classList.toggle('overflowing', tabList.scrollWidth > tabList.clientWidth);
  });
}

function activateTab(tabId) {
  activeTabId = tabId;

  // Hide all wrappers, show active
  for (const tab of tabs) {
    tab.wrapper.classList.toggle('active', tab.id === tabId);
  }

  // Update tab styling
  const tabEls = tabList.querySelectorAll('.tab');
  tabEls.forEach(el => {
    el.classList.toggle('active', el.dataset.tabId === tabId);
  });

  // Focus and fit
  const tab = tabs.find(t => t.id === tabId);
  if (tab) {
    if (tab.type === 'terminal') {
      tab.terminal.focus();
      requestAnimationFrame(() => fitTerminal(tab));
    } else if (tab.type === 'file' && tab.editorView) {
      tab.editorView.focus();
    }
    if (activationCallback) activationCallback(tab);
  }
}

async function closeTab(tabId) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;

  const tab = tabs[idx];

  if (tab.type === 'terminal') {
    // Kill PTY if still running
    if (!tab.exited) {
      try {
        await invoke('kill_terminal', { id: tab.ptyId });
      } catch { /* already dead */ }
    }
    ptyToTab.delete(tab.ptyId);
    tab.terminal.dispose();
  } else if (tab.type === 'file') {
    // Confirm if unsaved
    if (tab.modified) {
      const { confirm } = await import('@tauri-apps/plugin-dialog');
      const confirmed = await confirm(
        `"${tab.name}" has unsaved changes. Close anyway?`,
        { title: 'Volt', kind: 'warning' }
      );
      if (!confirmed) return;
    }
    if (tab.editorView) {
      tab.editorView.destroy();
    }
    if (tabCloseCallback) tabCloseCallback(tab);
  }

  // Re-find index in case the array was modified during async confirmation
  const finalIdx = tabs.findIndex(t => t.id === tabId);
  if (finalIdx === -1) return;

  tab.wrapper.remove();
  tabs.splice(finalIdx, 1);

  if (tabs.length === 0) {
    activeTabId = null;
    renderTabs();
    if (activationCallback) activationCallback(null);
    return;
  }

  // Activate next or previous tab
  if (activeTabId === tabId) {
    const newIdx = Math.min(finalIdx, tabs.length - 1);
    activateTab(tabs[newIdx].id);
  }

  renderTabs();
}

function switchToNextTab(direction) {
  if (tabs.length <= 1) return;
  const idx = tabs.findIndex(t => t.id === activeTabId);
  const newIdx = (idx + direction + tabs.length) % tabs.length;
  activateTab(tabs[newIdx].id);
}

export function getActiveTerminalCount() {
  return tabs.filter(t => t.type === 'terminal' && !t.exited).length;
}

export function getAllTabs() {
  return tabs;
}

export async function closeAllTabs() {
  for (const tab of tabs) {
    if (tab.type === 'terminal') {
      if (!tab.exited) {
        try { await invoke('kill_terminal', { id: tab.ptyId }); } catch {}
      }
      ptyToTab.delete(tab.ptyId);
      tab.terminal.dispose();
    } else if (tab.type === 'file') {
      if (tab.editorView) tab.editorView.destroy();
      if (tabCloseCallback) tabCloseCallback(tab);
    }
    tab.wrapper.remove();
  }
  tabs.length = 0;
  activeTabId = null;
  renderTabs();
  if (activationCallback) activationCallback(null);
}

export function updateFileTabPath(oldPath, newPath, newName) {
  const tab = tabs.find(t => t.type === 'file' && pathsEqual(t.filePath, oldPath));
  if (!tab) return null;
  tab.filePath = newPath;
  tab.name = newName;
  renderTabs();
  if (tab.id === activeTabId && activationCallback) activationCallback(tab);
  return tab;
}

export function getFileTabsByPathPrefix(dirPath) {
  const withSlash = dirPath + '/';
  const withBackslash = dirPath + '\\';
  if (IS_WINDOWS) {
    const sl = withSlash.toLowerCase();
    const bs = withBackslash.toLowerCase();
    return tabs.filter(t => t.type === 'file' &&
      (t.filePath.toLowerCase().startsWith(sl) || t.filePath.toLowerCase().startsWith(bs)));
  }
  return tabs.filter(t => t.type === 'file' &&
    (t.filePath.startsWith(withSlash) || t.filePath.startsWith(withBackslash)));
}

export function forceCloseFileTab(tabId) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  const tab = tabs[idx];
  if (tab.type !== 'file') return;

  if (tab.editorView) tab.editorView.destroy();
  if (tabCloseCallback) tabCloseCallback(tab);
  tab.wrapper.remove();
  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    activeTabId = null;
    renderTabs();
    if (activationCallback) activationCallback(null);
    return;
  }

  if (activeTabId === tabId) {
    const newIdx = Math.min(idx, tabs.length - 1);
    activateTab(tabs[newIdx].id);
  }
  renderTabs();
}

export { renderTabs, activateTab };

function showEmptyState() {
  if (terminalContainer.querySelector('.empty-state')) return;
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 16 16" fill="none" style="color:#222222">
      <path d="M3 4.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M9 12h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
    <span>Ctrl+Shift+T to open a terminal</span>
  `;
  terminalContainer.appendChild(el);
}

function hideEmptyState() {
  const el = terminalContainer.querySelector('.empty-state');
  if (el) el.remove();
}

function fitTerminal(tab) {
  try {
    tab.fitAddon.fit();
    const dims = tab.fitAddon.proposeDimensions();
    if (dims && dims.cols && dims.rows) {
      invoke('resize_terminal', {
        id: tab.ptyId,
        cols: dims.cols,
        rows: dims.rows,
      }).catch(() => {});
    }
  } catch { /* terminal not ready yet */ }
}
