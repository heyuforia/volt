import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { initFileTree, loadDirectory, refreshTree, setIgnoredPatterns, setFileClickHandler, setFileRenamedHandler, setFileDeletedHandler, refreshGitStatus } from './file-tree.js';
import { initTerminals, createTerminalTab, getActiveTerminalCount, setTerminalConfig, addFileTab, findTabByFilePath, getActiveTab, getUnsavedFileTabs, getAllTabs, closeAllTabs, setActivationCallback, getTerminalConfig, renderTabs, activateTab, setTabCloseCallback, updateFileTabPath, getFileTabsByPathPrefix, forceCloseFileTab } from './terminal.js';
import { createEditorView, getEditorContent, markClean, replaceEditorContent, goToLine } from './editor.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { initStatusBar } from './status-bar.js';
import { initAnalyzer, startAnalyzer, stopAnalyzer } from './analyzer.js';
import { initEmulator, showEmulatorButton, hideEmulatorButton } from './emulator.js';
import { initSettings } from './settings.js';
import { initQuickOpen, showQuickOpen } from './quick-open.js';
import { initSearch, showSearch } from './search.js';

let currentFolder = null;
let sidebarVisible = true;
let projectType = null;
let config = null;

/** Shell-quote a file path to prevent accidental execution when pasted into a terminal.
 *  Uses single quotes: bash escapes embedded quotes with '\'', PowerShell with ''. */
