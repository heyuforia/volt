import { invoke } from '@tauri-apps/api/core';
import { escapeHtml, escapeAttr } from './utils.js';

let emulators = [];
let dropdownVisible = false;
let fetched = false;

const statusRight = document.getElementById('status-right');
let emulatorBtn = null;
let dropdownEl = null;

export function initEmulator() {
  emulatorBtn = document.createElement('button');
  emulatorBtn.id = 'status-emulator';
  emulatorBtn.className = 'status-emulator-btn hidden';
  emulatorBtn.textContent = 'No Device';
  emulatorBtn.addEventListener('click', toggleDropdown);
  statusRight.appendChild(emulatorBtn);

  dropdownEl = document.createElement('div');
  dropdownEl.id = 'emulator-dropdown';
  dropdownEl.className = 'emulator-dropdown hidden';
  document.body.appendChild(dropdownEl);

  document.addEventListener('click', (e) => {
    if (dropdownVisible && !dropdownEl.contains(e.target) && e.target !== emulatorBtn) {
      hideDropdown();
    }
  });
}

export function showEmulatorButton() {
  emulatorBtn.classList.remove('hidden');
  // Pre-fetch emulators in background so dropdown opens instantly
  if (!fetched) {
    refreshEmulators();
  }
}

export function hideEmulatorButton() {
  emulatorBtn.classList.add('hidden');
  hideDropdown();
}

function toggleDropdown() {
  if (dropdownVisible) {
    hideDropdown();
  } else {
    showDropdown();
  }
}

function showDropdown() {
  dropdownVisible = true;
  dropdownEl.classList.remove('hidden');

  const rect = emulatorBtn.getBoundingClientRect();
  dropdownEl.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  dropdownEl.style.right = `${window.innerWidth - rect.right}px`;

  // Render immediately from cache
  renderDropdown();

  // Refresh in background
  refreshEmulators().then(() => {
    if (dropdownVisible) renderDropdown();
  });
}

function hideDropdown() {
  dropdownVisible = false;
  dropdownEl.classList.add('hidden');
}

async function refreshEmulators() {
  try {
    emulators = await invoke('list_emulators');
    fetched = true;
  } catch (e) {
    console.warn('Failed to list emulators:', e);
    emulators = [];
  }
}

function renderDropdown() {
  // Filter to Android emulators only
  const androidEmulators = emulators.filter(e =>
    e.platform.toLowerCase().includes('android')
  );

  let bodyHtml = '';
  if (androidEmulators.length > 0) {
    bodyHtml = androidEmulators.map(e => `
      <div class="emu-card">
        <div class="emu-card-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <rect x="5" y="8" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.4"/>
            <path d="M9 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.4"/>
            <circle cx="9.5" cy="13" r="1" fill="currentColor"/>
            <circle cx="14.5" cy="13" r="1" fill="currentColor"/>
          </svg>
        </div>
        <div class="emu-card-info">
          <span class="emu-card-name">${escapeHtml(e.name)}</span>
          <span class="emu-card-platform">${escapeHtml(e.platform)}</span>
        </div>
        <div class="emu-card-actions">
          <button class="emu-launch" data-id="${escapeAttr(e.id)}" data-cold="false" title="Launch">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 2.5l9 5.5-9 5.5z" fill="currentColor"/></svg>
          </button>
          <button class="emu-launch emu-launch-cold" data-id="${escapeAttr(e.id)}" data-cold="true" title="Cold Boot">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 1v6M5.5 4.5L8 7l2.5-2.5M4 2.5l9 5.5-9 5.5z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
            <span>Cold</span>
          </button>
        </div>
      </div>
    `).join('');
  } else if (!fetched) {
    bodyHtml = '<div class="emu-empty">Loading...</div>';
  } else {
    bodyHtml = '<div class="emu-empty">No Android emulators found</div>';
  }

  dropdownEl.innerHTML = `
    <div class="emu-header">
      <span>Emulators</span>
      <button class="emu-refresh" title="Refresh">↻</button>
    </div>
    <div class="emu-body">${bodyHtml}</div>
  `;

  // Wire up refresh
  dropdownEl.querySelector('.emu-refresh').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const btn = ev.currentTarget;
    btn.classList.add('spinning');
    await refreshEmulators();
    renderDropdown();
  });

  // Wire up launch buttons
  dropdownEl.querySelectorAll('.emu-launch').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.id;
      const cold = btn.dataset.cold === 'true';
      const emu = emulators.find(e => e.id === id);
      const card = btn.closest('.emu-card');
      card.classList.add('launching');
      try {
        await invoke('launch_emulator', { id, cold });
        if (emu) emulatorBtn.textContent = emu.name;
      } catch (e) { console.warn('Failed to launch emulator:', e); }
      hideDropdown();
    });
  });
}

