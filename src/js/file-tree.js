import { invoke } from '@tauri-apps/api/core';
import { generateManifest } from 'material-icon-theme';

const fileTreeEl = document.getElementById('file-tree');
const fileSearch = document.getElementById('file-search');
let rootPath = null;
let ignoredPatterns = null;
let onFileClick = null;
let onFileRenamed = null;
let onFileDeleted = null;

// Undo toast state
let activeToast = null;
let toastTimer = null;

// Git status cache: relative path → status code ("M", "A", "D", "U")
let gitStatusMap = {};
let gitRoot = null;
// Pre-computed set of dirty directory prefixes for O(1) folder status lookups
let dirtyDirs = new Set();

// Guard against concurrent loadDirectory calls (race condition → duplicate entries)
let loadGeneration = 0;

// Material icon theme manifest for file/folder icon resolution
const iconManifest = generateManifest();
const ICON_BASE = import.meta.env.DEV
  ? '/node_modules/material-icon-theme/icons/'
  : '/material-icons/';

export function setIgnoredPatterns(patterns) {
  ignoredPatterns = patterns;
}

export function setFileClickHandler(handler) {
  onFileClick = handler;
}

export function setFileRenamedHandler(handler) {
  onFileRenamed = handler;
}

export function setFileDeletedHandler(handler) {
  onFileDeleted = handler;
}

export function initFileTree() {
  // Filter input (debounced to avoid DOM thrash on fast typing)
  let filterTimer = null;
  fileSearch.addEventListener('input', () => {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterTree(fileSearch.value.toLowerCase());
    }, 150);
  });

  // Dismiss context menu on click anywhere
  document.addEventListener('click', () => {
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();
  });

  // Right-click on empty area of file tree → New File / New Folder at root
  fileTreeEl.addEventListener('contextmenu', (e) => {
    if (e.target === fileTreeEl && rootPath) {
      showContextMenu(e, null);
    }
  });
}

/// Collect paths of all currently expanded folders in the tree.
function getExpandedPaths() {
  const expanded = new Set();
  fileTreeEl.querySelectorAll('.tree-item[data-is-dir="true"]').forEach(item => {
    const chevron = item.querySelector('.tree-chevron');
    if (chevron && chevron.classList.contains('expanded')) {
      expanded.add(item.dataset.path);
    }
  });
  return expanded;
}

/// After rendering, re-expand folders that were previously open.
async function restoreExpandedPaths(expandedSet) {
  if (!expandedSet || expandedSet.size === 0) return;

  // Find all folder tree-items that should be expanded
  const items = fileTreeEl.querySelectorAll('.tree-item[data-is-dir="true"]');
  for (const item of items) {
    if (!expandedSet.has(item.dataset.path)) continue;

    const chevron = item.querySelector('.tree-chevron');
    const folderImg = item.querySelector('.tree-icon-img');
    const folderName = folderImg?.dataset.folderName || '';
    // The children container is the next sibling element
    const children = item.nextElementSibling;
    if (!chevron || !children || !children.classList.contains('tree-children')) continue;

    chevron.classList.add('expanded');
    chevron.textContent = '▾';
    children.classList.add('expanded');
    if (folderImg) folderImg.src = resolveFolderIcon(folderName, true);

    // Load children if not yet loaded
    if (children.dataset.loaded === 'false') {
      try {
        const ignored = ignoredPatterns || undefined;
        const subEntries = await invoke('read_directory', { path: item.dataset.path, ignored });
        const depth = (parseInt(item.style.paddingLeft) - 8) / 16;
        renderEntries(children, subEntries, depth + 1);
        children.dataset.loaded = 'true';
      } catch (e) {
        console.warn('Failed to reload expanded directory:', e);
      }
    }
  }

  // Recurse: after loading first-level expanded dirs, their children are now
  // in the DOM and may also need expanding (nested expanded folders).
  const stillNeeded = new Set();
  const allDirItems = fileTreeEl.querySelectorAll('.tree-item[data-is-dir="true"]');
  for (const item of allDirItems) {
    if (!expandedSet.has(item.dataset.path)) continue;
    const ch = item.querySelector('.tree-chevron');
    if (!ch || !ch.classList.contains('expanded')) stillNeeded.add(item.dataset.path);
  }
  if (stillNeeded.size > 0) {
    await restoreExpandedPaths(stillNeeded);
  }
}

