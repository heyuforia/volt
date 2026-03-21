import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentFolder, openFile } from './app.js';
import { resolveFileIcon } from './file-tree.js';
import { setEditorFontSize } from './editor.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';

const tabList = document.getElementById('tab-list');
const terminalContainer = document.getElementById('terminal-container');
const btnNewTab = document.getElementById('btn-new-tab');

let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let paneCounter = 0;
let terminalConfig = { fontSize: 14, scrollback: 5000, shell: '' };
const ptyToPane = new Map(); // ptyId -> pane (O(1) lookup for high-frequency output events)
let activationCallback = null;
let tabCloseCallback = null;

function nextPaneId() { return `pane-${++paneCounter}`; }

// ── Pane tree helpers ──

function isPane(node) { return node && node.terminal !== undefined; }

function forEachPane(node, fn) {
  if (!node) return;
  if (isPane(node)) { fn(node); return; }
  for (const child of node.children) forEachPane(child, fn);
}

function countPanes(node) {
  if (!node) return 0;
  if (isPane(node)) return 1;
  return node.children.reduce((sum, c) => sum + countPanes(c), 0);
}

function findPane(node, paneId) {
  if (!node) return null;
  if (isPane(node)) return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findPane(child, paneId);
    if (found) return found;
  }
  return null;
}

// Returns the first pane found (for fallback focus)
function firstPane(node) {
  if (!node) return null;
  if (isPane(node)) return node;
  return firstPane(node.children[0]);
}

// Replace a pane in the tree with a new node. Returns the new root.
function replacePaneInTree(root, paneId, replacement) {
  if (isPane(root)) return root.id === paneId ? replacement : root;
  const newChildren = root.children.map(c => replacePaneInTree(c, paneId, replacement));
  return { ...root, children: newChildren };
}

// Remove a pane from the tree. Returns the new root (or null if tree is now empty).
function removePaneFromTree(root, paneId) {
  if (isPane(root)) return root.id === paneId ? null : root;
  const remaining = root.children.map(c => removePaneFromTree(c, paneId)).filter(Boolean);
  if (remaining.length === 0) return null;
  if (remaining.length === 1) return remaining[0]; // collapse split node
  return { ...root, children: remaining };
}

export function getActivePaneOfTab(tab) {
  if (!tab || tab.type !== 'terminal') return null;
  return findPane(tab.root, tab.activePaneId) || firstPane(tab.root);
}

export function setTerminalConfig(cfg) {
  if (!cfg) return;
  if (cfg.fontSize) terminalConfig.fontSize = cfg.fontSize;
  if (cfg.scrollback) terminalConfig.scrollback = cfg.scrollback;
  if (cfg.shell !== undefined) terminalConfig.shell = cfg.shell;

  // Apply to existing tabs
  for (const tab of tabs) {
    if (tab.type === 'terminal') {
      forEachPane(tab.root, (pane) => {
        if (cfg.fontSize) pane.terminal.options.fontSize = cfg.fontSize;
        if (cfg.scrollback) pane.terminal.options.scrollback = cfg.scrollback;
      });
      requestAnimationFrame(() => fitAllPanes(tab.root));
    } else if (tab.type === 'file' && cfg.fontSize && tab.editorView) {
      setEditorFontSize(tab.editorView, cfg.fontSize);
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
    const pane = ptyToPane.get(id);
    if (pane) {
      pane.terminal.write(data);
    }
  });

  // Listen for PTY exit
  await listen('terminal-exit', (event) => {
    const { id } = event.payload;
    const pane = ptyToPane.get(id);
    if (pane) {
      pane.terminal.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
      pane.exited = true;
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
    // Ctrl+Shift+D — Split terminal horizontal (side-by-side)
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab?.type === 'terminal') splitActivePane('horizontal');
    }
    // Ctrl+Shift+E — Split terminal vertical (top-bottom)
    if (e.ctrlKey && e.shiftKey && e.key === 'E') {
      e.preventDefault();
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab?.type === 'terminal') splitActivePane('vertical');
    }
  });

  // Resize observer
  const resizeObserver = new ResizeObserver(() => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.type === 'terminal') fitAllPanes(tab.root);
  });
  resizeObserver.observe(terminalContainer);
}

// ── Pane creation ──

