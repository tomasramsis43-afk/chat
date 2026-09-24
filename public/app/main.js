import { el, q, qa, toast, sendTimeZone } from './ui.js';
import { icon as ii } from './icons.js';
import { api, ApiError, setAuthExpiredHandler } from './api.js';
import { connectSocket, disconnectSocket, setSocketHandlers, emitSend } from './socket.js';
import { store, getConv, bumpLocalUnread, isPinned, isMuted, setConvMeta } from './store.js';
import { initSearch, startSearch } from './search.js';
import { initSidebar, renderConversations, refreshOneConv, reorderConversations, renderOnlineList, setMe, updateMeStatus } from './sidebar.js';
import { initMessages, openConversation, appendIncoming, appendPending, confirmPending, rejectPending, handleReadEvent, updateTyping, closeConversation, getActiveConvId, paintHeader, updateChatStatus, scrollToMessageById } from './messages.js';
import { initComposer, startReply, setConnectedState, closeEmoji } from './composer.js';
import { initPanel, openPanel, closePanel, refreshPanel } from './panel.js';
import { showMenu, closeMenu } from './menu.js';

const MAX_UNREAD = 99;

initTheme();
initSearch({ onPick: onPickUser });
initSidebar({ onOpenConv: openConversationFromList, onConvAction: onConvMenu, onPickOnline: openDmWithUser });
initMessages({
  onReplyClick: (m) => startReply(m, senderNameOf(m)),
  onInfo: () => {
    const id = getActiveConvId();
    if (id) openPanel(id);
  }
});
initComposer({
  getActiveConv: getActiveConvId,
  onSend: sendMessage,
  onReplyJump: (id) => scrollToReply(id)
});
initPanel();
wireAuth();

el('back-btn').innerHTML = ii('back', 20);
el('logout-btn').innerHTML = ii('logout', 18);
el('theme-btn').innerHTML = ii(currentIcon(), 19);
el('back-btn').addEventListener('click', () => {
  closePanel();
  closeConversation();
});
el('theme-btn').addEventListener('click', toggleTheme);
el('chat-head-info').addEventListener('click', () => {
  const id = getActiveConvId();
  if (id) openPanel(id);
});
el('info-btn').addEventListener('click', () => {
  const id = getActiveConvId();
  if (id) openPanel(id);
});
el('empty-new-chat').addEventListener('click', startSearch);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeEmoji();
    closePanel();
    closeMenu();
    document.activeElement && document.activeElement.blur();
  }
});

setAuthExpiredHandler(() => {
  toast('انتهت الجلسة — سجّل الدخول مجددًا', 'error');
  logout();
});

boot().catch((err) => {
  console.error(err);
  showAuth();
});

function boot() {
  return (async () => {
    const params = new URLSearchParams(location.search);
    if (params.get('auth') === 'google') {
      const status = params.get('status');
      history.replaceState({}, '', location.pathname);
      if (status === 'ok') toast('تم تسجيل الدخول بغوغل', 'ok');
      else toast(status === 'GOOGLE_DISABLED' ? 'تسجيل الدخول عبر غوغل غير مفعّل' : 'تعذّر تسجيل الدخول بغوغل — أعد المحاولة', 'error');
    }
    try {
      const data = await api.get('/api/auth/me');
      enterApp(data.user);
    } catch {
      showAuth();
    }
  })();
}

async function enterApp(user) {
  store.me = user;
  window.salemMe = user;
  setMe(user, store.socketConnected);
  hideAuth();
  renderConversations();
  loadConversations();
  connectPipe();
  connectSocket();
}

async function loadConversations() {
  try {
    const data = await api.get('/api/conversations?limit=100');
    const list = data.conversations || [];
    store.conversations.clear();
    for (const c of list) store.conversations.set(Number(c.id), c);
    if (getActiveConvId()) {
      const cur = getConv(getActiveConvId());
      if (cur) {
        paintHeader(cur);
        updateChatStatus(cur);
      }
    }
    renderConversations();
    if (getActiveConvId() && !getConv(getActiveConvId())) {
      closeConversation();
    }
  } catch {
    toast('تعذّر تحميل المحادثات', 'error');
  }
}

function openConversationFromList(convId) {
  closePanel();
  openConversation(convId);
}

function openDmWithUser(user) {
  const convId = findConvWithUser(user.id);
  if (convId !== null) {
    openConversationFromList(convId);
    return;
  }
  createDm(user.id).then((id) => id && openConversationFromList(id));
}

function findConvWithUser(uid) {
  for (const c of store.conversations.values()) {
    if (c.other && Number(c.other.id) === Number(uid)) return Number(c.id);
  }
  return null;
}