export async function loadDirectory(path, preserveState = false) {
  rootPath = path;

  // Save expanded state before clearing
  const expandedPaths = preserveState ? getExpandedPaths() : null;

  // Save scroll position
  const scrollTop = fileTreeEl.scrollTop;

  fileTreeEl.innerHTML = '';

  // Increment generation so any in-flight call becomes stale
  const thisGen = ++loadGeneration;

  // Fetch git status in parallel with directory listing
  const gitPromise = invoke('git_status', { path }).then(result => {
    gitStatusMap = result.files;
    gitRoot = result.root;
    rebuildDirtyDirs();
  }).catch(e => {
    console.warn('Failed to fetch git status:', e);
    gitStatusMap = {};
    gitRoot = null;
    dirtyDirs.clear();
  });

  try {
    const ignored = ignoredPatterns || undefined;
    const [entries] = await Promise.all([
      invoke('read_directory', { path, ignored }),
      gitPromise,
    ]);

    // If another loadDirectory call started while we were awaiting, bail out
    // to prevent duplicate entries from appending to the same container
    if (thisGen !== loadGeneration) return;

    renderEntries(fileTreeEl, entries, 0);

    // Restore expanded folders and scroll position
    if (expandedPaths && expandedPaths.size > 0) {
      await restoreExpandedPaths(expandedPaths);
    }
    fileTreeEl.scrollTop = scrollTop;
  } catch (err) {
    if (thisGen !== loadGeneration) return;
    fileTreeEl.innerHTML = `<div style="padding:12px;color:#7a7a8a;">Failed to read directory</div>`;
  }
}

/// Refresh the tree while preserving expanded folder state and scroll position.
export async function refreshTree() {
  if (!rootPath) return;
  await loadDirectory(rootPath, true);
}

export async function refreshGitStatus() {
  if (!rootPath) return;
  try {
    const result = await invoke('git_status', { path: rootPath });
    gitStatusMap = result.files;
    gitRoot = result.root;
    rebuildDirtyDirs();
  } catch (e) {
    console.warn('Failed to refresh git status:', e);
    gitStatusMap = {};
    gitRoot = null;
    dirtyDirs.clear();
  }
  applyGitStatusToTree();
}

function getGitStatus(entryPath) {
  if (!gitRoot) return null;
  // Normalize to forward slashes and compute relative path from git root
  const normalized = entryPath.replace(/\\/g, '/');
  const root = gitRoot.replace(/\\/g, '/');
  const relative = normalized.startsWith(root + '/')
    ? normalized.slice(root.length + 1)
    : normalized.startsWith(root) ? normalized.slice(root.length + 1) : null;
  if (!relative) return null;
  return gitStatusMap[relative] || null;
}

/// Build the dirtyDirs set from gitStatusMap. Each changed file's parent
/// directory chain is added so getFolderGitStatus is O(1).
function rebuildDirtyDirs() {
  dirtyDirs.clear();
  for (const relativePath of Object.keys(gitStatusMap)) {
    const normalized = relativePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirtyDirs.add(parts.slice(0, i).join('/') + '/');
    }
  }
}

function getFolderGitStatus(entryPath) {
  if (!gitRoot || dirtyDirs.size === 0) return null;
  const normalized = entryPath.replace(/\\/g, '/');
  const root = gitRoot.replace(/\\/g, '/');
  const prefix = normalized.startsWith(root + '/')
    ? normalized.slice(root.length + 1) + '/'
    : null;
  if (!prefix) return null;
  return dirtyDirs.has(prefix) ? true : null;
}