async function createPane(cwd) {
  const shell = terminalConfig.shell || undefined;
  const ptyId = await invoke('spawn_terminal', { shell, cwd });

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
  terminal.loadAddon(new WebLinksAddon((_event, url) => {
    invoke('open_url', { url }).catch(e => console.warn('Failed to open URL:', e));
  }));
  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);
  terminal.registerLinkProvider(createFilePathLinkProvider(terminal));

  const paneWrapper = document.createElement('div');
  paneWrapper.className = 'pane-wrapper';

  const { searchBar, searchInput } = createSearchBar(searchAddon, terminal);
  paneWrapper.appendChild(searchBar);

  terminal.open(paneWrapper);

  // Key handler: bubble up combos to global handler
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.key === 'Tab') return false;
    if (e.ctrlKey && e.shiftKey && ['T', 'W', 'F', 'O', 'D', 'E'].includes(e.key)) return false;
    if (e.ctrlKey && !e.shiftKey && e.key === 'f') return false;

    if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
      e.preventDefault();
      invoke('write_terminal', { id: pane.ptyId, data: '\x1b\n' }).catch(e => console.warn('Failed to write terminal:', e));
      return false;
    }

    if (e.ctrlKey && !e.shiftKey && e.key === 'c') {
      if (terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection());
        terminal.clearSelection();
        return false;
      }
      return true;
    }

    if (e.ctrlKey && !e.shiftKey && e.key === 'Backspace') {
      let seq;
      if (IS_WINDOWS) {
        const vtApp = terminal.modes.bracketedPasteMode;
        seq = vtApp ? '\x1b\x7f' : '\x1b[8;14;127;1;8;1_';
      } else {
        seq = '\x1b\x7f';
      }
      invoke('write_terminal', { id: pane.ptyId, data: seq }).catch(e => console.warn('Failed to write terminal:', e));
      return false;
    }

    if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (text) invoke('write_terminal', { id: pane.ptyId, data: text }).catch(e => console.warn('Failed to write terminal:', e));
      }).catch(e => console.warn('Failed to read clipboard:', e));
      return false;
    }

    return true;
  });

  terminal.onData((data) => {
    invoke('write_terminal', { id: pane.ptyId, data }).catch(() => {});
  });

  const pane = {
    id: nextPaneId(),
    ptyId,
    terminal,
    fitAddon,
    searchAddon,
    searchBar,
    searchInput,
    wrapper: paneWrapper,
    exited: false,
    name: null, // set by OSC title
  };

  terminal.onTitleChange((title) => {
    if (!title) return;
    const clean = title.split(/[\\/]/).pop().replace(/\.exe$/i, '');
    pane.name = clean || title;
    // Update tab name if this is the active pane
    const tab = tabs.find(t => t.type === 'terminal' && t.activePaneId === pane.id);
    if (tab) {
      tab.name = pane.name;
      renderTabs();
    }
  });

  ptyToPane.set(ptyId, pane);
  return pane;
}

// ── Pane tree DOM rendering ──

function renderPaneTree(node, container, tab) {
  if (isPane(node)) {
    node.wrapper.classList.toggle('pane-active', node.id === tab.activePaneId);
    // Only attach the focus handler once per pane (guard with a flag)
    if (!node._focusHandlerAttached) {
      node._focusHandlerAttached = true;
      node.wrapper.addEventListener('mousedown', () => {
        if (tab.activePaneId !== node.id) {
          tab.activePaneId = node.id;
          tab.name = node.name || tab.name;
          tab.wrapper.querySelectorAll('.pane-wrapper').forEach(el => el.classList.remove('pane-active'));
          node.wrapper.classList.add('pane-active');
          node.terminal.focus();
          renderTabs();
        }
      });
    }
    container.appendChild(node.wrapper);
    return;
  }

  const splitEl = document.createElement('div');
  splitEl.className = `split-container split-${node.direction}`;

  const firstChild = document.createElement('div');
  firstChild.className = 'split-child';
  firstChild.style.flex = String(node.ratio);

  const divider = document.createElement('div');
  divider.className = `split-divider split-divider-${node.direction === 'horizontal' ? 'h' : 'v'}`;

  const secondChild = document.createElement('div');
  secondChild.className = 'split-child';
  secondChild.style.flex = String(1 - node.ratio);

  renderPaneTree(node.children[0], firstChild, tab);
  renderPaneTree(node.children[1], secondChild, tab);

  // Divider drag-resize
  initDividerDrag(divider, firstChild, secondChild, node, tab);

  splitEl.appendChild(firstChild);
  splitEl.appendChild(divider);
  splitEl.appendChild(secondChild);
  container.appendChild(splitEl);
}