const IS_WINDOWS_PLATFORM = navigator.platform.startsWith('Win');
function shellQuotePath(p) {
  if (/^[\w.\-/\\:]+$/.test(p)) return p;
  if (IS_WINDOWS_PLATFORM) {
    // PowerShell: single-quoted strings escape ' as ''
    return "'" + p.replace(/'/g, "''") + "'";
  }
  // Bash/zsh: break out of single quote, add escaped quote, re-enter
  return "'" + p.replace(/'/g, "'\\''" ) + "'";
}

const sidebar = document.getElementById('sidebar');
const sidebarResizer = document.getElementById('sidebar-resizer');
const welcomeHint = document.getElementById('welcome-hint');
const sidebarEmpty = document.getElementById('sidebar-empty');
const fileTree = document.getElementById('file-tree');
const sidebarSearch = document.getElementById('sidebar-search');
const btnRefreshTree = document.getElementById('btn-refresh-tree');
const terminalContainer = document.getElementById('terminal-container');
const statusFolder = document.getElementById('status-folder');
const statusProjectType = document.getElementById('status-project-type');

// ── Config (file-based via ~/.volt/config.json) ──

let configSaveTimer = null;
function saveConfigDebounced() {
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(() => {
    configSaveTimer = null;
    invoke('save_config', { config }).catch(e => console.warn('Failed to save config:', e));
  }, 500);
}

async function loadConfig() {
  try {
    config = await invoke('load_config');
  } catch (e) {
    console.warn('Failed to load config:', e);
    config = { recentFolders: [], lastFolder: null };
  }
  return config;
}

async function saveLastFolder(path) {
  try {
    if (!config) config = {};
    config.lastFolder = path;

    // Update recent folders (max 5, no duplicates, most recent first)
    if (!config.recentFolders) config.recentFolders = [];
    config.recentFolders = config.recentFolders.filter(f => f !== path);
    config.recentFolders.unshift(path);
    config.recentFolders = config.recentFolders.slice(0, 5);

    clearTimeout(configSaveTimer);
    await invoke('save_config', { config });
  } catch (e) { console.warn('Failed to save last folder:', e); }
}

// ── Open folder ──
async function openFolder(path) {
  if (!path) {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    path = selected;
  }

  // Warn about unsaved files before switching folders
  const unsaved = getUnsavedFileTabs();
  if (unsaved.length > 0) {
    const { confirm } = await import('@tauri-apps/plugin-dialog');
    const confirmed = await confirm(
      `You have ${unsaved.length} unsaved file${unsaved.length > 1 ? 's' : ''}. Switch folder anyway?`,
      { title: 'Volt', kind: 'warning' }
    );
    if (!confirmed) return;
  }

  // Per-folder single instance: if another Volt has this folder, focus it
  try {
    const alreadyOpen = await invoke('check_folder_instance', { folder: path });
    if (alreadyOpen) return; // Other instance was focused
  } catch (e) { console.warn('Failed to check folder instance:', e); }

  // Save tab state for current folder before switching
  saveTabState();

  // Close all existing tabs before switching
  await closeAllTabs();

  // Release previous folder lock before switching
  try { await invoke('release_folder_lock'); } catch (e) { console.warn('Failed to release folder lock:', e); }

  // Acquire per-folder lock BEFORE loading directory so validate_path
  // knows the new project root (acquire_folder_lock sets PROJECT_ROOT)
  try { await invoke('acquire_folder_lock', { folder: path }); } catch (e) { console.warn('Failed to acquire folder lock:', e); }

  currentFolder = path;
  await saveLastFolder(path);

  // Update UI — show workspace, hide welcome
  welcomeHint.classList.add('hidden');
  sidebar.classList.remove('welcome-hidden');
  sidebarResizer.classList.remove('welcome-hidden');
  document.getElementById('tab-bar').classList.remove('welcome-hidden');
  terminalContainer.classList.remove('welcome-hidden');
  sidebarEmpty.classList.add('hidden');
  fileTree.style.display = '';
  sidebarSearch.style.display = '';
  btnRefreshTree.style.display = '';
  statusFolder.textContent = path;

  // Update window title
  try {
    const folderName = path.split(/[\\/]/).pop();
    await getCurrentWindow().setTitle(`Volt \u2014 ${folderName}`);
  } catch (e) { console.warn('Failed to set window title:', e); }

  // Load file tree
  await loadDirectory(path);

  // Watch project directory for structural changes (new/deleted/renamed files)
  invoke('watch_directory', { path }).catch(e => console.warn('Failed to watch directory:', e));

  // Project type detection (drives tooling like emulators, status badge)
  try {
    projectType = await invoke('detect_project_type', { path });
    if (projectType) {
      statusProjectType.textContent = projectType.name;
      statusProjectType.classList.remove('hidden');
      if (projectType.hasEmulator) showEmulatorButton();
      else hideEmulatorButton();
    } else {
      statusProjectType.classList.add('hidden');
      hideEmulatorButton();
    }
  } catch (e) { console.warn('Failed to detect project type:', e); }

  // Start LSP for any supported language (auto-detected by Rust)
  await stopAnalyzer();
  await startAnalyzer(path);

  // Restore previously open file tabs for this folder
  await restoreTabState(path);
}

export function getCurrentFolder() {
  return currentFolder;
}

async function closeFolder() {
  if (!currentFolder) return;

  // Warn about unsaved files
  const unsaved = getUnsavedFileTabs();
  if (unsaved.length > 0) {
    const { confirm } = await import('@tauri-apps/plugin-dialog');
    const confirmed = await confirm(
      `You have ${unsaved.length} unsaved file${unsaved.length > 1 ? 's' : ''}. Close folder anyway?`,
      { title: 'Volt', kind: 'warning' }
    );
    if (!confirmed) return;
  }

  // Save tab state before closing
  saveTabState();

  // Close all tabs
  await closeAllTabs();

  // Release folder lock
  try { await invoke('release_folder_lock'); } catch (e) { console.warn('Failed to release folder lock:', e); }

  // Stop watching all files and directory
  invoke('unwatch_all_files').catch(e => console.warn('Failed to unwatch files:', e));
  invoke('unwatch_directory').catch(e => console.warn('Failed to unwatch directory:', e));

  // Clear save cooldowns so file-changed events aren't ignored in the next folder
  saveCooldowns.clear();

  // Stop analyzer
  await stopAnalyzer();

  // Clear config
  currentFolder = null;
  if (!config) config = {};
  config.lastFolder = null;
  clearTimeout(configSaveTimer);
  try { await invoke('save_config', { config }); } catch (e) { console.warn('Failed to save config:', e); }

  // Reset window title
  try { await getCurrentWindow().setTitle('Volt'); } catch (e) { console.warn('Failed to reset window title:', e); }

  // Return to welcome state
  welcomeHint.classList.remove('hidden');
  sidebar.classList.add('welcome-hidden');
  sidebarResizer.classList.add('welcome-hidden');
  document.getElementById('tab-bar').classList.add('welcome-hidden');
  terminalContainer.classList.add('welcome-hidden');
  statusFolder.textContent = '';
  statusProjectType.classList.add('hidden');
  projectType = null;
  hideEmulatorButton();
  renderRecents();
}

// ── Sidebar toggle ──
function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  sidebar.classList.toggle('collapsed', !sidebarVisible);
}

// ── Sidebar resize ──
function initSidebarResize() {
  let startX = 0;
  let startWidth = 0;

  sidebarResizer.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    sidebarResizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(150, Math.min(500, startWidth + delta));
      sidebar.style.width = `${newWidth}px`;
    };

    const onMouseUp = () => {
      sidebarResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ── Close warning ──
async function initCloseWarning() {
  try {
    const appWindow = getCurrentWindow();
    await appWindow.onCloseRequested(async (event) => {
      try {
        // Save tab + window state before close
        // saveTabState mutates config.folderStates synchronously,
        // then saveWindowState awaits saving the full config object
        saveTabState();
        await saveWindowState();

        const termCount = getActiveTerminalCount();
        const unsavedCount = getUnsavedFileTabs().length;
        if (termCount > 0 || unsavedCount > 0) {
          const { confirm } = await import('@tauri-apps/plugin-dialog');
          const parts = [];
          if (termCount > 0) parts.push(`${termCount} terminal${termCount > 1 ? 's' : ''} running`);
          if (unsavedCount > 0) parts.push(`${unsavedCount} unsaved file${unsavedCount > 1 ? 's' : ''}`);
          const confirmed = await confirm(
            `You have ${parts.join(' and ')}. Close anyway?`,
            { title: 'Volt', kind: 'warning' }
          );
          if (!confirmed) {
            event.preventDefault();
            return;
          }
        }

        // Release per-folder lock so other instances can open this folder
        try { await invoke('release_folder_lock'); } catch (e) { console.warn('Failed to release folder lock:', e); }
      } catch (e) {
        console.warn('Close handler error:', e);
      }
    });
  } catch (e) { console.warn('Failed to init close warning:', e); }
}

// ── Keyboard shortcuts ──
function changeFontSize(delta) {
  if (!config?.terminal) return;
  const newSize = Math.max(8, Math.min(32, (config.terminal.fontSize || 14) + delta));
  config.terminal.fontSize = newSize;
  setTerminalConfig(config.terminal);
  saveConfigDebounced();
}

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && e.key === 'o') {
      e.preventDefault();
      openFolder();
    }
    // Ctrl+Shift+O — Close Folder
    if (e.ctrlKey && e.shiftKey && e.key === 'O') {
      e.preventDefault();
      if (currentFolder) closeFolder();
    }
    if (e.ctrlKey && !e.shiftKey && e.key === 'b') {
      e.preventDefault();
      toggleSidebar();
    }
    if (e.ctrlKey && !e.shiftKey && e.key === 's') {
      const activeTab = getActiveTab();
      if (activeTab?.type === 'file') {
        e.preventDefault();
        saveActiveFile(activeTab);
      }
    }
    // Ctrl+P — Quick Open
    if (e.ctrlKey && !e.shiftKey && e.key === 'p') {
      e.preventDefault();
      if (currentFolder) {
        showQuickOpen(currentFolder, config?.ignoredPatterns);
      }
    }
    // Ctrl+Shift+F — Find in Files
    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      if (currentFolder) {
        showSearch(currentFolder, config?.ignoredPatterns);
      }
    }
    // Ctrl+= / Ctrl+- — Zoom
    if (e.ctrlKey && !e.shiftKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      changeFontSize(1);
    }
    if (e.ctrlKey && !e.shiftKey && e.key === '-') {
      e.preventDefault();
      changeFontSize(-1);
    }
    if (e.ctrlKey && !e.shiftKey && e.key === '0') {
      e.preventDefault();
      if (config?.terminal) {
        config.terminal.fontSize = 14;
        setTerminalConfig(config.terminal);
        saveConfigDebounced();
      }
    }
  });
}

