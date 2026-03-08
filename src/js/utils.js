// Shared utility — reuses a single DOM element to avoid allocations per call
const _escDiv = document.createElement('div');

export function escapeHtml(str) {
  _escDiv.textContent = str;
  return _escDiv.innerHTML;
}

export function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