function initDividerDrag(divider, firstChild, secondChild, splitNode, tab) {
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isHorizontal = splitNode.direction === 'horizontal';
    const container = divider.parentElement;
    const startPos = isHorizontal ? e.clientX : e.clientY;
    const containerSize = isHorizontal ? container.offsetWidth : container.offsetHeight;
    const startRatio = splitNode.ratio;

    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e) => {
      const currentPos = isHorizontal ? e.clientX : e.clientY;
      const delta = (currentPos - startPos) / containerSize;
      const newRatio = Math.max(0.1, Math.min(0.9, startRatio + delta));
      splitNode.ratio = newRatio;
      firstChild.style.flex = String(newRatio);
      secondChild.style.flex = String(1 - newRatio);
      fitAllPanes(tab.root);
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      fitAllPanes(tab.root);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function rebuildTabDOM(tab) {
  // Remove all children except the tab wrapper itself
  while (tab.wrapper.firstChild) tab.wrapper.firstChild.remove();
  renderPaneTree(tab.root, tab.wrapper, tab);
  requestAnimationFrame(() => fitAllPanes(tab.root));
}

// ── Split and close panes ──

export async function splitActivePane(direction) {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.type !== 'terminal') return;

  const activePane = getActivePaneOfTab(tab);
  if (!activePane || activePane.exited) return;

  const cwd = getCurrentFolder() || undefined;
  let newPane;
  try {
    newPane = await createPane(cwd);
  } catch (err) {
    console.error('Failed to spawn split terminal:', err);
    return;
  }

  const splitNode = {
    direction,
    children: [activePane, newPane],
    ratio: 0.5,
  };

  tab.root = replacePaneInTree(tab.root, activePane.id, splitNode);
  tab.activePaneId = newPane.id;
  tab.name = newPane.name || tab.name;

  rebuildTabDOM(tab);
  newPane.terminal.focus();
  renderTabs();
}

export async function closePaneById(paneId) {
  const tab = tabs.find(t => t.type === 'terminal' && findPane(t.root, paneId));
  if (!tab) return;

  const pane = findPane(tab.root, paneId);
  if (!pane) return;

  // Kill PTY
  if (!pane.exited) {
    try { await invoke('kill_terminal', { id: pane.ptyId }); } catch (e) { console.warn('Failed to kill terminal:', e); }
  }
  ptyToPane.delete(pane.ptyId);
  pane.terminal.dispose();

  const newRoot = removePaneFromTree(tab.root, paneId);
  if (!newRoot) {
    // Last pane closed — close the whole tab
    closeTab(tab.id);
    return;
  }

  tab.root = newRoot;
  if (tab.activePaneId === paneId) {
    const fallback = firstPane(tab.root);
    tab.activePaneId = fallback ? fallback.id : null;
    tab.name = fallback?.name || tab.name;
  }

  rebuildTabDOM(tab);
  const activeP = getActivePaneOfTab(tab);
  if (activeP) activeP.terminal.focus();
  renderTabs();
}

