import { el, q, qa, esc, avClass, avatarInner, shortStamp, clampText, skeletonRows, userFlagHtml } from './ui.js';
import { icon as ii } from './icons.js';
import { store, isPinned, isMuted, totalUnread, setConvMeta, visibleConversations, localUnread, isGroup, memberOf } from './store.js';

const mount = () => el('conversation-list');
const nodesById = new Map();
let onOpenConv = null;
let onConvAction = null;
let onPickOnline = null;

export function initSidebar(opts = {}) {
  onOpenConv = opts.onOpenConv;
  onConvAction = opts.onConvAction;
  onPickOnline = opts.onPickOnline;

  qa('.filter-chip', el('sidebar')).forEach((chip) => {
    chip.addEventListener('click', () => {
      qa('.filter-chip', el('sidebar')).forEach((c) => {
        c.classList.toggle('active', c === chip);
        c.setAttribute('aria-selected', c === chip ? 'true' : 'false');
      });
      store.convFilter = chip.dataset.filter;
      renderConversations();
    });
  });

  el('online-list').addEventListener('click', (e) => {
    const item = e.target.closest('.online-item');
    if (!item) return;
    const u = store.presenceUsers.get(Number(item.dataset.id));
    if (u) onPickOnline && onPickOnline(u);
  });

  el('online-wrap').addEventListener('click', (e) => {
    if (e.target.closest('.online-title') && !e.target.closest('button')) {
      el('online-wrap').classList.toggle('collapsed');
    }
  });
}

export function renderConversations() {
  const c = mount();
  const items = visibleConversations();
  if (!items.length && !store.conversations.size) {
    c.innerHTML = skeletonRows(5);
    return;
  }
  if (items.length === 0) {
    c.innerHTML = `<div class="conv-empty">لا توجد محادثات${filterLabel()}</div>`;
    nodesById.clear();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const conv of items) {
    const node = buildItem(conv);
    nodesById.set(conv.id, node);
    frag.appendChild(node);
  }
  c.replaceChildren(frag);
  updateEmptySidebar(items);
}

function filterLabel() {
  return store.convFilter === 'unread' ? ' غير مقروءة' : store.convFilter === 'pinned' ? ' مثبّتة' : store.convFilter === 'groups' ? ' مجموعات' : '';
}

function updateEmptySidebar(items) {
  mount().classList.toggle('just-empty', !items.length && store.conversations.size > 0);
}

function userOf(conv) {
  return conv.other || { id: 0, username: conv.name || 'مهمل', avatar_color: null };
}

function previewText(conv) {
  const lm = conv.lastMessage;
  if (!lm) return isGroup(conv) ? `${conv.memberCount || 0} عضو — لا رسائل بعد` : 'لا توجد رسائل بعد';
  const mine = conv.lastMessage && lm.sender_id === store.me?.id;
  let txt;
  if (lm.deleted) txt = 'حذفت هذه الرسالة';
  else if (lm.kind === 'image') txt = 'صورة';
  else if (lm.kind === 'file') txt = 'ملف: ' + (lm.mediaName || 'ملف');
  else txt = lm.content || '';
  if (mine) return 'أنت: ' + clampText(txt, 90);
  if (isGroup(conv)) {
    const mem = memberOf(conv.id, lm.sender_id);
    const prefix = mem ? mem.username : '';
    return (prefix ? prefix + ': ' : '') + clampText(txt, 90);
  }
  return clampText(txt, 90);
}

function buildItem(conv) {
  const btn = document.createElement('div');
  btn.className = 'conv-item';
  btn.setAttribute('role', 'listitem');
  btn.dataset.id = String(conv.id);
  btn.tabIndex = 0;

  const meId = store.me?.id;
  const mine = conv.lastMessage && meId && conv.lastMessage.sender_id === meId;
  const other = userOf(conv);
  const online = other.id && store.presence.has(other.id);

  const pin = isPinned(conv.id);
  const mute = isMuted(conv.id);
  const unread = totalUnread(conv);

  btn.innerHTML = `
    <span class="conv-av">
      <span class="avatar md ${avClass(other.avatar_color)}">${avatarInner(other)}</span>
      <span class="av-dot${online ? ' on' : ''}"></span>
    </span>
    <span class="conv-info">
      <span class="conv-top">
        <span class="conv-name">${esc(other.username)}${userFlagHtml(other)}</span>
        <span class="conv-ico">
          ${pin ? `<span class="conv-pin">${ii('pin', 14)}</span>` : ''}
          ${mute ? `<span class="conv-mute">${ii('bell', 14)}</span>` : ''}
        </span>
        <span class="conv-time">${shortStamp(conv.lastMessageAt)}</span>
      </span>
      <span class="conv-bottom">
        <span class="conv-preview${mine ? ' mine' : ''}">${esc(previewText(conv))}</span>
        ${unread ? `<span class="unread-badge">${unread}</span>` : ''}
      </span>
    </span>
  `;

  btn.addEventListener('click', () => onOpenConv && onOpenConv(conv.id));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenConv && onOpenConv(conv.id);
    }
  });

  const fe = document.createElement('span');
  fe.className = 'fe-root';
  fe.appendChild(btn);
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'fe-menu-btn icon-btn slim';
  menuBtn.setAttribute('aria-label', 'خيارات');
  menuBtn.innerHTML = ii('more', 16);
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onConvAction && onConvAction(conv.id, menuBtn);
  });
  fe.appendChild(menuBtn);
  longPress(fe, () => onConvAction && onConvAction(conv.id));
  return fe;
}