function applyGitStatusToTree() {
  const items = fileTreeEl.querySelectorAll('.tree-item');
  items.forEach(item => {
    const path = item.dataset.path;
    const isDir = item.dataset.isDir === 'true';
    const nameEl = item.querySelector('.tree-name');
    const badge = item.querySelector('.git-badge');

    // Remove old badge and color
    if (badge) badge.remove();
    if (nameEl) nameEl.classList.remove('git-modified', 'git-untracked', 'git-added', 'git-deleted');

    if (isDir) {
      const dirty = getFolderGitStatus(path);
      const dot = item.querySelector('.git-dot');
      if (dot) dot.remove();
      if (dirty) {
        const dotEl = document.createElement('span');
        dotEl.className = 'git-dot';
        item.appendChild(dotEl);
      }
    } else {
      const status = getGitStatus(path);
      if (status && nameEl) {
        nameEl.classList.add(statusClass(status));
        const badgeEl = document.createElement('span');
        badgeEl.className = 'git-badge ' + statusClass(status);
        badgeEl.textContent = status;
        item.appendChild(badgeEl);
      }
    }
  });
}

function statusClass(status) {
  switch (status) {
    case 'M': return 'git-modified';
    case 'U': return 'git-untracked';
    case 'A': return 'git-added';
    case 'D': return 'git-deleted';
    default: return 'git-modified';
  }
}


function renderEntries(container, entries, depth) {
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.paddingLeft = `${8 + depth * 16}px`;
    item.dataset.path = entry.path;
    item.dataset.name = entry.name.toLowerCase();
    item.dataset.isDir = entry.is_dir;

    const chevron = document.createElement('span');
    chevron.className = entry.is_dir ? 'tree-chevron' : 'tree-chevron file-spacer';
    chevron.textContent = entry.is_dir ? '▸' : '';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    const img = document.createElement('img');
    img.className = 'tree-icon-img';
    if (entry.is_dir) {
      img.src = resolveFolderIcon(entry.name, false);
      img.dataset.folderName = entry.name.toLowerCase();
    } else {
      img.src = resolveFileIcon(entry.name);
    }
    icon.appendChild(img);

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = entry.name;

    item.appendChild(chevron);
    item.appendChild(icon);
    item.appendChild(name);

    // Git status indicators
    if (entry.is_dir) {
      if (getFolderGitStatus(entry.path)) {
        const dot = document.createElement('span');
        dot.className = 'git-dot';
        item.appendChild(dot);
      }
    } else {
      const gitSt = getGitStatus(entry.path);
      if (gitSt) {
        name.classList.add(statusClass(gitSt));
        const badge = document.createElement('span');
        badge.className = 'git-badge ' + statusClass(gitSt);
        badge.textContent = gitSt;
        item.appendChild(badge);
      }
    }

    if (entry.is_dir) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      children.dataset.loaded = 'false';

      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const isExpanded = chevron.classList.contains('expanded');
        const folderImg = item.querySelector('.tree-icon-img');

        if (isExpanded) {
          chevron.classList.remove('expanded');
          chevron.textContent = '▸';
          children.classList.remove('expanded');
          if (folderImg) folderImg.src = resolveFolderIcon(entry.name, false);
        } else {
          chevron.classList.add('expanded');
          chevron.textContent = '▾';
          children.classList.add('expanded');
          if (folderImg) folderImg.src = resolveFolderIcon(entry.name, true);

          // Lazy load
          if (children.dataset.loaded === 'false') {
            try {
              const ignored = ignoredPatterns || undefined;
              const subEntries = await invoke('read_directory', { path: entry.path, ignored });
              renderEntries(children, subEntries, depth + 1);
              children.dataset.loaded = 'true';
            } catch (e) {
              console.warn('Failed to load subdirectory:', e);
              children.innerHTML = `<div style="padding:4px 8px;color:#7a7a8a;font-size:12px;">Error loading</div>`;
            }
          }
        }
      });

      // Context menu for directories
      item.addEventListener('contextmenu', (e) => showContextMenu(e, entry));

      container.appendChild(item);
      container.appendChild(children);
    } else {
      // Click to open file (shift+click passes path to terminal)
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onFileClick) onFileClick(entry, e.shiftKey);
      });
      // Context menu for files
      item.addEventListener('contextmenu', (e) => showContextMenu(e, entry));
      container.appendChild(item);
    }
  }
}