// ── Window state persistence ──
async function applyWindowState() {
  if (!config || !config.window) return;
  try {
    const appWindow = getCurrentWindow();
    const { width, height, x, y, sidebarWidth, sidebarVisible: sv } = config.window;

    if (width && height) {
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      await appWindow.setSize(new LogicalSize(width, height));
    }
    if (x != null && y != null && x >= -100 && y >= -100 && x < 10000 && y < 10000) {
      const { LogicalPosition } = await import('@tauri-apps/api/dpi');
      await appWindow.setPosition(new LogicalPosition(x, y));
    }
    if (sidebarWidth) {
      sidebar.style.width = `${sidebarWidth}px`;
    }
    if (sv === false) {
      sidebarVisible = false;
      sidebar.classList.add('collapsed');
    }
  } catch (e) { console.warn('Failed to restore window state:', e); }
}

async function saveWindowState() {
  try {
    const appWindow = getCurrentWindow();
    const scaleFactor = await appWindow.scaleFactor();
    const physSize = await appWindow.innerSize();
    const physPos = await appWindow.outerPosition();
    const sWidth = sidebar.offsetWidth;

    const w = Math.round(physSize.width / scaleFactor);
    const h = Math.round(physSize.height / scaleFactor);
    const px = Math.round(physPos.x / scaleFactor);
    const py = Math.round(physPos.y / scaleFactor);

    // Don't save bogus values (minimized, off-screen, etc.)
    if (w < 100 || h < 100 || px < -500 || py < -500 || px > 10000 || py > 10000) return;

    if (!config) config = {};
    config.window = {
      width: w,
      height: h,
      x: px,
      y: py,
      sidebarWidth: sWidth,
      sidebarVisible: sidebarVisible,
    };
    clearTimeout(configSaveTimer);
    await invoke('save_config', { config });
  } catch (e) { console.warn('Failed to save window state:', e); }
}

// ── Drag and drop ──
function initDragDrop() {
  // Prevent default browser drop behavior
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
  });

  // Suppress default browser context menu globally.
  // File tree items call e.stopPropagation() to show their own menu.
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // Use Tauri's native drag-drop for folders and files
  try {
    import('@tauri-apps/api/webviewWindow').then(async (mod) => {
      const { getCurrentWebviewWindow } = mod;
      const webview = getCurrentWebviewWindow();
      await webview.onDragDropEvent(async (event) => {
        if (event.payload.type === 'drop' && event.payload.paths?.length > 0) {
          const path = event.payload.paths[0];
          // Check if it's a directory
          try {
            await invoke('read_directory', { path });
            openFolder(path);
          } catch {
            // It's a file — paste path into terminal if active, otherwise open in editor
            const tab = getActiveTab();
            if (tab?.type === 'terminal' && tab.ptyId && !tab.exited) {
              invoke('write_terminal', { id: tab.ptyId, data: shellQuotePath(path) }).catch(() => {});
            } else {
              const name = path.split(/[\\/]/).pop();
              openFile({ path, name, is_dir: false });
            }
          }
        }
      });
    }).catch(e => console.warn('Drag-drop setup failed:', e));
  } catch (e) { console.warn('Drag-drop import failed:', e); }
}

