import { invoke } from '@tauri-apps/api/core';

const overlay = document.getElementById('search-panel');
const input = document.getElementById('search-input');
const resultsEl = document.getElementById('search-results');
const statusEl = document.getElementById('search-status');

let onOpenResult = null;
let searchTimeout = null;
let currentProject = null;
let currentIgnored = null;
let searchGeneration = 0;

export function initSearch(openCallback) {
  onOpenResult = openCallback;

  input.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(doSearch, 300);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });

  document.getElementById('search-close').addEventListener('click', hide);
  overlay.querySelector('.search-backdrop').addEventListener('click', hide);
}

export function showSearch(projectPath, ignored) {
  currentProject = projectPath;
  currentIgnored = ignored;
  input.value = '';
  resultsEl.innerHTML = '';
  statusEl.textContent = '';
  overlay.classList.remove('hidden');
  input.focus();
}

function hide() {
  overlay.classList.add('hidden');
}

async function doSearch() {
  const query = input.value.trim();
  if (!query || !currentProject) {
    resultsEl.innerHTML = '';
    statusEl.textContent = '';
    return;
  }

  statusEl.textContent = 'Searching...';
  resultsEl.innerHTML = '';

  const thisGen = ++searchGeneration;
  try {
    const results = await invoke('search_in_files', {
      path: currentProject,
      query,
      ignored: currentIgnored,
    });
    if (thisGen !== searchGeneration) return; // Superseded by newer search
    renderResults(results, query);
  } catch (e) {
    if (thisGen !== searchGeneration) return;
    console.warn('Search failed:', e);
    statusEl.textContent = 'Search failed';
  }
}

function renderResults(results, query) {
  resultsEl.innerHTML = '';

  if (results.length === 0) {
    statusEl.textContent = 'No results found';
    return;
  }

  statusEl.textContent = `${results.length}${results.length >= 200 ? '+' : ''} results`;

  // Group by file
  const groups = new Map();
  for (const r of results) {
    if (!groups.has(r.path)) groups.set(r.path, []);
    groups.get(r.path).push(r);
  }

  for (const [, matches] of groups) {
    const group = document.createElement('div');
    group.className = 'search-group';

    const header = document.createElement('div');
    header.className = 'search-file-header';

    const nameEl = document.createElement('span');
    nameEl.textContent = matches[0].file_name;
    header.appendChild(nameEl);

    const badge = document.createElement('span');
    badge.className = 'search-count-badge';
    badge.textContent = matches.length;
    header.appendChild(badge);

    group.appendChild(header);

    for (const match of matches) {
      const row = document.createElement('div');
      row.className = 'search-result-row';

      const lineNum = document.createElement('span');
      lineNum.className = 'search-line-num';
      lineNum.textContent = match.line_number;

      const content = document.createElement('span');
      content.className = 'search-line-content';

      const line = match.line_content;
      const lineLower = line.toLowerCase();
      const queryLower = query.toLowerCase();
      let lastEnd = 0;
      let searchFrom = 0;
      let found = false;
      while (searchFrom < lineLower.length) {
        const idx = lineLower.indexOf(queryLower, searchFrom);
        if (idx === -1) break;
        found = true;
        if (idx > lastEnd) {
          content.appendChild(document.createTextNode(line.substring(lastEnd, idx)));
        }
        const mark = document.createElement('mark');
        mark.textContent = line.substring(idx, idx + query.length);
        content.appendChild(mark);
        lastEnd = idx + query.length;
        searchFrom = lastEnd;
      }
      if (found && lastEnd < line.length) {
        content.appendChild(document.createTextNode(line.substring(lastEnd)));
      } else if (!found) {
        content.textContent = line;
      }

      row.appendChild(lineNum);
      row.appendChild(content);
      row.addEventListener('click', () => {
        hide();
        if (onOpenResult) onOpenResult(match.path, match.line_number);
      });
      group.appendChild(row);
    }

    resultsEl.appendChild(group);
  }
}
