import { el, q, qa, esc, avClass, avatarInner, userFlagHtml, toast } from './ui.js';
import { icon as ii } from './icons.js';
import { api } from './api.js';
import { store, setMembers } from './store.js';

let onCreated = null;
let selected = new Set();
let results = [];
let open = false;
let timer = null;
let qVersion = 0;

export function initGroupDialog(opts = {}) {
  onCreated = opts.onCreated || null;
  el('empty-new-group').addEventListener('click', () => openGroupDialog());
  el('nav-new-group').addEventListener('click', () => {
    closeNavDrawerSafe();
    openGroupDialog();
  });
  el('group-dialog-close').addEventListener('click', closeGroupDialog);
  el('group-dialog-backdrop').addEventListener('click', closeGroupDialog);
  el('group-create-btn').addEventListener('click', createGroup);
  el('group-name-input').addEventListener('input', () => {
    el('group-create-btn').disabled = !el('group-name-input').value.trim();
  });

  el('group-search-input').addEventListener('input', () => {
    clearTimeout(timer);
    const v = el('group-search-input').value.trim();
    if (!v) {
      qVersion++;
      el('group-search-results').classList.add('hidden');
      renderInitial();
      return;
    }
    timer = setTimeout(() => runSearch(v), 240);
  });

  el('group-search-results').addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    const uid = Number(item.dataset.id);
    toggleUser(uid);
  });

  el('group-selected-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    toggleUser(Number(item.dataset.id));
  });
}

function closeNavDrawerSafe() {
  const nav = document.getElementById('nav-menu');
  if (nav && nav.classList.contains('open')) {
    const ev = new Event('click');
    document.getElementById('nav-close').dispatchEvent(ev);
  }
}

function collectUsers() {
  const map = new Map();
  for (const u of store.presenceUsers.values()) {
    if (u.id && u.id !== store.me?.id) map.set(Number(u.id), u);
  }
  return map;
}

export function openGroupDialog() {
  selected.clear();
  el('group-name-input').value = '';
  el('group-search-input').value = '';
  el('group-create-btn').disabled = true;
  el('group-dialog').classList.remove('hidden');
  el('group-dialog-backdrop').classList.remove('hidden');
  document.body.classList.add('dialog-open');
  open = true;
  renderInitial();
  renderSelected();
  el('group-name-input').focus();
}

export function closeGroupDialog() {
  open = false;
  el('group-dialog').classList.add('hidden');
  el('group-dialog-backdrop').classList.add('hidden');
  document.body.classList.remove('dialog-open');
}

function renderInitial() {
  const box = el('group-search-results');
  box.classList.remove('hidden');
  box.innerHTML = '';
  const users = [...collectUsers().values()];
  if (!users.length) {
    const empty = document.createElement('div');
    empty.className = 'search-item no-results';
    empty.textContent = 'لا يوجد متصلون لإضافتهم';
    box.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const u of users) {
    frag.appendChild(userItem(u));
  }
  box.appendChild(frag);
}

function userItem(u) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'search-item' + (selected.has(Number(u.id)) ? ' selected' : '');
  b.dataset.id = String(u.id);
  b.innerHTML = `<span class="avatar sm ${avClass(u.avatar_color)}">${avatarInner(u)}</span>
    <span class="search-name">${esc(u.username)}${userFlagHtml(u)}</span>
    ${selected.has(Number(u.id)) ? '<span class="check-mark"></span>' : ''}`;
  return b;
}

async function runSearch(term) {
  const box = el('group-search-results');
  const v = ++qVersion;
  box.classList.remove('hidden');
  box.innerHTML = '<div class="search-item no-results"><span class="spin"></span></div>';
  try {
    const data = await api.get(`/api/users?q=${encodeURIComponent(term)}&limit=8`);
    if (v !== qVersion || !open) return;
    results = (data.users || []);
    renderSearchResults(box);
  } catch {
    if (v !== qVersion || !open) return;
    results = [];
    renderSearchResults(box);
  }
}

function renderSearchResults(box) {
  box.innerHTML = '';
  const filtered = results.filter((u) => Number(u.id) !== Number(store.me?.id));
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'search-item no-results';
    empty.textContent = 'لا توجد نتائج';
    box.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const u of filtered) frag.appendChild(userItem(u));
  box.appendChild(frag);
}

function selectedUsers() {
  const map = collectUsers();
  const out = [];
  for (const uid of selected) {
    out.push(map.get(uid) || store.presenceUsers.get(uid) || { id: uid, username: 'عضو ' + uid });
  }
  return out;
}

function renderSelected() {
  const list = el('group-selected-list');
  const count = el('group-selected-count');
  count.textContent = String(selected.size);
  list.innerHTML = '';
  const users = selectedUsers();
  if (!users.length) {
    list.innerHTML = '<div class="group-selected-empty">لم تختر أحدًا بعد</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const u of users) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'member-chip';
    chip.dataset.id = String(u.id);
    chip.innerHTML = `<span class="avatar xs ${avClass(u.avatar_color)}">${avatarInner(u)}</span><span class="member-chip-name">${esc(u.username)}</span>${ii('close', 13)}`;
    frag.appendChild(chip);
  }
  list.appendChild(frag);
}

function toggleUser(uid) {
  if (selected.has(uid)) selected.delete(uid);
  else selected.add(uid);
  qa('.search-item[data-id]', el('group-search-results')).forEach((it) => {
    it.classList.toggle('selected', selected.has(Number(it.dataset.id)));
  });
  renderSelected();
}

async function createGroup() {
  const name = el('group-name-input').value.trim();
  if (!name) {
    toast('اكتب اسم المجموعة', 'warn');
    return;
  }
  const btn = el('group-create-btn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الإنشاء…';
  try {
    const data = await api.post('/api/conversations/group', { name, memberIds: [...selected] });
    const conv = data.conversation || {};
    const members = await api.get(`/api/conversations/${conv.id}/members`);
    setMembers(conv.id, members.members || []);
    closeGroupDialog();
    if (onCreated) onCreated(conv);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'تعذّر إنشاء المجموعة', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'إنشاء المجموعة';
  }
}