// ── File editor ──
let fileTabCounter = 0;
const breadcrumbBar = document.getElementById('breadcrumb-bar');
const breadcrumbPath = document.getElementById('breadcrumb-path');
const btnMdPreview = document.getElementById('btn-md-preview');
const openingFiles = new Set(); // prevents duplicate opens from rapid clicks
const saveCooldowns = new Map(); // path -> timestamp, ignore watcher events right after save
const autoSaveTimers = new Map(); // filePath -> timeout ID for debounced auto-save
const swapWriteTimers = new Map(); // filePath -> timeout ID for debounced swap writes
const lspChangeTimers = new Map(); // filePath -> timeout ID for debounced LSP didChange
const statusCursor = document.getElementById('status-cursor');

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tiff', 'tif']);

function isImageFile(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Configure marked for GFM
marked.setOptions({
  gfm: true,
  breaks: true,
});


async function saveActiveFile(tab) {
  if (!tab || tab.type !== 'file' || !tab.editorView) return;
  const content = getEditorContent(tab.editorView);
  try {
    // Mark cooldown so watcher ignores our own save
    saveCooldowns.set(tab.filePath, Date.now());
    await invoke('save_file', { path: tab.filePath, content });
    markClean(tab.editorView);
    tab.modified = false;
    renderTabs();
    // Clean up swap file and auto-save timer
    clearTimeout(autoSaveTimers.get(tab.filePath));
    autoSaveTimers.delete(tab.filePath);
    clearTimeout(swapWriteTimers.get(tab.filePath));
    swapWriteTimers.delete(tab.filePath);
    invoke('delete_swap_file', { path: tab.filePath }).catch(e => console.warn('Failed to delete swap file:', e));
    clearTimeout(lspChangeTimers.get(tab.filePath));
    lspChangeTimers.delete(tab.filePath);
    // Send final didChange (in case debounce timer hadn't fired yet), then didSave
    invoke('lsp_did_change', { path: tab.filePath, content }).catch(e => console.warn('LSP didChange failed:', e));
    invoke('lsp_did_save', { path: tab.filePath }).catch(e => console.warn('LSP didSave failed:', e));
    // Refresh git status indicators after save
    refreshGitStatus();
  } catch (err) {
    console.error('Failed to save file:', err);
  }
}

function scheduleAutoSave(tab) {
  const delay = config?.editor?.autoSaveDelay ?? 1500;

  // Debounce swap file write (crash recovery)
  clearTimeout(swapWriteTimers.get(tab.filePath));
  swapWriteTimers.set(tab.filePath, setTimeout(() => {
    if (tab.editorView) {
      invoke('write_swap_file', {
        path: tab.filePath,
        content: getEditorContent(tab.editorView),
      }).catch(e => console.warn('Failed to write swap file:', e));
    }
  }, 500));

  // Auto-save (only if enabled)
  if (config?.editor?.autoSave === false) return;
  clearTimeout(autoSaveTimers.get(tab.filePath));
  autoSaveTimers.set(tab.filePath, setTimeout(() => {
    if (tab.modified && tab.editorView) saveActiveFile(tab);
  }, delay));
}

function scheduleLspChange(tab) {
  clearTimeout(lspChangeTimers.get(tab.filePath));
  lspChangeTimers.set(tab.filePath, setTimeout(() => {
    if (tab.editorView) {
      const content = getEditorContent(tab.editorView);
      invoke('lsp_did_change', { path: tab.filePath, content })
        .catch(e => console.warn('LSP didChange failed:', e));
    }
  }, 300));
}

function migrateTimerKeys(oldPath, newPath) {
  if (autoSaveTimers.has(oldPath)) {
    autoSaveTimers.set(newPath, autoSaveTimers.get(oldPath));
    autoSaveTimers.delete(oldPath);
  }
  if (swapWriteTimers.has(oldPath)) {
    swapWriteTimers.set(newPath, swapWriteTimers.get(oldPath));
    swapWriteTimers.delete(oldPath);
  }
  if (saveCooldowns.has(oldPath)) {
    saveCooldowns.set(newPath, saveCooldowns.get(oldPath));
    saveCooldowns.delete(oldPath);
  }
  if (lspChangeTimers.has(oldPath)) {
    lspChangeTimers.set(newPath, lspChangeTimers.get(oldPath));
    lspChangeTimers.delete(oldPath);
  }
}

function handleFileRenamed(oldPath, newPath, newName, isDir) {
  if (isDir) {
    const affectedTabs = getFileTabsByPathPrefix(oldPath);
    for (const tab of affectedTabs) {
      const oldFilePath = tab.filePath;
      const newFilePath = newPath + tab.filePath.slice(oldPath.length);
      updateFileTabPath(oldFilePath, newFilePath, tab.name);
      invoke('unwatch_file', { path: oldFilePath }).catch(e => console.warn('Failed to unwatch file:', e));
      invoke('watch_file', { path: newFilePath }).catch(e => console.warn('Failed to watch file:', e));
      invoke('delete_swap_file', { path: oldFilePath }).catch(e => console.warn('Failed to delete swap file:', e));
      migrateTimerKeys(oldFilePath, newFilePath);
      // Notify LSP of path change
      invoke('lsp_did_close', { path: oldFilePath }).catch(e => console.warn('LSP didClose failed:', e));
      if (tab.editorView && tab.language) {
        const content = getEditorContent(tab.editorView);
        invoke('lsp_did_open', { path: newFilePath, language: tab.language, content })
          .catch(e => console.warn('LSP didOpen failed:', e));
      }
    }
  } else {
    const tab = updateFileTabPath(oldPath, newPath, newName);
    if (tab) {
      invoke('unwatch_file', { path: oldPath }).catch(e => console.warn('Failed to unwatch file:', e));
      invoke('watch_file', { path: newPath }).catch(e => console.warn('Failed to watch file:', e));
      invoke('delete_swap_file', { path: oldPath }).catch(e => console.warn('Failed to delete swap file:', e));
      migrateTimerKeys(oldPath, newPath);
      // Notify LSP of rename: close old URI, open new URI
      invoke('lsp_did_close', { path: oldPath }).catch(e => console.warn('LSP didClose failed:', e));
      if (tab.editorView && tab.language) {
        const content = getEditorContent(tab.editorView);
        invoke('lsp_did_open', { path: newPath, language: tab.language, content })
          .catch(e => console.warn('LSP didOpen failed:', e));
      }
    }
  }
}

function handleFileDeleted(path, isDir) {
  if (isDir) {
    const affectedTabs = getFileTabsByPathPrefix(path);
    for (const tab of affectedTabs) {
      forceCloseFileTab(tab.id);
    }
  } else {
    const tab = findTabByFilePath(path);
    if (tab) forceCloseFileTab(tab.id);
  }
}

export async function openFile(entry, targetLine) {
  // Dedup: if file already open, just activate it
  const existing = findTabByFilePath(entry.path);
  if (existing) {
    activateTab(existing.id);
    if (targetLine && existing.editorView) goToLine(existing.editorView, targetLine);
    return;
  }

  // Prevent duplicate opens from rapid clicks
  if (openingFiles.has(entry.path)) return;
  openingFiles.add(entry.path);

  // Image files — open as preview instead of text editor
  if (isImageFile(entry.path)) {
    try {
      await openImageFile(entry);
    } finally {
      openingFiles.delete(entry.path);
    }
    return;
  }

  let fileData;
  try {
    fileData = await invoke('read_file', { path: entry.path });
  } catch (e) {
    console.warn('Failed to read file:', e);
    openingFiles.delete(entry.path);
    return;
  }

  // Check for crash recovery swap file
  let recoveredContent = null;
  try {
    const swapContent = await invoke('check_swap_file', { path: entry.path });
    if (swapContent !== null && swapContent !== fileData.content) {
      const { confirm } = await import('@tauri-apps/plugin-dialog');
      const recover = await confirm(
        'A recovery file was found for this file. This may contain unsaved changes from a previous session.\n\nRestore recovered content?',
        { title: 'Recover unsaved changes?', kind: 'warning', okLabel: 'Recover', cancelLabel: 'Discard' }
      );
      if (recover) {
        recoveredContent = swapContent;
      } else {
        invoke('delete_swap_file', { path: entry.path }).catch(e => console.warn('Failed to delete swap file:', e));
      }
    }
  } catch (e) { console.warn('Failed to check swap file:', e); }

  fileTabCounter++;
  const tabId = `file-${fileTabCounter}`;

  const wrapper = document.createElement('div');
  wrapper.className = 'editor-wrapper';
  wrapper.id = tabId;
  terminalContainer.appendChild(wrapper);

  const cfg = getTerminalConfig();

  const tab = {
    id: tabId,
    type: 'file',
    name: fileData.file_name,
    filePath: entry.path,
    language: fileData.language,
    wrapper,
    editorView: null,
    modified: false,
  };

  const onModified = (isModified) => {
    tab.modified = isModified;
    renderTabs();
    if (isModified) scheduleAutoSave(tab);
  };

  const onCursorChange = (line, col) => {
    if (tab.wrapper.classList.contains('active')) {
      statusCursor.textContent = `Ln ${line}, Col ${col}`;
    }
  };

  const onDocChange = () => {
    scheduleLspChange(tab);
  };

  let view;
  try {
    view = await createEditorView(
      fileData.content,
      fileData.language,
      wrapper,
      cfg.fontSize,
      onModified,
      onCursorChange,
      onDocChange
    );
  } catch (e) {
    console.warn('Failed to create editor view:', e);
    wrapper.remove();
    openingFiles.delete(entry.path);
    return;
  }
  tab.editorView = view;

  // If recovering from swap, replace editor content but keep disk content as "original"
  // so the editor correctly shows as modified (swap content != disk content)
  if (recoveredContent !== null) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: recoveredContent },
    });
  }

  addFileTab(tab);
  openingFiles.delete(entry.path);

  // Jump to target line if specified (e.g. from search results)
  if (targetLine && view) goToLine(view, targetLine);

  // Start watching for external changes
  invoke('watch_file', { path: entry.path }).catch(e => console.warn('Failed to watch file:', e));

  // Notify LSP that this document is now open
  const openContent = recoveredContent !== null ? recoveredContent : fileData.content;
  invoke('lsp_did_open', { path: entry.path, language: fileData.language, content: openContent })
    .catch(e => console.warn('LSP didOpen failed:', e));
}