// ── Inline prompt ──
function showPrompt(title, defaultValue = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'prompt-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'prompt-dialog';
    const label = document.createElement('div');
    label.className = 'prompt-label';
    label.textContent = title;
    const input = document.createElement('input');
    input.className = 'prompt-input';
    input.value = defaultValue;
    dialog.appendChild(label);
    dialog.appendChild(input);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    input.focus();
    if (defaultValue) {
      const dot = defaultValue.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : defaultValue.length);
    }
    const finish = v => { overlay.remove(); resolve(v); };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.stopPropagation(); finish(input.value.trim()); }
      if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
  });
}

// ── Undo toast ──
function dismissToast() {
  if (!activeToast) return;
  clearTimeout(toastTimer);
  toastTimer = null;
  const el = activeToast.element;
  activeToast = null;
  el.classList.add('dismissing');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

function showUndoToast(oldPath, newPath, oldName, newName, isDir) {
  // Replace any existing toast
  if (activeToast) {
    clearTimeout(toastTimer);
    activeToast.element.remove();
    activeToast = null;
  }

  const el = document.createElement('div');
  el.className = 'undo-toast';

  const msg = document.createElement('span');
  msg.className = 'undo-toast-message';
  msg.textContent = 'Renamed ';

  const nameEl = document.createElement('span');
  nameEl.className = 'undo-toast-name';
  nameEl.textContent = oldName;
  msg.appendChild(nameEl);

  const arrow = document.createTextNode(' \u2192 ');
  msg.appendChild(arrow);

  const newNameEl = document.createElement('span');
  newNameEl.className = 'undo-toast-name';
  newNameEl.textContent = newName;
  msg.appendChild(newNameEl);

  const undoBtn = document.createElement('button');
  undoBtn.className = 'undo-toast-btn';
  undoBtn.textContent = 'Undo';
  undoBtn.addEventListener('click', async () => {
    try {
      await invoke('rename_path', { oldPath: newPath, newPath: oldPath });
      if (onFileRenamed) onFileRenamed(newPath, oldPath, oldName, isDir);
      await refreshTree();
    } catch (err) {
      console.error('Undo rename failed:', err);
    }
    dismissToast();
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'undo-toast-dismiss';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', dismissToast);

  const timer = document.createElement('div');
  timer.className = 'undo-toast-timer';

  el.appendChild(msg);
  el.appendChild(undoBtn);
  el.appendChild(closeBtn);
  el.appendChild(timer);
  document.body.appendChild(el);

  activeToast = { element: el, oldPath, newPath, oldName, newName, isDir };
  toastTimer = setTimeout(dismissToast, 5000);
}

// ── Context menu ──
function addMenuItem(menu, label, action) {
  const item = document.createElement('div');
  item.className = 'context-menu-item';
  item.textContent = label;
  item.addEventListener('click', () => { menu.remove(); action(); });
  menu.appendChild(item);
}

function addSeparator(menu) {
  const sep = document.createElement('div');
  sep.className = 'context-menu-separator';
  menu.appendChild(sep);
}

function showContextMenu(e, entry) {
  e.preventDefault();
  e.stopPropagation();

  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  // Determine parent directory for new file/folder operations
  const parentDir = entry
    ? (entry.is_dir ? entry.path : entry.path.replace(/[\\/][^\\/]+$/, ''))
    : rootPath;
  const sep = (parentDir || '').includes('/') ? '/' : '\\';

  // New File / New Folder (always available)
  addMenuItem(menu, 'New File', async () => {
    const name = await showPrompt('New file name');
    if (!name) return;
    try {
      await invoke('create_file', { path: parentDir + sep + name });
      await refreshTree();
      if (onFileClick) onFileClick({ path: parentDir + sep + name, name, is_dir: false });
    } catch (err) { console.error(err); }
  });
  addMenuItem(menu, 'New Folder', async () => {
    const name = await showPrompt('New folder name');
    if (!name) return;
    try {
      await invoke('create_directory', { path: parentDir + sep + name });
      await refreshTree();
    } catch (err) { console.error(err); }
  });

  if (entry) {
    addSeparator(menu);

    // Rename
    addMenuItem(menu, 'Rename', async () => {
      const newName = await showPrompt('Rename to', entry.name);
      if (!newName || newName === entry.name) return;
      const dir = entry.path.replace(/[\\/][^\\/]+$/, '');
      const newPath = dir + sep + newName;
      try {
        await invoke('rename_path', { oldPath: entry.path, newPath });
        if (onFileRenamed) onFileRenamed(entry.path, newPath, newName, entry.is_dir);
        await refreshTree();
        showUndoToast(entry.path, newPath, entry.name, newName, entry.is_dir);
      } catch (err) { console.error(err); }
    });

    // Delete
    addMenuItem(menu, 'Delete', async () => {
      const { confirm } = await import('@tauri-apps/plugin-dialog');
      const confirmed = await confirm(
        `Delete "${entry.name}"${entry.is_dir ? ' and all contents' : ''}?`,
        { title: 'Volt', kind: 'warning' }
      );
      if (!confirmed) return;
      try {
        await invoke('delete_path', { path: entry.path });
        if (onFileDeleted) onFileDeleted(entry.path, entry.is_dir);
        await refreshTree();
      } catch (err) { console.error(err); }
    });

    addSeparator(menu);

    // Copy Path / Copy Relative Path
    addMenuItem(menu, 'Copy Path', () => {
      navigator.clipboard.writeText(entry.path);
    });
    addMenuItem(menu, 'Copy Relative Path', () => {
      const relative = rootPath ? entry.path.replace(rootPath, '').replace(/^[\\/]/, '') : entry.path;
      navigator.clipboard.writeText(relative);
    });

    addSeparator(menu);

    // Open in File Manager
    addMenuItem(menu, 'Open in File Manager', () => {
      invoke('open_in_file_manager', { path: entry.path });
    });
  }

  document.body.appendChild(menu);

  // Keep menu in viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  });
}

export function resolveFileIcon(fileName) {
  const nameLower = fileName.toLowerCase();

  // 1. Exact filename match (e.g. .gitignore, package.json, pubspec.yaml)
  if (iconManifest.fileNames[nameLower]) {
    return `${ICON_BASE}${iconManifest.fileNames[nameLower]}.svg`;
  }

  // 2. File extension match
  const ext = nameLower.includes('.') ? nameLower.split('.').pop() : '';
  if (ext && iconManifest.fileExtensions[ext]) {
    return `${ICON_BASE}${iconManifest.fileExtensions[ext]}.svg`;
  }

  // 3. Language ID fallback (covers yaml, js, ts, etc.)
  if (ext && iconManifest.languageIds[ext]) {
    return `${ICON_BASE}${iconManifest.languageIds[ext]}.svg`;
  }

  // 4. Default file icon
  return `${ICON_BASE}${iconManifest.file}.svg`;
}

function resolveFolderIcon(folderName, expanded) {
  const nameLower = folderName.toLowerCase();

  if (expanded) {
    if (iconManifest.folderNamesExpanded[nameLower]) {
      return `${ICON_BASE}${iconManifest.folderNamesExpanded[nameLower]}.svg`;
    }
    return `${ICON_BASE}${iconManifest.folderExpanded}.svg`;
  }

  if (iconManifest.folderNames[nameLower]) {
    return `${ICON_BASE}${iconManifest.folderNames[nameLower]}.svg`;
  }
  return `${ICON_BASE}${iconManifest.folder}.svg`;
}

function filterTree(query) {
  const items = fileTreeEl.querySelectorAll('.tree-item');
  const childContainers = fileTreeEl.querySelectorAll('.tree-children');

  if (!query) {
    // Show all, restore collapsed state
    items.forEach(item => item.style.display = '');
    childContainers.forEach(c => c.style.display = '');
    return;
  }

  // First hide everything
  items.forEach(item => item.style.display = 'none');

  // Show matching items and their parent chain
  items.forEach(item => {
    const name = item.dataset.name || '';
    if (name.includes(query)) {
      item.style.display = '';
      // Show parent containers up the tree
      let parent = item.parentElement;
      while (parent && parent !== fileTreeEl) {
        if (parent.classList.contains('tree-children')) {
          parent.style.display = 'block';
        }
        if (parent.classList.contains('tree-item')) {
          parent.style.display = '';
        }
        parent = parent.parentElement;
      }
    }
  });
}