export function patchConv(conv) {
  const c = nodeById(conv.id);
  if (!c) return false;
  const other = userOf(conv);
  const online = other.id && store.presence.has(other.id);
  const mine = conv.lastMessage && store.me?.id && conv.lastMessage.sender_id === store.me?.id;
  const unread = totalUnread(conv);
  const pin = isPinned(conv.id);
  const mute = isMuted(conv.id);

  const av = q('.avatar', c);
  av.classList.remove('av0', 'av1', 'av2', 'av3', 'av4', 'av5', 'av6', 'av7');
  av.classList.add(avClass(other.avatar_color));
  if (av.querySelector('img')) av.replaceChildren();
  av.textContent = other.username ? Array.from(other.username)[0] : '';
  q('.av-dot', c).classList.toggle('on', online);

  q('.conv-name', c).innerHTML = `${esc(other.username)}${userFlagHtml(other)}`;
  q('.conv-time', c).textContent = shortStamp(conv.lastMessageAt);
  const prev = q('.conv-preview', c);
  prev.textContent = previewText(conv);
  prev.classList.toggle('mine', mine);

  let ico = q('.conv-ico', c);
  const wantIco = pin || mute;
  if (wantIco && !ico) {
    ico = document.createElement('span');
    ico.className = 'conv-ico';
    q('.conv-top', c).insertBefore(ico, q('.conv-time', c));
  }
  if (ico) ico.innerHTML = `${pin ? `<span class="conv-pin">${ii('pin', 14)}</span>` : ''}\n${mute ? `<span class="conv-mute">${ii('bell', 14)}</span>` : ''}`;
  if (!wantIco && ico) ico.remove();

  const badge = q('.unread-badge', c);
  if (unread && !badge) {
    const b = document.createElement('span');
    b.className = 'unread-badge';
    b.textContent = unread;
    q('.conv-bottom', c).appendChild(b);
  } else if (badge) {
    badge.textContent = unread;
    if (!unread) badge.remove();
  }
  return true;
}

export function reorderConversations() {
  const c = mount();
  const listEl = el('conversation-list');
  const order = visibleConversations().map((conv) => conv.id);
  if (order.length !== nodesById.size) return;
  let prev = null;
  for (const id of order) {
    const node = nodesById.get(id);
    if (!node) continue;
    if (prev) {
      if (node.previousSibling !== prev) {
        listEl.insertBefore(node, prev.nextSibling ? prev.nextSibling : null);
      }
    } else {
      if (node !== listEl.firstChild) listEl.insertBefore(node, listEl.firstChild);
    }
    prev = node;
  }
}

export function setActiveConv(convId) {
  qa('.conv-item', mount()).forEach((item) => {
    item.classList.toggle('active', item.dataset.id === String(convId));
  });
}

export function refreshOneConv(conv) {
  if (!conv) return;
  if (!nodeById(conv.id)) {
    renderConversations();
    return;
  }
  patchConv(conv);
  reorderConversations();
}

function nodeById(id) {
  const fe = nodesById.get(Number(id));
  return fe ? q('.conv-item', fe) : null;
}

export function removeConvNode(convId) {
  const fe = nodesById.get(Number(convId));
  if (fe) fe.remove();
  nodesById.delete(Number(convId));
}

export function renderOnlineList() {
  const list = el('online-list');
  if (!store.presenceUsers.size) {
    el('online-count').textContent = '0';
    list.innerHTML = '';
    return;
  }
  el('online-count').textContent = store.presenceUsers.size;
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const u of store.presenceUsers.values()) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'online-item';
    item.dataset.id = String(u.id);
    item.innerHTML = `
      <span class="avatar sm ${avClass(u.avatar_color)}">${avatarInner(u)}</span>
      <span class="search-name">${esc(u.username)}${userFlagHtml(u)}</span>
      <span class="dot online-dot"></span>`;
    frag.appendChild(item);
  }
  list.appendChild(frag);
  updateMeStatus();
}

export function setMe(user, connected) {
  const me = user;
  if (!me) return;
  const av = el('my-avatar');
  av.innerHTML = '';
  av.classList.remove('av0', 'av1', 'av2', 'av3', 'av4', 'av5', 'av6', 'av7');
  av.classList.add(avClass(me.avatar_color));
  av.appendChild(me.avatar_url ? avatarElImg(me) : letterEl(me));
  el('my-name').innerHTML = `${esc(me.username)}${userFlagHtml(me)}`;
  updateMeStatus(connected);
  window.salemMe = me;
}

function avatarElImg(me) {
  const i = document.createElement('img');
  i.className = 'avatar-img';
  i.src = me.avatar_url;
  i.alt = '';
  return i;
}

function letterEl(me) {
  const s = document.createElement('span');
  s.className = 'avatar-letter';
  s.textContent = Array.from(me.username || '؟')[0];
  return s;
}

export function updateMeStatus(connected = store.socketConnected) {
  const st = el('my-online');
  if (connected && store.presence.has(store.me?.id)) {
    st.className = 'me-status online';
    st.textContent = 'متصل الآن';
  } else if (connected) {
    st.className = 'me-status online';
    st.textContent = 'متصل';
  } else {
    st.className = 'me-status off';
    st.textContent = 'غير متصل';
  }
}

function longPress(node, fn) {
  let t = null;
  const start = (e) => {
    if (e.type === 'contextmenu' || (e.pointerType && e.pointerType !== 'touch')) return;
    t = setTimeout(() => {
      t = null;
      fn();
    }, 480);
  };
  const clear = () => {
    if (t) {
      clearTimeout(t);
      t = null;
    }
  };
  node.addEventListener('touchstart', start, { passive: true });
  node.addEventListener('touchend', clear);
  node.addEventListener('touchmove', clear);
  node.addEventListener('touchcancel', clear);
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    fn();
  });
}