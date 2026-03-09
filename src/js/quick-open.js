import { invoke } from '@tauri-apps/api/core';

const overlay = document.getElementById('quick-open');
const input = document.getElementById('quick-open-input');
const results = document.getElementById('quick-open-results');

let allFiles = [];
let selectedIndex = 0;
let onOpen = null;

export function initQuickOpen(openCallback) {
  onOpen = openCallback;

  let filterTimer = null;
  input.addEventListener('input', () => {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => filter(input.value), 50);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(selectedIndex + 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); select(selectedIndex - 1); }
    if (e.key === 'Enter') { e.preventDefault(); openSelected(); }
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });

  overlay.querySelector('.qo-backdrop').addEventListener('click', hide);
}

export async function showQuickOpen(projectPath, ignored) {
  try {
    allFiles = await invoke('list_all_files', { path: projectPath, ignored });
  } catch (e) {
    console.warn('Failed to list files:', e);
    allFiles = [];
  }

  input.value = '';
  selectedIndex = 0;
  overlay.classList.remove('hidden');
  input.focus();
  filter('');
}

function hide() {
  overlay.classList.add('hidden');
}

function filter(query) {
  const q = query.toLowerCase();
  let matches;

  if (!q) {
    matches = allFiles.slice(0, 50);
  } else {
    matches = allFiles
      .map(f => ({ path: f, score: fuzzyScore(f.toLowerCase(), q) }))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map(m => m.path);
  }

  results.innerHTML = '';
  selectedIndex = 0;

  for (let i = 0; i < matches.length; i++) {
    const el = document.createElement('div');
    el.className = `qo-item${i === 0 ? ' selected' : ''}`;

    const fileName = matches[i].split(/[\\/]/).pop();
    const dir = matches[i].substring(0, matches[i].length - fileName.length);

    const nameEl = document.createElement('span');
    nameEl.className = 'qo-name';
    nameEl.textContent = fileName;

    const pathEl = document.createElement('span');
    pathEl.className = 'qo-path';
    pathEl.textContent = dir;

    el.appendChild(nameEl);
    el.appendChild(pathEl);
    el.dataset.path = matches[i];
    el.addEventListener('click', () => { selectedIndex = i; openSelected(); });
    results.appendChild(el);
  }

  if (matches.length === 0 && q) {
    results.innerHTML = '<div class="qo-empty">No files found</div>';
  }
}

function select(idx) {
  const items = results.querySelectorAll('.qo-item');
  if (items.length === 0) return;
  selectedIndex = Math.max(0, Math.min(idx, items.length - 1));
  items.forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
  items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
}

function openSelected() {
  const items = results.querySelectorAll('.qo-item');
  if (items[selectedIndex]) {
    const path = items[selectedIndex].dataset.path;
    hide();
    if (onOpen) onOpen(path);
  }
}

function fuzzyScore(str, query) {
  let si = 0, qi = 0, score = 0, lastMatch = -1;
  while (si < str.length && qi < query.length) {
    if (str[si] === query[qi]) {
      score += 1;
      if (lastMatch === si - 1) score += 2;
      if (si === 0 || '/\\.'.includes(str[si - 1])) score += 3;
      lastMatch = si;
      qi++;
    }
    si++;
  }
  return qi === query.length ? score : 0;
}
