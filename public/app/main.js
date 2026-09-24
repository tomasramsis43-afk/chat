import { api, setAuthExpiredHandler, refreshSession } from './api.js';
import { store, getConv, setConv, getMessages, localUnread, bumpLocalUnread, clearLocalUnread } from './store.js';
import {
  connectSocket,
  disconnectSocket,
  emitSend,
  emitRead,
  emitTyping,
  isConnected,
  setSocketHandlers
} from './socket.js';
import { el, esc, paintAvatar, timeOf, dayStamp, toast, convPreview, avClass } from './ui.js';

const MSG_PAGE = 100;
const appScreen = el('app-screen');

let typingBadgeTimer = null;
let olderBusy = false;

/* ================= Theme ================= */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('salem_theme', theme);
  el('theme-btn').textContent = theme === 'dark' ? '☀️' : '🌙';
}

el('theme-btn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ================= Auth ================= */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  el('login-form').classList.toggle('hidden', tab !== 'login');
  el('register-form').classList.toggle('hidden', tab !== 'register');
}

document.querySelectorAll('.tab-btn').forEach((btn) =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);

async function submitAuth(form, endpoint) {
  const errBox = form.querySelector('.error-text');
  errBox.classList.add('hidden');
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const username = form.querySelector('input[type=text]').value.trim();
    const password = form.querySelector('input[type=password]').value;
    const { user } = await api.post(endpoint, { username, password });
    store.me = user;
    showApp();
    await bootApp();
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

el('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth(e.currentTarget, '/api/auth/login');
});

el('register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth(e.currentTarget, '/api/auth/register');
});

el('logout-btn').addEventListener('click', async () => {
  try {
    await api.post('/api/auth/logout');
  } catch {}
  disconnectSocket();
  store.me = null;
  store.conversations.clear();
  store.messages.clear();
  store.convLocalUnread.clear();
  showAuth();
});

setAuthExpiredHandler(() => {
  disconnectSocket();
  store.me = null;
  showAuth();
  toast('انتهت الجلسة، سجل دخولك من جديد');
});

function showAuth() {
  el('auth-screen').classList.remove('hidden');
  appScreen.classList.add('hidden');
  document.body.classList.remove('chat-active');
}

function showApp() {
  el('auth-screen').classList.add('hidden');
  appScreen.classList.remove('hidden');
  paintAvatar(el('my-avatar'), store.me);
  el('my-name').textContent = store.me.username;
}

/* ================= Conversation list ================= */
async function loadConversations() {
  const { conversations } = await api.get('/api/conversations?limit=100');
  store.conversations = new Map(conversations.map((c) => [Number(c.id), c]));
  renderList();
}

function shortStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const same = today.toDateString() === d.toDateString();
  if (same) return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}

function convAvatar(c) {
  if (c.other) return c.other;
  return { username: c.name || '؟', avatar_color: 'var(--accent)' };
}

function renderList() {
  const list = el('conversation-list');
  list.innerHTML = '';
  const items = [...store.conversations.values()];
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    empty.textContent = 'لا توجد محادثات بعد. ابحث عن شخص وابدأ شات.';
    list.appendChild(empty);
    return;
  }
  for (const c of items) {
    const mine = c.lastMessage && c.lastMessage.sender_id === store.me.id;
    const preview = convPreview(c);
    const badge = (c.unread || 0) + localUnread(Number(c.id));
    const av = convAvatar(c);

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'conv-item' + (c.id === store.activeConvId ? ' active' : '');
    item.innerHTML = `
      <div class="avatar ${avClass(av.avatar_color)}">${esc(initialsOf(av.username))}</div>
      <div class="conv-info">
        <div class="conv-top">
          <span class="conv-name">${esc(convAvatar(c).username)}</span>
          <span class="conv-time">${esc(shortStamp(c.lastMessageAt))}</span>
        </div>
        <div class="conv-bottom">
          <span class="conv-preview">${esc(preview)}</span>
          ${badge > 0 ? `<span class="unread-badge">${badge > 99 ? '99+' : badge}</span>` : ''}
        </div>
      </div>
    `;
    const dot = document.createElement('div');
    dot.className = 'online-dot' + (c.other && store.presence.has(c.other.id) ? ' on' : '');
    item.appendChild(dot);
    item.addEventListener('click', () => openConversation(Number(c.id)));
    list.appendChild(item);
  }
}