async function openImageFile(entry) {
  let imageData;
  try {
    imageData = await invoke('read_image_file', { path: entry.path });
  } catch (err) {
    console.error('Failed to read image:', err);
    return;
  }

  fileTabCounter++;
  const tabId = `file-${fileTabCounter}`;

  const wrapper = document.createElement('div');
  wrapper.className = 'editor-wrapper';
  wrapper.id = tabId;

  const preview = document.createElement('div');
  preview.className = 'image-preview';

  const img = document.createElement('img');
  img.src = `data:${imageData.mime};base64,${imageData.data}`;

  const info = document.createElement('div');
  info.className = 'image-info';

  img.onload = () => {
    info.textContent = `${img.naturalWidth} × ${img.naturalHeight}  ·  ${formatFileSize(imageData.size)}`;
  };
  img.onerror = () => {
    info.textContent = 'Failed to load image';
  };

  preview.appendChild(img);
  preview.appendChild(info);
  wrapper.appendChild(preview);
  terminalContainer.appendChild(wrapper);

  const tab = {
    id: tabId,
    type: 'file',
    name: imageData.file_name,
    filePath: entry.path,
    wrapper,
    editorView: null,
    modified: false,
    isImage: true,
  };

  addFileTab(tab);
}

function updateBreadcrumb(filePath) {
  if (!filePath || !currentFolder) {
    breadcrumbBar.classList.add('hidden');
    return;
  }

  const normalFile = filePath.replace(/\\/g, '/');
  const normalFolder = currentFolder.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  const relative = normalFile.startsWith(normalFolder)
    ? normalFile.slice(normalFolder.length)
    : filePath.split(/[\\/]/).pop();
  const parts = relative.split('/');

  breadcrumbPath.innerHTML = '';
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-separator';
      sep.textContent = '\u203A';
      breadcrumbPath.appendChild(sep);
    }
    const seg = document.createElement('span');
    seg.className = 'breadcrumb-segment';
    seg.textContent = part;
    breadcrumbPath.appendChild(seg);
  });

  // Show/hide markdown preview button
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(filePath);
  btnMdPreview.style.display = isMarkdown ? 'inline-flex' : 'none';

  breadcrumbBar.classList.remove('hidden');
}

