import { api } from './api.js';
import { el, q, qa, avatarInner, avClass, esc, userFlagHtml } from './ui.js';
import { icon } from './icons.js';

let onPick = null;
let open = false;
let results = [];
let activeIdx = -1;
let timer = null;
let qVersion = 0;

export function initSearch(opts = {}) {
  onPick = opts.onPick;
  el('search-ic').innerHTML = icon('search', 16);
  el('search-spin').innerHTML = `<span class="spin"></span>`;
  el('search-input').addEventListener('input', () => {
    clearTimeout(timer);
    const v = el('search-input').value.trim();
    if (!v) {
      qVersion++;
      closeResults();
      return;
    }
    timer = setTimeout(() => run(v), 240);
  });
  el('search-input').addEventListener('keydown', (e) => {
    if (!open) return;
    const items = qa('.search-item', el('search-results'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      activeIdx = (activeIdx + dir + items.length) % items.length;
      focusAt(items);
    } else if (e.key === 'Enter' && activeIdx >= 0 && items[activeIdx]) {
      e.preventDefault();
      items[activeIdx].click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      el('search-input').blur();
      closeResults();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) closeResults();
  });
}

async function run(term) {
  const box = el('search-results');
  const spin = el('search-spin');
  const v = ++qVersion;
  spin.classList.remove('hidden');
  activeIdx = -1;
  try {
    const data = await api.get(`/api/users?q=${encodeURIComponent(term)}&limit=8`);
    if (v !== qVersion || !document.contains(box)) return;
    results = data.users || [];
    render(box);
  } catch {
    if (v !== qVersion || !document.contains(box)) return;
    results = [];
    render(box);
  }
  spin.classList.add('hidden');
}

function render(box) {
  box.innerHTML = '';
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'search-item no-results';
    empty.textContent = 'لا توجد نتائج';
    box.appendChild(empty);
  } else {
    for (const u of results) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'search-item';
      item.setAttribute('role', 'option');
      item.dataset.id = String(u.id);
      item.innerHTML = `<span class="avatar sm ${avClass(u.avatar_color)}">${avatarInner(u)}</span>
        <span class="search-name">${esc(u.username)}${userFlagHtml(u)}</span>
        ${u.online ? '<span class="dot online-dot" title="متصل"></span>' : ''}`;
      item.addEventListener('click', () => {
        closeResults();
        clearSearchInput();
        onPick && onPick(u);
      });
      box.appendChild(item);
    }
  }
  box.classList.remove('hidden');
  open = true;
}

function focusAt(items) {
  items.forEach((it, i) => it.classList.toggle('active', i === activeIdx));
  if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
}

export function startSearch() {
  const input = el('search-input');
  input.focus();
  input.select();
}

export function clearSearchInput() {
  el('search-input').value = '';
}

function closeResults() {
  qVersion++;
  el('search-results').classList.add('hidden');
  open = false;
}