function initialsOf(name) {
  const s = String(name || '').trim();
  return s ? Array.from(s)[0] : '؟';
}

/* ================= Chat pane ================= */
function otherOf(conv) {
  return conv.other || { username: conv.name || 'محادثة', avatar_color: 'var(--accent)' };
}

function setChatHeader(conv) {
  const other = otherOf(conv);
  paintAvatar(el('chat-avatar'), other);
  el('chat-name').textContent = other.username;
  updateChatStatus();
}

function updateChatStatus() {
  const conv = getConv(store.activeConvId);
  if (!conv) return;
  const online = conv.other && store.presence.has(conv.other.id);
  const status = el('chat-status');
  status.classList.toggle('on', !!online);
  status.textContent = online ? 'متصل الآن' : 'غير متصل';
}

async function openConversation(convId) {
  let conv = getConv(convId);
  if (!conv) {
    try {
      conv = { id: convId };
      setConv(conv);
    } catch {}
  }
  store.activeConvId = convId;
  clearLocalUnread(convId);

  el('chat-empty').classList.add('hidden');
  el('chat-open').classList.remove('hidden');
  document.body.classList.add('chat-active');

  setChatHeader(conv);
  renderList();

  const cache = getMessages(convId);
  if (!cache.loaded) {
    await loadFirstPage(convId);
  }
  rerenderMessages(convId, true);
  markReadIfVisible(true);
  el('message-input').focus();
}

async function loadFirstPage(convId) {
  const cache = getMessages(convId);
  try {
    const { messages, nextBefore } = await api.get(`/api/conversations/${convId}/messages?limit=${MSG_PAGE}`);
    cache.items = messages;
    cache.nextBefore = nextBefore;
    cache.loaded = true;
  } catch (e) {
    toast(e.message);
  }
}

function rerenderMessages(convId, toBottom) {
  const cache = getMessages(convId);
  const box = el('messages');
  const other = getConv(convId);
  const prevTop = box.scrollTop;
  box.innerHTML = '';
  let lastDay = null;
  const frag = document.createDocumentFragment();

  for (const m of cache.items) {
    const day = dayStamp(m.created_at);
    if (day && day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = day;
      frag.appendChild(sep);
      lastDay = day;
    }
    frag.appendChild(buildMsgRow(m, other));
  }
  box.appendChild(frag);

  if (toBottom) {
    box.scrollTop = box.scrollHeight;
  } else {
    box.scrollTop = prevTop;
  }
}

function buildMsgRow(m, conv) {
  const mine = m.sender_id === store.me.id;
  const row = document.createElement('div');
  row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;
  row.dataset.id = String(m.id);

  if (!mine && conv && conv.other) {
    const av = document.createElement('div');
    av.className = 'avatar';
    paintAvatar(av, conv.other);
    row.appendChild(av);
  }

  const inner = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.deleted) {
    bubble.textContent = m.sender_id === store.me.id ? 'حذفت الرسالة' : 'حُذفت الرسالة';
    bubble.classList.add('deleted');
  } else {
    bubble.textContent = m.content;
  }
  inner.appendChild(bubble);

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const t = document.createElement('span');
  t.textContent = timeOf(m.created_at);
  meta.appendChild(t);

  if (mine) {
    const st = document.createElement('span');
    st.className = 'msg-state';
    if (m._pending) {
      st.textContent = '…';
      st.classList.add('pending');
    } else if (conv.otherLastReadId && m.id <= conv.otherLastReadId) {
      st.textContent = '✓✓';
      st.classList.add('read');
    } else {
      st.textContent = '✓';
    }
    meta.appendChild(st);
  }
  inner.appendChild(meta);
  row.appendChild(inner);
  return row;
}