function toggleMarkdownPreview() {
  const tab = getActiveTab();
  if (!tab || tab.type !== 'file' || !tab.editorView) return;

  tab.previewActive = !tab.previewActive;
  btnMdPreview.classList.toggle('active', tab.previewActive);

  if (tab.previewActive) {
    // Create or reuse preview container
    let preview = tab.wrapper.querySelector('.md-preview');
    if (!preview) {
      preview = document.createElement('div');
      preview.className = 'md-preview';
      tab.wrapper.appendChild(preview);
    }

    // Render markdown from current editor content
    const content = getEditorContent(tab.editorView);
    preview.innerHTML = DOMPurify.sanitize(marked.parse(content), {
      ALLOWED_TAGS: [
        'h1','h2','h3','h4','h5','h6','p','br','hr','ul','ol','li',
        'a','strong','em','b','i','code','pre','blockquote',
        'table','thead','tbody','tr','th','td',
        'img','del','sup','sub','mark','details','summary',
        'dl','dt','dd','kbd','s','small',
      ],
      ALLOWED_ATTR: ['href','src','alt','title','id','align','colspan','rowspan','open'],
      ALLOW_DATA_ATTR: false,
    });

    // Save editor scroll position before hiding
    const cmEl = tab.wrapper.querySelector('.cm-editor');
    if (cmEl) {
      tab._savedScrollTop = tab.editorView.scrollDOM.scrollTop;
      cmEl.style.display = 'none';
    }
    preview.classList.add('active');
  } else {
    // Show editor, hide preview
    const cmEl = tab.wrapper.querySelector('.cm-editor');
    if (cmEl) {
      cmEl.style.display = '';
      // Restore editor scroll position after unhiding
      if (tab._savedScrollTop != null) {
        requestAnimationFrame(() => {
          tab.editorView.scrollDOM.scrollTop = tab._savedScrollTop;
        });
      }
    }
    const preview = tab.wrapper.querySelector('.md-preview');
    if (preview) preview.classList.remove('active');
  }
}

// ── Tab state persistence (per folder) ──

function saveTabState() {
  if (!currentFolder || !config) return;

  const allTabs = getAllTabs();
  const activeTab = getActiveTab();
  const activeIndex = activeTab ? allTabs.indexOf(activeTab) : null;

  const tabs = allTabs.map(tab => {
    if (tab.type === 'terminal') {
      return { type: 'terminal' };
    }
    let cursorLine = 1;
    if (tab.editorView) {
      const pos = tab.editorView.state.selection.main.head;
      cursorLine = tab.editorView.state.doc.lineAt(pos).number;
    }
    return { type: 'file', path: tab.filePath, cursorLine };
  });

  if (!config.folderStates) config.folderStates = {};
  config.folderStates[currentFolder] = {
    tabs,
    activeIndex: activeIndex >= 0 ? activeIndex : null,
  };

  saveConfigDebounced();
}