export async function createTerminalTab() {
  tabCounter++;
  const tabId = `tab-${tabCounter}`;
  const name = `Terminal ${tabCounter}`;
  const cwd = getCurrentFolder() || undefined;

  let pane;
  try {
    pane = await createPane(cwd);
  } catch (err) {
    console.error('Failed to spawn terminal:', err);
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

  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.id = tabId;
  terminalContainer.appendChild(wrapper);

  const tab = {
    id: tabId,
    type: 'terminal',
    name,
    root: pane,
    activePaneId: pane.id,
    wrapper,
  };

  renderPaneTree(pane, wrapper, tab);

  tabs.push(tab);
  renderTabs();
  activateTab(tabId);

  requestAnimationFrame(() => fitAllPanes(tab.root));
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
  const scrollLeft = tabList.scrollLeft;
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
    tabEl.setAttribute('role', 'tab');
    tabEl.setAttribute('aria-selected', tab.id === activeTabId ? 'true' : 'false');

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

    // Pane count badge for split terminals
    if (tab.type === 'terminal') {
      const pc = countPanes(tab.root);
      if (pc > 1) {
        const badge = document.createElement('span');
        badge.className = 'tab-pane-count';
        badge.textContent = `[${pc}]`;
        nameSpan.appendChild(badge);
      }
    }

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

  // Restore tab bar scroll position and detect overflow
  tabList.scrollLeft = scrollLeft;
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
      const pane = getActivePaneOfTab(tab);
      if (pane) pane.terminal.focus();
      requestAnimationFrame(() => fitAllPanes(tab.root));
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
    // Kill all PTYs in the pane tree
    const killPromises = [];
    forEachPane(tab.root, (pane) => {
      if (!pane.exited) {
        killPromises.push(invoke('kill_terminal', { id: pane.ptyId }).catch(e => console.warn('Failed to kill terminal:', e)));
      }
      ptyToPane.delete(pane.ptyId);
      pane.terminal.dispose();
    });
    await Promise.all(killPromises);
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
  let count = 0;
  for (const tab of tabs) {
    if (tab.type === 'terminal') {
      forEachPane(tab.root, (pane) => { if (!pane.exited) count++; });
    }
  }
  return count;
}

export function getAllTabs() {
  return tabs;
}

export async function closeAllTabs() {
  for (const tab of tabs) {
    if (tab.type === 'terminal') {
      forEachPane(tab.root, (pane) => {
        if (!pane.exited) {
          invoke('kill_terminal', { id: pane.ptyId }).catch(e => console.warn('Failed to kill terminal:', e));
        }
        ptyToPane.delete(pane.ptyId);
        pane.terminal.dispose();
      });
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

// Link provider that detects file paths in terminal output (e.g. "src/js/app.js:42")
// and opens them in Volt's editor when clicked.
function createFilePathLinkProvider(term) {
  // Matches paths like: ./src/foo.js, src/foo.js:42, C:\foo\bar.rs:10:5, /home/user/file.py
  // Captures: [1]=line number (optional)
  const FILE_PATH_RE = /(?:\.?[\/\\])?(?:[\w.@~-]+[\/\\])+[\w.-]+\.[\w]+(?::(\d+))?(?::\d+)?/g;

  // Common file extensions to avoid matching random dotted paths
  const FILE_EXTS = new Set([
    'js','ts','jsx','tsx','mjs','cjs','json','jsonc',
    'rs','go','py','rb','java','kt','swift','c','h','cpp','hpp','cs',
    'html','htm','css','scss','sass','less',
    'md','txt','yaml','yml','toml','xml','svg',
    'sh','bash','zsh','fish','ps1','bat','cmd',
    'vue','svelte','astro','dart','lua','zig','ex','exs',
    'sql','graphql','proto','lock','cfg','ini','env',
    'dockerfile',
  ]);

  return {
    provideLinks(bufferLineNumber, callback) {
      const folder = getCurrentFolder();
      if (!folder) { callback([]); return; }

      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) { callback([]); return; }

      const lineText = line.translateToString(true);
      const links = [];

      FILE_PATH_RE.lastIndex = 0;
      let match;
      while ((match = FILE_PATH_RE.exec(lineText)) !== null) {
        const fullMatch = match[0];
        const lineNum = match[1] ? parseInt(match[1], 10) : undefined;

        // Check file extension
        const ext = fullMatch.replace(/:\d+(:\d+)?$/, '').split('.').pop().toLowerCase();
        if (!FILE_EXTS.has(ext)) continue;

        const startIndex = match.index;
        // xterm.js IBufferRange: x is 1-based, end is inclusive
        links.push({
          range: {
            start: { x: startIndex + 1, y: bufferLineNumber },
            end: { x: startIndex + fullMatch.length, y: bufferLineNumber },
          },
          text: fullMatch,
          activate() {
            // Strip trailing :line:col from the path
            let filePath = fullMatch.replace(/:\d+(:\d+)?$/, '');

            // Resolve relative paths against the current folder
            if (!filePath.match(/^[A-Za-z]:[\/\\]/) && !filePath.startsWith('/')) {
              const sep = folder.includes('/') ? '/' : '\\';
              filePath = folder + sep + filePath.replace(/^\.?[\/\\]/, '').replace(/[\\/]/g, sep);
            }

            const name = filePath.split(/[\\/]/).pop();
            openFile({ path: filePath, name, is_dir: false }, lineNum);
          },
        });
      }

      callback(links);
    },
  };
}

// ── Terminal search bar ──

const SEARCH_DECORATIONS = {
  matchBackground: 'rgba(240, 200, 0, 0.25)',
  matchBorder: 'rgba(240, 200, 0, 0.5)',
  matchOverviewRuler: 'rgba(240, 200, 0, 0.6)',
  activeMatchBackground: 'rgba(180, 93, 255, 0.35)',
  activeMatchBorder: 'rgba(180, 93, 255, 0.7)',
  activeMatchColorOverviewRuler: 'rgba(180, 93, 255, 0.8)',
};

function createSearchBar(searchAddon, terminal) {
  const bar = document.createElement('div');
  bar.className = 'terminal-search-bar hidden';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terminal-search-input';
  input.placeholder = 'Find...';

  const count = document.createElement('span');
  count.className = 'terminal-search-count';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'terminal-search-btn';
  prevBtn.innerHTML = '&#x2191;';
  prevBtn.title = 'Previous (Shift+Enter)';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'terminal-search-btn';
  nextBtn.innerHTML = '&#x2193;';
  nextBtn.title = 'Next (Enter)';

  const caseBtn = document.createElement('button');
  caseBtn.className = 'terminal-search-toggle';
  caseBtn.textContent = 'Aa';
  caseBtn.title = 'Case Sensitive';

  const regexBtn = document.createElement('button');
  regexBtn.className = 'terminal-search-toggle';
  regexBtn.textContent = '.*';
  regexBtn.title = 'Regex';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'terminal-search-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Close (Esc)';

  bar.appendChild(input);
  bar.appendChild(count);
  bar.appendChild(prevBtn);
  bar.appendChild(nextBtn);
  bar.appendChild(caseBtn);
  bar.appendChild(regexBtn);
  bar.appendChild(closeBtn);

  let caseSensitive = false;
  let useRegex = false;

  function getOptions(incremental = false) {
    return { caseSensitive, regex: useRegex, incremental, decorations: SEARCH_DECORATIONS };
  }

  function doSearch() {
    const term = input.value;
    if (!term) { searchAddon.clearDecorations(); count.textContent = ''; return; }
    searchAddon.findNext(term, getOptions(true));
  }

  input.addEventListener('input', doSearch);

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const term = input.value;
      if (!term) return;
      if (e.shiftKey) searchAddon.findPrevious(term, getOptions());
      else searchAddon.findNext(term, getOptions());
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideSearch();
    }
  });

  prevBtn.addEventListener('click', () => {
    const term = input.value;
    if (term) searchAddon.findPrevious(term, getOptions());
  });

  nextBtn.addEventListener('click', () => {
    const term = input.value;
    if (term) searchAddon.findNext(term, getOptions());
  });

  caseBtn.addEventListener('click', () => {
    caseSensitive = !caseSensitive;
    caseBtn.classList.toggle('active', caseSensitive);
    doSearch();
  });

  regexBtn.addEventListener('click', () => {
    useRegex = !useRegex;
    regexBtn.classList.toggle('active', useRegex);
    doSearch();
  });

  function hideSearch() {
    bar.classList.add('hidden');
    searchAddon.clearDecorations();
    count.textContent = '';
    terminal.focus();
  }

  closeBtn.addEventListener('click', hideSearch);

  searchAddon.onDidChangeResults((e) => {
    if (e === undefined) { count.textContent = ''; return; }
    if (e.resultCount === 0) { count.textContent = 'No results'; return; }
    count.textContent = `${e.resultIndex + 1} of ${e.resultCount}`;
  });

  return { searchBar: bar, searchInput: input };
}

export function showTerminalSearch(tab) {
  if (!tab || tab.type !== 'terminal') return;
  const pane = getActivePaneOfTab(tab);
  if (!pane) return;
  pane.searchBar.classList.remove('hidden');
  pane.searchInput.focus();
  pane.searchInput.select();
}

function fitAllPanes(node) {
  if (!node) return;
  if (isPane(node)) {
    try {
      node.fitAddon.fit();
      const dims = node.fitAddon.proposeDimensions();
      if (dims && dims.cols && dims.rows) {
        invoke('resize_terminal', {
          id: node.ptyId,
          cols: dims.cols,
          rows: dims.rows,
        }).catch(() => {});
      }
    } catch { /* terminal not ready yet */ }
    return;
  }
  for (const child of node.children) fitAllPanes(child);
}
