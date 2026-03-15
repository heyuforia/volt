import { invoke } from '@tauri-apps/api/core';

const overlay = document.getElementById('search-panel');
const input = document.getElementById('search-input');
const resultsEl = document.getElementById('search-results');
const statusEl = document.getElementById('search-status');
const regexBtn = document.getElementById('search-regex');

let onOpenResult = null;
let searchTimeout = null;
let currentProject = null;
let currentIgnored = null;
let searchGeneration = 0;
let regexEnabled = false;

export function initSearch(openCallback) {
  onOpenResult = openCallback;

  input.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(doSearch, 300);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });

  regexBtn.addEventListener('click', () => {
    regexEnabled = !regexEnabled;
    regexBtn.classList.toggle('active', regexEnabled);
    // Re-run search with new mode
    if (input.value.trim()) {
      if (searchTimeout) clearTimeout(searchTimeout);
      doSearch();
    }
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
    const response = await invoke('search_in_files', {
      path: currentProject,
      query,
      ignored: currentIgnored,
      isRegex: regexEnabled,
    });
    if (thisGen !== searchGeneration) return; // Superseded by newer search
    renderResults(response.results, query, response.truncated);
  } catch (e) {
    if (thisGen !== searchGeneration) return;
    console.warn('Search failed:', e);
    // Show user-friendly error for invalid regex
    const errStr = String(e);
    if (regexEnabled && errStr.includes('Invalid regex')) {
      statusEl.textContent = errStr;
    } else {
      statusEl.textContent = 'Search failed';
    }
  }
}

function renderResults(results, query, truncated) {
  resultsEl.innerHTML = '';

  if (results.length === 0) {
    statusEl.textContent = 'No results found';
    return;
  }

  statusEl.textContent = `${results.length}${truncated ? '+' : ''} results`;

  // Group by file
  const groups = new Map();
  for (const r of results) {
    if (!groups.has(r.path)) groups.set(r.path, []);
    groups.get(r.path).push(r);
  }

  const fragment = document.createDocumentFragment();

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
      let lastEnd = 0;
      let found = false;

      if (regexEnabled) {
        // Regex highlighting: use the query as a regex pattern
        try {
          const re = new RegExp(query, 'gi');
          let m;
          while ((m = re.exec(line)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            found = true;
            if (m.index > lastEnd) {
              content.appendChild(document.createTextNode(line.substring(lastEnd, m.index)));
            }
            const mark = document.createElement('mark');
            mark.textContent = m[0];
            content.appendChild(mark);
            lastEnd = m.index + m[0].length;
          }
        } catch {
          // Invalid regex on frontend — fall through to plain text
        }
      } else {
        // Literal case-insensitive highlighting
        const lineLower = line.toLowerCase();
        const queryLower = query.toLowerCase();
        let searchFrom = 0;
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

    fragment.appendChild(group);
  }

  resultsEl.appendChild(fragment);
}