async function createDm(userId) {
  try {
    const data = await api.post('/api/conversations', { userId });
    const conv = data.conversation || {};
    if (!conv.other) {
      const u = store.presenceUsers.get(Number(userId));
      conv.other = u || { id: Number(userId), username: 'مستخدم', avatar_color: null, online: store.presence.has(Number(userId)) };
    }
    store.conversations.set(Number(conv.id), conv);
    refreshOneConv(conv);
    return Number(conv.id);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'تعذّر فتح المحادثة', 'error');
    return null;
  }
}

async function onPickUser(user) {
  const convId = findConvWithUser(user.id);
  if (convId !== null) {
    openConversationFromList(convId);
    return;
  }
  await createDm(user.id).then((id) => id && openConversationFromList(id));
}

function senderNameOf(m) {
  if (store.me && m.sender_id === store.me.id) return store.me.username;
  const c = getConv(m.conversation_id);
  if (c && c.other && c.other.id === m.sender_id) return c.other.username;
  return 'مستخدم';
}

async function sendMessage(convId, content, replyTarget) {
  const tmpId = `tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const tmp = {
    id: tmpId,
    conversation_id: convId,
    sender_id: store.me?.id,
    content,
    kind: 'text',
    reply_to_id: replyTarget ? replyTarget.id : null,
    created_at: new Date().toISOString()
  };
  appendPending(convId, tmp);
  const res = await emitSend({ conversationId: convId, content, replyToId: tmp.reply_to_id });
  if (res.ok) {
    confirmPending(convId, tmpId, { ...res.message, conversation_id: convId });
    updateConvWithMessage(convId, res.message, true);
  } else if (res.error && res.error.code === 'DUPLICATE' && res.message) {
    confirmPending(convId, tmpId, { ...res.message, conversation_id: convId });
  } else {
    rejectPending(convId, tmpId);
    toast('تعذّر إرسال الرسالة' + (res.error && res.error.message ? ' — ' + res.error.message : ''), 'error');
  }
}

function updateConvWithMessage(convId, msg, mine) {
  const conv = getConv(convId);
  if (!conv) return;
  conv.lastMessage = {
    id: msg.id,
    content: msg.content,
    kind: msg.kind || 'text',
    sender_id: msg.sender_id,
    created_at: msg.created_at,
    deleted: !!msg.deleted
  };
  conv.lastMessageAt = msg.created_at;
  store.conversations.set(convId, conv);
  if (mine && getActiveConvId() === convId) {
    refreshOneConv(conv);
    reorderConversations();
  }
}

function handleNewMessage(msg) {
  const convId = Number(msg.conversation_id);
  let conv = getConv(convId);
  const mine = store.me && msg.sender_id === store.me.id;

  if (!conv) {
    loadConversations();
    return;
  }

  conv.lastMessage = {
    id: msg.id,
    content: msg.content,
    kind: msg.kind || 'text',
    sender_id: msg.sender_id,
    created_at: msg.created_at,
    deleted: !!msg.deleted
  };
  conv.lastMessageAt = msg.created_at;
  store.conversations.set(convId, conv);

  if (getActiveConvId() === convId) {
    appendIncoming(msg);
    refreshOneConv(conv);
    reorderConversations();
  } else {
    if (!mine) bumpLocalUnread(convId);
    refreshOneConv(conv);
    reorderConversations();
  }
}

function scrollToReply(id) {
  scrollToMessageById(id, getActiveConvId());
}

function connectPipe() {
  setSocketHandlers({
    onConnect: () => {
      store.socketConnected = true;
      setConnectedState();
      updateMeStatus(true);
      hideBanner();
      loadConversations();
      refreshPanel();
    },
    onDisconnect: () => {
      store.socketConnected = false;
      setConnectedState();
      updateMeStatus(false);
      showBanner('انقطع الاتصال — جاري إعادة المحاولة…');
    },
    onConnectError: () => {
      store.socketConnected = false;
      setConnectedState();
      updateMeStatus(false);
      showBanner('تعذّر الاتصال بالخادم…');
    },
    onPresence: (users) => {
      store.presence = new Set((users || []).map((u) => Number(u.id)));
      store.presenceUsers = new Map((users || []).map((u) => [Number(u.id), u]));
      renderOnlineList();
      updateMeStatus(store.socketConnected);
      rerenderConvDots();
      const cur = getConv(getActiveConvId());
      if (cur) updateChatStatus(cur);
      refreshPanel();
    },
    onMessage: handleNewMessage,
    onRead: handleReadEvent,
    onTyping: updateTyping
  });
}

function rerenderConvDots() {
  for (const conv of store.conversations.values()) refreshOneConv(conv);
  reorderConversations();
}

function onConvMenu(convId, anchor) {
  const pin = isPinned(convId);
  const mute = isMuted(convId);
  const items = [
    { icon: 'pin', label: pin ? 'إلغاء التثبيت' : 'تثبيت المحادثة', action: () => togglePin(convId) },
    { icon: 'bell', label: mute ? 'إلغاء الكتم' : 'كتم الإشعارات', action: () => toggleMute(convId) }
  ];
  if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    showMenu(items, r.right, r.bottom + 4);
  } else {
    showMenu(items, window.innerWidth / 2, window.innerHeight / 2);
  }
}

function togglePin(convId) {
  const next = setConvMeta(convId, { pinned: !isPinned(convId) });
  refreshOneConv(getConv(convId));
  reorderConversations();
  toast(next.pinned ? 'تم تثبيت المحادثة' : 'أزيل التثبيت', 'ok');
}

function toggleMute(convId) {
  const next = setConvMeta(convId, { muted: !isMuted(convId) });
  refreshOneConv(getConv(convId));
  toast(next.muted ? 'تم كتم المحادثة' : 'تم إلغاء الكتم', 'ok');
}

function wireAuth() {
  q('.auth-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.auth-tab');
    if (!tab) return;
    qa('.auth-tab', e.currentTarget).forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    });
    el('login-form').classList.toggle('hidden', tab.dataset.tab !== 'login');
    el('register-form').classList.toggle('hidden', tab.dataset.tab !== 'register');
  });

  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = el('login-username').value.trim();
    const password = el('login-password').value;
    const errEl = el('login-error');
    if (!username || !password) {
      errEl.textContent = 'املأ الحقلين';
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    const btn = q('button[type=submit]', el('login-form'));
    btn.disabled = true;
    btn.textContent = 'دخول…';
    try {
      const data = await api.post('/api/auth/login', { username, password, timezone: sendTimeZone() });
      window.salemMe = data.user;
      store.me = data.user;
      enterApp(data.user);
    } catch (err) {
      errEl.textContent = err instanceof ApiError ? err.message : 'تعذّر تسجيل الدخول';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'دخول';
    }
  });

  el('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = el('register-username').value.trim();
    const password = el('register-password').value;
    const errEl = el('register-error');
    if (username.length < 3 || username.length > 24 || !/^[\p{L}\p{N}_\- .]+$/u.test(username)) {
      errEl.textContent = 'الاسم 3-24 حرفًا (حروف وأرقام فقط)';
      errEl.classList.remove('hidden');
      return;
    }
    if (password.length < 8) {
      errEl.textContent = 'كلمة المرور 8 أحرف على الأقل';
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    const btn = q('button[type=submit]', el('register-form'));
    btn.disabled = true;
    btn.textContent = 'جارٍ الإنشاء…';
    try {
      const data = await api.post('/api/auth/register', { username, password, timezone: sendTimeZone() });
      window.salemMe = data.user;
      store.me = data.user;
      enterApp(data.user);
    } catch (err) {
      errEl.textContent = err instanceof ApiError ? err.message : 'تعذّر إنشاء الحساب';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'إنشاء الحساب';
    }
  });

  el('google-btn').addEventListener('click', async () => {
    el('google-btn').disabled = true;
    try {
      const data = await api.post('/api/auth/google/start');
      location.href = data.url;
    } catch (err) {
      const msg =
        err instanceof ApiError && err.code === 'GOOGLE_DISABLED'
          ? 'غوغل غير مفعّل حاليًا — عدّل الإعدادات في لوحة التحكم'
          : 'تعذّر بدء تسجيل الدخول بغوغل';
      toast(msg, 'warn');
      el('google-btn').disabled = false;
    }
  });

  el('logout-btn').addEventListener('click', logout);
}

async function logout() {
  disconnectSocket();
  try {
    await api.post('/api/auth/logout');
  } catch {}
  resetToAuth();
  showAuth();
}

function resetToAuth() {
  store.me = null;
  window.salemMe = null;
  store.activeConvId = null;
  store.conversations.clear();
  store.messages.clear();
  store.convLocalUnread.clear();
  store.presence.clear();
  store.presenceUsers.clear();
  closeConversation();
  closePanel();
  el('chat-open').classList.add('hidden');
  el('chat-empty').classList.remove('hidden');
}

function showAuth() {
  el('auth-screen').classList.remove('hidden');
  el('app-screen').classList.add('hidden');
}

function hideAuth() {
  el('auth-screen').classList.add('hidden');
  el('app-screen').classList.remove('hidden');
}

function openBanner(text) {
  const b = el('conn-banner');
  q('.conn-text', b).textContent = text;
  b.classList.add('show');
}

function closeBanner() {
  const b = el('conn-banner');
  if (b) b.classList.remove('show');
}

function showBanner(text) {
  openBanner(text);
}

function hideBanner() {
  closeBanner();
}

function initTheme() {
  const saved = localStorage.getItem('salem_theme');
  const theme = saved === 'light' || saved === 'dark' ? saved : 'dark';
  applyTheme(theme);
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
  renderThemeBtn();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('salem_theme', theme);
  const meta = q('meta[name=theme-color]');
  if (meta) meta.content = theme === 'dark' ? '#0a0c11' : '#f4f6fb';
}

function currentIcon() {
  return document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon';
}

function renderThemeBtn() {
  el('theme-btn').innerHTML = ii(currentIcon(), 19);
}