async function sendMessage() {
  const input = el('message-input');
  const content = input.value.trim();
  if (!content || !store.activeConvId) return;
  input.value = '';
  el('send-btn').disabled = true;

  const clientMsgId = crypto.randomUUID();
  const convId = store.activeConvId;
  const tmp = {
    id: `tmp-${clientMsgId}`,
    conversation_id: convId,
    sender_id: store.me.id,
    content,
    kind: 'text',
    clientMsgId,
    created_at: new Date().toISOString(),
    _pending: true
  };

  const cache = getMessages(convId);
  cache.items.push(tmp);
  rerenderMessages(convId, true);

  const res = await emitSend({ conversationId: convId, content, clientMsgId });
  const idx = cache.items.findIndex((m) => m.clientMsgId === clientMsgId);
  if (res && res.ok) {
    if (idx >= 0) cache.items[idx] = res.message;
    updateConvPreview(convId, res.message);
  } else {
    const msg = (res && res.error && res.error.message) || 'تعذر الإرسال';
    toast(msg);
    if (tmp._pending && idx >= 0) cache.items.splice(idx, 1);
  }
  if (store.activeConvId === convId) rerenderMessages(convId, true);
  markReadIfVisible(true);
}

el('message-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

el('message-input').addEventListener('input', () => {
  el('send-btn').disabled = !inputHasText() || !isConnected();
});

function inputHasText() {
  return el('message-input').value.trim().length > 0;
}

let lastTypingEmit = 0;
el('message-input').addEventListener('input', () => {
  const now = Date.now();
  if (store.activeConvId && now - lastTypingEmit > 1500) {
    emitTyping(store.activeConvId);
    lastTypingEmit = now;
  }
});

function updateConvPreview(convId, message) {
  const conv = getConv(convId);
  if (!conv) return;
  conv.lastMessage = {
    id: message.id,
    content: message.content,
    sender_id: message.sender_id,
    created_at: message.created_at,
    deleted: false
  };
  conv.lastMessageAt = message.created_at;
  setConv(conv);
  renderList();
  if (store.activeConvId === convId) setChatHeader(conv);
}

/* ================= Read receipts ================= */
function atBottom() {
  const box = el('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

function markReadIfVisible(force) {
  const convId = store.activeConvId;
  if (!convId) return;
  const cache = getMessages(convId);
  const conv = getConv(convId);
  if (!cache.items.length || !conv) return;
  if (!force && !atBottom()) return;

  const lastId = cache.items[cache.items.length - 1].id;
  if (typeof lastId !== 'number') return;
  const current = Number(conv.lastReadMessageId || 0);
  if (lastId > current) {
    conv.lastReadMessageId = lastId;
    clearLocalUnread(convId);
    emitRead(convId, lastId);
    renderList();
  }
}

el('messages').addEventListener('scroll', () => {
  const box = el('messages');
  if (store.activeConvId && box.scrollTop < 60 && !olderBusy) {
    loadOlderMessages(store.activeConvId);
  }
  if (store.activeConvId && atBottom()) markReadIfVisible(false);
});

async function loadOlderMessages(convId) {
  const cache = getMessages(convId);
  if (olderBusy || !cache.nextBefore) return;
  olderBusy = true;
  const loader = el('older-loader');
  loader.classList.remove('hidden');

  const firstId = cache.items[0] && cache.items[0].id;
  const oldEl = firstId != null ? document.querySelector(`.msg-row[data-id="${firstId}"]`) : null;
  const anchor = oldEl ? oldEl.offsetTop - el('messages').scrollTop : null;

  try {
    const { messages, nextBefore } = await api.get(
      `/api/conversations/${convId}/messages?before=${cache.nextBefore}&limit=${MSG_PAGE}`
    );
    cache.items = [...messages, ...cache.items];
    cache.nextBefore = nextBefore;
    if (store.activeConvId === convId) {
      rerenderMessages(convId, false);
      if (firstId != null) {
        const newEl = document.querySelector(`.msg-row[data-id="${firstId}"]`);
        if (newEl && anchor != null) el('messages').scrollTop = newEl.offsetTop - anchor;
      }
    }
  } catch (e) {
    toast(e.message);
  } finally {
    loader.classList.add('hidden');
    olderBusy = false;
  }
}

/* ================= Realtime ================= */
function handlePresence(ids) {
  store.presence = new Set(ids.map(Number));
  updateChatStatus();
  renderList();
}

function handleMessage(msg) {
  const convId = Number(msg.conversation_id);
  let conv = getConv(convId);
  if (!conv) {
    loadConversations().catch(() => {});
    conv = { id: convId, other: null };
    setConv(conv);
  }
  updateConvPreview(convId, msg);

  const cache = getMessages(convId);
  const exists = cache.items.some((m) => m.id === msg.id);
  if (!exists) cache.items.push(msg);

  if (store.activeConvId === convId) {
    rerenderMessages(convId, true);
    markReadIfVisible(true);
  } else {
    bumpLocalUnread(convId);
    renderList();
  }
}

function handleRead(ev) {
  const convId = Number(ev.conversationId);
  const conv = getConv(convId);
  if (!conv) return;
  conv.otherLastReadId = Number(ev.lastReadId) || 0;
  if (store.activeConvId === convId) rerenderMessages(convId, false);
}

function handleTyping(ev) {
  const convId = Number(ev.conversationId);
  if (convId !== store.activeConvId) return;
  const conv = getConv(convId);
  if (!conv || (conv.other && ev.userId !== conv.other.id)) return;
  const badge = el('typing-badge');
  badge.classList.remove('hidden');
  clearTimeout(typingBadgeTimer);
  typingBadgeTimer = setTimeout(() => badge.classList.add('hidden'), 3000);
}

setSocketHandlers({
  onConnect() {
    store.socketConnected = true;
    el('my-online').textContent = 'متصل';
    el('my-online').classList.remove('off');
    el('send-btn').disabled = !inputHasText();
  },
  onDisconnect() {
    store.socketConnected = false;
    el('my-online').textContent = 'غير متصل';
    el('my-online').classList.add('off');
    el('send-btn').disabled = true;
  },
  onConnectError(err) {
    if (err && err.message === 'UNAUTHORIZED') {
      refreshSession().then((ok) => {
        if (!ok) {
          store.me = null;
          showAuth();
        }
      });
    }
  },
  onPresence: handlePresence,
  onMessage: handleMessage,
  onRead: handleRead,
  onTyping: handleTyping
});

/* ================= Search / new chat ================= */
let searchTimer = null;
el('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = el('search-input').value.trim();
  const box = el('search-results');
  if (!q) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const { users } = await api.get(`/api/users?q=${encodeURIComponent(q)}&limit=8`);
      box.innerHTML = '';
      if (!users.length) {
        box.innerHTML = '<div class="search-item search-empty">لا توجد نتائج</div>';
      }
      for (const u of users) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'search-item';
        const on = store.presence.has(u.id);
        item.innerHTML = `
          <div class="avatar ${avClass(u.avatar_color)}">${esc(initialsOf(u.username))}</div>
          <div class="search-name">${esc(u.username)}</div>
          <div class="online-dot ${on ? 'on' : ''}"></div>
        `;
        item.addEventListener('click', () => startDm(u));
        box.appendChild(item);
      }
      box.classList.remove('hidden');
    } catch (e) {
      toast(e.message);
    }
  }, 250);
});

async function startDm(user) {
  el('search-results').classList.add('hidden');
  el('search-input').value = '';
  try {
    const { conversation } = await api.post('/api/conversations', { userId: user.id });
    const conv = getConv(conversation.id);
    if (conv && !conv.lastMessage) {
      conversation.lastMessage = null;
      conversation.lastMessageAt = null;
      conversation.lastReadMessageId = 0;
      conversation.other = conversation.other || { id: user.id, username: user.username, avatar_color: user.avatar_color, online: store.presence.has(user.id) };
      setConv({ ...conv, ...conversation });
    } else {
      setConv(conversation);
    }
    renderList();
    await openConversation(conversation.id);
  } catch (e) {
    toast(e.message);
  }
}

el('back-btn').addEventListener('click', () => {
  document.body.classList.remove('chat-active');
});

/* ================= Boot ================= */
async function bootApp() {
  await loadConversations();
  connectSocket();
}

applyTheme(localStorage.getItem('salem_theme') || 'dark');

(async function init() {
  try {
    const { user } = await api.get('/api/auth/me');
    store.me = user;
    showApp();
    await bootApp();
  } catch {
    showAuth();
    switchTab('login');
  }
})();