async function restoreTabState(folderPath) {
  const state = config?.folderStates?.[folderPath];
  if (!state?.tabs?.length) return;

  // Restore tabs in order (sequentially to preserve position)
  for (const saved of state.tabs) {
    if (saved.type === 'terminal') {
      await createTerminalTab();
    } else if (saved.type === 'file') {
      const name = saved.path.split(/[\\/]/).pop();
      await openFile({ path: saved.path, name, is_dir: false }, saved.cursorLine);
    }
  }

  // Activate the previously active tab
  if (state.activeIndex != null) {
    const allTabs = getAllTabs();
    if (state.activeIndex < allTabs.length) {
      activateTab(allTabs[state.activeIndex].id);
    }
  }
}

// ── Recent folders ──
const welcomeRecents = document.getElementById('welcome-recents');

function renderRecents() {
  if (!config?.recentFolders?.length) {
    welcomeRecents.classList.add('hidden');
    return;
  }

  welcomeRecents.innerHTML = '';
  welcomeRecents.classList.remove('hidden');

  const header = document.createElement('div');
  header.className = 'recents-header';

  const title = document.createElement('span');
  title.textContent = 'Recent';
  header.appendChild(title);

  const clearBtn = document.createElement('button');
  clearBtn.className = 'recents-clear';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    config.recentFolders = [];
    saveConfigDebounced();
    renderRecents();
  });
  header.appendChild(clearBtn);
  welcomeRecents.appendChild(header);

  for (const folder of config.recentFolders) {
    const item = document.createElement('div');
    item.className = 'recents-item';

    const name = document.createElement('span');
    name.className = 'recents-name';
    name.textContent = folder.split(/[\\/]/).pop();

    const path = document.createElement('span');
    path.className = 'recents-path';
    path.textContent = folder;

    item.appendChild(name);
    item.appendChild(path);
    item.addEventListener('click', () => openFolder(folder));
    welcomeRecents.appendChild(item);
  }
}

