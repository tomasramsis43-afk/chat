import { el, esc, avClass, avatarInner, shortStamp, clampText, userFlagHtml } from './ui.js';
import { icon as ii } from './icons.js';
import { store, totalUnread } from './store.js';

let onOpenConv = null;
let onPickOnline = null;
let onShowSection = null;
let opened = false;

function mount() {
  return el('nav-menu');
}

export function initNavDrawer(opts = {}) {
  onOpenConv = opts.onOpenConv || null;
  onPickOnline = opts.onPickOnline || null;
  onShowSection = opts.onShowSection || null;
  el('menu-btn').innerHTML = ii('menu', 20);
  el('nav-close').innerHTML = ii('close', 18);
  el('menu-btn').addEventListener('click', toggleNavDrawer);
  el('nav-close').addEventListener('click', closeNavDrawer);
  el('nav-backdrop').addEventListener('click', closeNavDrawer);
  el('nav-online-tab').addEventListener('click', () => {
    closeNavDrawer();
    if (onShowSection) onShowSection('online');
  });
  el('nav-convs-tab').addEventListener('click', () => {
    closeNavDrawer();
    if (onShowSection) onShowSection('convs');
  });
}

export function toggleNavDrawer() {
  if (opened) closeNavDrawer();
  else openNavDrawer();
}

export function isNavOpen() {
  return opened;
}

export function openNavDrawer() {
  if (opened) return;
  opened = true;
  renderNavDrawer();
  mount().classList.add('open');
  mount().setAttribute('aria-hidden', 'false');
  el('nav-backdrop').classList.remove('hidden');
  el('nav-backdrop').setAttribute('aria-hidden', 'false');
  document.body.classList.add('nav-open');
}

export function closeNavDrawer() {
  if (!opened) return;
  opened = false;
  mount().classList.remove('open');
  mount().setAttribute('aria-hidden', 'true');
  el('nav-backdrop').classList.add('hidden');
  el('nav-backdrop').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('nav-open');
}

function convTime(conv) {
  return conv.lastMessageAt ? Date.parse(conv.lastMessageAt) : conv.created_at ? Date.parse(conv.created_at) : 0;
}

export function renderNavDrawer() {
  if (!opened) return;

  const onlineL = el('nav-online-list');
  const users = [...store.presenceUsers.values()];
  el('nav-online-count').textContent = String(users.length);
  el('nav-online-empty').classList.toggle('hidden', users.length > 0);
  onlineL.innerHTML = '';
  const ofrag = document.createDocumentFragment();
  for (const u of users) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nav-item';
    b.innerHTML = `
      <span class="avatar sm ${avClass(u.avatar_color)}">${avatarInner(u)}</span>
      <span class="nav-name">${esc(u.username)}${userFlagHtml(u)}</span>
      <span class="dot online-dot"></span>`;
    b.addEventListener('click', () => {
      closeNavDrawer();
      if (onPickOnline) onPickOnline(u);
    });
    ofrag.appendChild(b);
  }
  onlineL.appendChild(ofrag);

  const convs = [...store.conversations.values()].sort((a, b) => convTime(b) - convTime(a));
  renderConvList(el('nav-convs-list'), el('nav-convs-empty'), convs);
}

function renderConvList(listEl, emptyEl, convs) {
  emptyEl.classList.toggle('hidden', convs.length > 0);
  listEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const conv of convs) {
    const other = conv.other || { id: 0, username: conv.name || 'مهمل', avatar_color: null };
    const online = other.id && store.presence.has(other.id);
    const mine = conv.lastMessage && store.me?.id && conv.lastMessage.sender_id === store.me.id;
    const unread = totalUnread(conv);
    const preview = conv.lastMessage
      ? conv.lastMessage.deleted
        ? 'حذفت هذه الرسالة'
        : clampText(conv.lastMessage.content || '', 70)
      : 'لا توجد رسائل بعد';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nav-item nav-conv' + (conv.id === store.activeConvId ? ' active' : '');
    b.innerHTML = `
      <span class="avatar sm ${avClass(other.avatar_color)}"><span class="av-dot${online ? ' on' : ''}"></span>${avatarInner(other)}</span>
      <span class="nav-info">
        <span class="nav-top">
          <span class="nav-name">${esc(other.username)}${userFlagHtml(other)}</span>
          <span class="nav-time">${shortStamp(conv.lastMessageAt)}</span>
        </span>
        <span class="nav-preview${mine ? ' mine' : ''}">${esc(mine ? 'أنت: ' + preview : preview)}</span>
      </span>
      ${unread ? `<span class="unread-badge">${unread}</span>` : ''}`;
    b.addEventListener('click', () => {
      closeNavDrawer();
      if (onOpenConv) onOpenConv(conv.id);
    });
    frag.appendChild(b);
  }
  listEl.appendChild(frag);
}