// ── Init ──
function showWarningToast(message) {
  const el = document.createElement('div');
  el.className = 'undo-toast';
  const msg = document.createElement('span');
  msg.className = 'undo-toast-message';
  msg.textContent = message;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'undo-toast-dismiss';
  closeBtn.textContent = '\u00d7';
  const timer = document.createElement('div');
  timer.className = 'undo-toast-timer';
  timer.style.animationDuration = '8s';
  el.appendChild(msg);
  el.appendChild(closeBtn);
  el.appendChild(timer);
  document.body.appendChild(el);
  const dismiss = () => {
    el.classList.add('dismissing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  closeBtn.addEventListener('click', dismiss);
  setTimeout(dismiss, 8000);
}

async function init() {
  await loadConfig();

  // Check if config was recovered from corruption
  try {
    const recovered = await invoke('check_config_health');
    if (recovered) {
      console.warn('Config was corrupt — backed up to config.json.bak, using defaults');
      showWarningToast('Config was corrupt — backed up to config.json.bak, using defaults');
    }
  } catch (e) { console.warn('Failed to check config health:', e); }

  initKeyboardShortcuts();
  initSidebarResize();
  initFileTree();
  await initTerminals();
  initStatusBar();
  initAnalyzer(config?.diagnosticsPanelHeight, (height) => {
    if (!config) config = {};
    config.diagnosticsPanelHeight = height;
    saveConfigDebounced();
  }, () => {
    // On analyzer restart: re-send didOpen for all open file tabs
    for (const tab of getAllTabs()) {
      if (tab.type === 'file' && tab.editorView && tab.language) {
        const content = getEditorContent(tab.editorView);
        invoke('lsp_did_open', { path: tab.filePath, language: tab.language, content })
          .catch(e => console.warn('LSP didOpen failed:', e));
      }
    }
  });
  initEmulator();
  if (config?.terminal) setTerminalConfig(config.terminal);
  if (config?.ignoredPatterns) setIgnoredPatterns(config.ignoredPatterns);
  initSettings(() => config, (newConfig) => {
    config = newConfig;
    if (newConfig?.terminal) setTerminalConfig(newConfig.terminal);
    if (newConfig?.ignoredPatterns) setIgnoredPatterns(newConfig.ignoredPatterns);
  });
  initDragDrop();

  // Quick Open (Ctrl+P) — open selected file
  initQuickOpen((relativePath) => {
    if (!currentFolder) return;
    const sep = currentFolder.includes('/') ? '/' : '\\';
    const fullPath = currentFolder + sep + relativePath.replace(/[\\/]/g, sep);
    const name = relativePath.split(/[\\/]/).pop();
    openFile({ path: fullPath, name, is_dir: false });
  });

  // Find in Files (Ctrl+Shift+F) — open result at line
  initSearch((filePath, lineNumber) => {
    const name = filePath.split(/[\\/]/).pop();
    openFile({ path: filePath, name, is_dir: false }, lineNumber);
  });

  // Wire file click handler (shift+click pastes path into active terminal)
  setFileClickHandler((entry, shiftKey) => {
    if (entry.is_dir) return;
    if (shiftKey) {
      const tab = getActiveTab();
      if (tab?.type === 'terminal' && tab.ptyId && !tab.exited) {
        invoke('write_terminal', { id: tab.ptyId, data: shellQuotePath(entry.path) }).catch(() => {});
        return;
      }
    }
    openFile(entry);
  });

  // Update open tabs when files are renamed or deleted via context menu
  setFileRenamedHandler(handleFileRenamed);
  setFileDeletedHandler(handleFileDeleted);

  // Unwatch file when its tab is closed
  setTabCloseCallback((tab) => {
    if (tab.type === 'file' && tab.filePath) {
      invoke('unwatch_file', { path: tab.filePath }).catch(e => console.warn('Failed to unwatch file:', e));
      invoke('delete_swap_file', { path: tab.filePath }).catch(e => console.warn('Failed to delete swap file:', e));
      invoke('lsp_did_close', { path: tab.filePath }).catch(e => console.warn('LSP didClose failed:', e));
      clearTimeout(autoSaveTimers.get(tab.filePath));
      autoSaveTimers.delete(tab.filePath);
      clearTimeout(swapWriteTimers.get(tab.filePath));
      swapWriteTimers.delete(tab.filePath);
      clearTimeout(lspChangeTimers.get(tab.filePath));
      lspChangeTimers.delete(tab.filePath);
      saveCooldowns.delete(tab.filePath);
    }
  });

  // Listen for external file changes and auto-reload
  await listen('file-changed', async (event) => {
    const changedPath = event.payload;
    const tab = findTabByFilePath(changedPath);
    if (!tab || !tab.editorView) return;

    // Ignore if we just saved this file (cooldown 2 seconds)
    const savedAt = saveCooldowns.get(changedPath);
    if (savedAt && Date.now() - savedAt < 2000) return;
    saveCooldowns.delete(changedPath);

    // Don't reload if the user has unsaved edits
    if (tab.modified) return;

    // Read the updated content from disk
    try {
      const fileData = await invoke('read_file', { path: changedPath });
      const currentContent = getEditorContent(tab.editorView);
      if (fileData.content !== currentContent) {
        replaceEditorContent(tab.editorView, fileData.content);
      }
    } catch (e) { console.warn('Failed to reload changed file:', e); }
  });

  // Listen for directory structure changes (new/deleted/renamed files) and refresh tree
  let dirChangeTimer = null;
  await listen('directory-changed', () => {
    // Debounce: batch rapid filesystem events into a single refresh
    if (dirChangeTimer) clearTimeout(dirChangeTimer);
    dirChangeTimer = setTimeout(() => {
      dirChangeTimer = null;
      if (currentFolder) refreshTree();
    }, 300);
  });

  // Breadcrumb + cursor position updates on tab switch
  setActivationCallback((tab) => {
    if (tab?.type === 'file') {
      updateBreadcrumb(tab.filePath);

      if (tab.isImage) {
        statusCursor.classList.add('hidden');
      } else {
        statusCursor.classList.remove('hidden');

        // Show current cursor position
        if (tab.editorView) {
          const pos = tab.editorView.state.selection.main.head;
          const line = tab.editorView.state.doc.lineAt(pos);
          statusCursor.textContent = `Ln ${line.number}, Col ${pos - line.from + 1}`;
        }

        // Sync preview button with this tab's preview state
        btnMdPreview.classList.toggle('active', !!tab.previewActive);
        const cmEl = tab.wrapper.querySelector('.cm-editor');
        const preview = tab.wrapper.querySelector('.md-preview');
        if (tab.previewActive) {
          if (cmEl) cmEl.style.display = 'none';
          if (preview) preview.classList.add('active');
        } else {
          if (cmEl) {
            cmEl.style.display = '';
            if (tab._savedScrollTop != null) {
              requestAnimationFrame(() => {
                tab.editorView.scrollDOM.scrollTop = tab._savedScrollTop;
              });
            }
          }
          if (preview) preview.classList.remove('active');
        }
      }
    } else {
      breadcrumbBar.classList.add('hidden');
      statusCursor.classList.add('hidden');
    }
  });

  // Markdown preview toggle
  btnMdPreview.addEventListener('click', toggleMarkdownPreview);

  // Wire up buttons
  document.getElementById('btn-open-folder').addEventListener('click', () => openFolder());
  document.getElementById('btn-open-folder-large').addEventListener('click', () => openFolder());
  document.getElementById('btn-open-folder-welcome').addEventListener('click', () => openFolder());
  document.getElementById('btn-refresh-tree').addEventListener('click', () => {
    if (currentFolder) loadDirectory(currentFolder);
  });
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('sidebar-title').addEventListener('click', closeFolder);

  // Restore window state from config
  await applyWindowState();

  // Close warning + save state on close (async, non-blocking)
  initCloseWarning();

  // Always start in welcome state — openFolder() reveals workspace UI on success
  sidebar.classList.add('welcome-hidden');
  sidebarResizer.classList.add('welcome-hidden');
  document.getElementById('tab-bar').classList.add('welcome-hidden');
  terminalContainer.classList.add('welcome-hidden');

  // Inject version from build config
  const versionEl = document.getElementById('welcome-version');
  if (versionEl) versionEl.textContent = 'v' + __APP_VERSION__;

  // Render recent folders on welcome screen
  renderRecents();

  // Auto-reopen last folder
  if (config && config.lastFolder) {
    try {
      await openFolder(config.lastFolder);
    } catch (e) { console.warn('Failed to reopen last folder:', e); }
  }

  // Save window state on resize/move (debounced, only when changed)
  let resizeSaveTimer = null;
  window.addEventListener('resize', () => {
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(saveWindowState, 1000);
  });
}

init();
