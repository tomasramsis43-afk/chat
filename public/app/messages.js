import { api } from './api.js';
import { el, q, qa, esc, avClass, avatarInner, timeOf, dayStamp, toast, flagHtml } from './ui.js';
import { icon as ii } from './icons.js';
import { emitRead } from './socket.js';
import { store, getConv, getMessages, clearLocalUnread } from './store.js';
import { showMenu } from './menu.js';

const PAGE = 45;
const MAX_ROWS = 900;

let onReplyClick = null;
let olderBusy = false;
let messagesEl = null;
let loaderEl = null;
let lastRenderAt = 0;

function scrollTopNearTop() {
  return messagesEl.scrollTop < 160;
}

function preserveLoader() {
  messagesEl.replaceChildren(loaderEl);
}

export function initMessages(opts = {}) {
  onReplyClick = opts.onReplyClick;
  messagesEl = el('messages');
  loaderEl = el('older-loader');

  q('.chat-head', el('chat-open')).addEventListener('click', (e) => {
    if (e.target.closest('#info-btn')) opts.onInfo && opts.onInfo();
  });

  messagesEl.addEventListener('scroll', () => {
    updateJumpPill();
    if (scrollTopNearTop() && Date.now() - lastRenderAt > 500) maybeLoadOlder();
  });

  el('jump-pill').addEventListener('click', () => {
    messagesEl.style.scrollBehavior = 'auto';
    scrollBottom();
    messagesEl.style.scrollBehavior = '';
    markActiveRead();
  });

  el('older-loader').addEventListener('click', maybeLoadOlder);
}

function dayKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function getActiveConvId() {
  return store.activeConvId;
}

function activeThread() {
  return store.activeConvId ? getMessages(store.activeConvId) : null;
}

export function openConversation(convId) {
  convId = Number(convId);
  if (store.activeConvId === convId) return;
  store.activeConvId = convId;
  const sidebar = el('sidebar');
  if (window.matchMedia('(max-width: 919px)').matches) sidebar.classList.add('away');
  document.body.classList.add('chat-active');

  const conv = getConv(convId);
  if (conv) paintHeader(conv);

  const thread = getMessages(convId);
  el('chat-open').classList.remove('hidden');
  el('chat-empty').classList.add('hidden');

  if (thread.loaded && thread.items.length) {
    renderThread(thread);
    return;
  }
  if (!thread._loading) {
    thread._loading = true;
    preserveLoader();
    const sk = document.createElement('div');
    sk.className = 'thread-skel';
    sk.innerHTML = skLines(12);
    messagesEl.appendChild(sk);
    loadFirstPage(thread);
  }
}

function skLines(n) {
  return Array.from({ length: n }, () => '<div class="sk sk-msg"></div>').join('');
}

async function loadFirstPage(thread) {
  const convId = store.activeConvId;
  const url = `/api/conversations/${convId}/messages?limit=${PAGE}`;
  try {
    const data = await api.get(url);
    if (store.activeConvId !== convId) return;
    thread._loading = false;
    thread.loaded = true;
    thread.nextBefore = data.nextBefore;
    thread.items = data.messages || [];
    if (!thread.items.length) {
      preserveLoader();
      messagesEl.appendChild(elOrCreate('thread-empty', 'ابدأ بكتابة أول رسالة.'));
    } else {
      renderThread(thread);
    }
  } catch (err) {
    console.error('[messages] loadFirstPage failed', url, err && err.status, err && err.message);
    if (store.activeConvId === convId) {
      thread._loading = false;
      preserveLoader();
      messagesEl.appendChild(elOrCreate('thread-empty', 'تعذّر تحميل الرسائل — أعد المحاولة.'));
    }
  }
}

function elOrCreate(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}

export function renderThread(thread) {
  const convId = store.activeConvId;
  if (!convId) return;
  el('chat-open').classList.remove('hidden');
  el('chat-empty').classList.add('hidden');
  preserveLoader();
  lastRenderAt = Date.now();
  el('older-loader').classList.toggle('hidden', !thread.nextBefore);
  if (!thread.nextBefore) {
    el('older-loader').style.display = 'none';
  } else {
    el('older-loader').style.display = '';
  }
  const frag = document.createDocumentFragment();
  let curDay = '';
  for (const m of thread.items) {
    const dk = dayKey(m.created_at);
    if (dk && dk !== curDay) {
      curDay = dk;
      frag.appendChild(daySep(m.created_at));
    }
    frag.appendChild(buildRow(m));
  }
  messagesEl.appendChild(frag);
  pruneRows();
  scrollBottom(false);
  markActiveRead();
}

function daySep(iso) {
  const s = document.createElement('div');
  s.className = 'day-sep';
  s.textContent = dayStamp(iso);
  return s;
}

function senderOf(cid, m) {
  const me = store.me;
  if (me && m.sender_id === me.id) return { mine: true, name: me.username };
  const conv = getConv(cid);
  if (conv && conv.other && conv.other.id === m.sender_id) return { mine: false, name: conv.other.username };
  return { mine: false, name: 'مستخدم' };
}

function buildRow(m, tmp = false) {
  const cid = m.conversation_id || store.activeConvId;
  const { mine, name } = senderOf(cid, m);
  const row = document.createElement('div');
  row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;
  row.dataset.id = String(m.id);
  row.dataset.day = dayKey(m.created_at);
  if (tmp) row.dataset.tmp = String(m.id);
  row.tabIndex = 0;

  const inner = document.createElement('div');
  inner.className = 'msg-inner';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.reply_to_id) bubble.appendChild(replyPreview(cid, m.reply_to_id, mine));

  const body = document.createElement('div');
  body.className = 'bubble-body';
  if (m.deleted) {
    bubble.classList.add('deleted');
    body.textContent = 'حُذفت هذه الرسالة';
  } else if (m.kind && m.kind !== 'text') {
    bubble.classList.add('media');
    body.textContent = `${m.kind === 'image' ? 'صورة' : m.kind === 'file' ? 'ملف' : 'مرفق'} (قريبًا)`;
  } else {
    body.textContent = m.content || '';
  }
  bubble.appendChild(body);
  inner.appendChild(bubble);

  if (!m.deleted) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const rb = document.createElement('button');
    rb.type = 'button';
    rb.className = 'act-btn';
    rb.setAttribute('aria-label', 'رد');
    rb.innerHTML = ii('reply', 15);
    rb.addEventListener('click', (e) => {
      e.stopPropagation();
      onReplyClick && onReplyClick(m);
    });
    const mb = document.createElement('button');
    mb.type = 'button';
    mb.className = 'act-btn';
    mb.setAttribute('aria-label', 'المزيد');
    mb.innerHTML = ii('more', 15);
    mb.addEventListener('click', (e) => {
      e.stopPropagation();
      openMsgMenu(m, mb);
    });
    actions.appendChild(rb);
    actions.appendChild(mb);
    inner.appendChild(actions);
  }

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const t = document.createElement('span');
  t.className = 'msg-time';
  t.textContent = timeOf(m.created_at);
  meta.appendChild(t);
  if (mine) {
    const state = document.createElement('span');
    state.className = `msg-state${tmp ? ' pending' : ' read'}`;
    state.innerHTML = tmp ? ii('clock', 13) : ii('checkAll', 13);
    meta.appendChild(state);
  }
  inner.appendChild(meta);
  row.appendChild(inner);

  const conv = getConv(cid);
  if (!mine && conv && conv.other) {
    const av = document.createElement('span');
    av.className = `avatar xs ${avClass(conv.other.avatar_color)}`;
    av.innerHTML = avatarInner(conv.other);
    row.appendChild(av);
  }

  row.addEventListener('click', () => {
    if (store.activeConvId) markActiveRead();
  });
  wireRowMenu(row, m);
  return row;
}

function wireRowMenu(row, m) {
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMsgMenu(m, row, e.clientX, e.clientY);
  });
  let timer = null;
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      timer = setTimeout(() => openMsgMenu(m, row, e.clientX, e.clientY), 560);
    }
  });
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  row.addEventListener('pointerup', clear);
  row.addEventListener('pointermove', clear);
  row.addEventListener('pointercancel', clear);
  row.addEventListener('scroll', clear, true);
}

function openMsgMenu(m, anchor, x, y) {
  const items = [
    { icon: 'reply', label: 'رد', action: () => onReplyClick && onReplyClick(m) },
    { icon: 'copy', label: 'نسخ النص', action: () => copyText(m.content || '') }
  ];
  if (x !== undefined && y !== undefined) showMenu(items, x, y);
  else {
    const r = anchor.getBoundingClientRect();
    showMenu(items, r.right, r.bottom + 6);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('تم النسخ', 'ok');
  } catch {
    toast('تعذّر النسخ', 'error');
  }
}

function replyPreview(cid, targetId, mine) {
  const block = document.createElement('div');
  block.className = 'reply-preview' + (mine ? ' mine' : '');
  const sender = document.createElement('span');
  sender.className = 'reply-preview-name';
  const text = document.createElement('span');
  text.className = 'reply-preview-text';
  const target = findMsg(cid, targetId);
  if (target) {
    sender.textContent = senderOf(cid, target).name;
    text.textContent = target.deleted ? 'رسالة محذوفة' : target.content || '';
  } else {
    sender.textContent = 'رد';
    text.textContent = 'رسالة سابقة';
  }
  block.appendChild(sender);
  block.appendChild(text);
  block.addEventListener('click', (e) => {
    e.stopPropagation();
    scrollToMessageById(targetId, cid);
  });
  return block;
}

function findMsg(cid, mid) {
  return getMessages(cid).items.find((m) => m.id === Number(mid));
}

export function appendIncoming(m) {
  const thread = activeThread();
  const convId = store.activeConvId;
  if (!thread || !convId) return;
  thread.items.push(m);

  const atBottomNow = atBottom();
  const dk = dayKey(m.created_at);
  const last = messagesEl.lastElementChild;
  const lastDay = last && last.classList.contains('msg-row') ? last.dataset.day : '';
  if (dk && dk !== lastDay) {
    messagesEl.appendChild(daySep(m.created_at));
  }
  messagesEl.appendChild(buildRow(m));
  pruneRows();

  const shouldScroll = atBottomNow || isMine(m);
  if (shouldScroll) {
    scrollBottom(true);
    markActiveRead();
  } else {
    updateJumpPill();
  }
}

function isMine(m) {
  return store.me && m.sender_id === store.me.id;
}

export function appendPending(convId, tmp) {
  const thread = getMessages(convId);
  thread.items.push(tmp);
  if (store.activeConvId === convId) messagesEl.appendChild(buildRow(tmp, true));
}

export function confirmPending(convId, tmpId, confirmed) {
  if (!confirmed) return rejectPending(convId, tmpId);
  const thread = getMessages(convId);
  const idx = thread.items.findIndex((m) => m.id === tmpId);
  if (idx >= 0) thread.items[idx] = confirmed;
  if (store.activeConvId !== convId) return;
  const row = q(`[data-tmp="${tmpId}"]`, messagesEl);
  if (row) {
    row.replaceWith(buildRow(confirmed));
    return;
  }
  messagesEl.appendChild(buildRow(confirmed));
  scrollBottom(true);
}

export function rejectPending(convId, tmpId) {
  const thread = getMessages(convId);
  const idx = thread.items.findIndex((m) => m.id === tmpId);
  if (idx >= 0) thread.items.splice(idx, 1);
  if (store.activeConvId !== convId) return;
  const row = q(`[data-tmp="${tmpId}"]`, messagesEl);
  if (row) {
    const prev = row.previousSibling;
    row.remove();
    if (prev && prev.classList && prev.classList.contains('day-sep') && !prev.nextSibling) prev.remove();
  }
  if (!thread.items.length) {
    preserveLoader();
    messagesEl.appendChild(elOrCreate('thread-empty', 'ابدأ بكتابة أول رسالة.'));
  }
}

export function handleReadEvent(ev) {
  if (!ev || Number(ev.userId) === store.me?.id) return;
  const convId = Number(ev.conversationId);
  const lastId = Number(ev.lastReadId);
  if (store.activeConvId !== convId) return;
  qa('.msg-row.mine', messagesEl).forEach((row) => {
    if (!row.dataset.tmp && Number(row.dataset.id) <= lastId) {
      const st = q('.msg-state', row);
      if (st) {
        st.classList.add('read');
        st.classList.remove('pending');
      }
    }
  });
}

export function scrollToMessageById(mid, cid) {
  const convId = Number(cid || store.activeConvId);
  const node = q(`[data-id="${mid}"]`, messagesEl);
  if (node) {
    node.scrollIntoView({ block: 'center' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    return;
  }
  const thread = getMessages(convId);
  if (!thread.loaded || !thread.nextBefore) {
    toast('الرسالة الأقدم غير محمّلة بعد', 'warn');
    return;
  }
  maybeLoadOlder().then(() => {
    const retry = q(`[data-id="${mid}"]`, messagesEl);
    if (retry) {
      retry.scrollIntoView({ block: 'center' });
      retry.classList.add('flash');
    } else {
      toast('تعذّر الوصول للرسالة الأصلية', 'warn');
    }
  });
}

async function maybeLoadOlder() {
  const convId = store.activeConvId;
  const thread = activeThread();
  if (!thread || olderBusy) return;
  if (thread.nextBefore === null || thread.nextBefore === undefined) {
    el('older-loader').style.display = 'none';
    el('older-loader').classList.add('hidden');
    return;
  }
  olderBusy = true;
  const loader = el('older-loader');
  loader.classList.remove('hidden');
  loader.style.display = '';
  loader.innerHTML = '<span class="spin"></span>جارٍ تحميل أقدم…';

  const before = thread.nextBefore;
  const anchorTop = messagesEl.scrollTop;
  const anchorH = messagesEl.scrollHeight;
  try {
    const data = await api.get(`/api/conversations/${convId}/messages?before=${before}&limit=${PAGE}`);
    if (store.activeConvId !== convId) return;
    const old = data.messages || [];
    thread.nextBefore = data.nextBefore;
    if (old.length) {
      thread.items = old.concat(thread.items);
      const frag = document.createDocumentFragment();
      let curDay = '';
      const curRow = messagesEl.querySelector('.msg-row');
      if (curRow) curDay = curRow.dataset.day;
      for (const m of old) {
        const dk = dayKey(m.created_at);
        if (dk && dk !== curDay) {
          curDay = dk;
          frag.appendChild(daySep(m.created_at));
        }
        frag.appendChild(buildRow(m));
      }
      messagesEl.insertBefore(frag, loader);
      messagesEl.scrollTop = Math.max(0, messagesEl.scrollHeight - anchorH + anchorTop);
    }
    if (thread.nextBefore === null || thread.nextBefore === undefined) {
      loader.classList.add('hidden');
      loader.style.display = 'none';
    } else {
      loader.innerHTML = 'تحميل أقدم الرسائل';
    }
  } catch {
    loader.innerHTML = 'تعذّر التحميل — اضغط للمحاولة';
  }
  olderBusy = false;
  updateJumpPill();
}

export function updateTyping(ev) {
  if (!store.activeConvId || Number(ev?.conversationId) !== store.activeConvId) return;
  el('typing-badge').classList.toggle('hidden', !ev);
  if (ev) {
    clearTimeout(updateTyping._t);
    updateTyping._t = setTimeout(() => el('typing-badge').classList.add('hidden'), 10000);
  }
}

export function paintHeader(conv) {
  if (!conv) return;
  const other = conv.other || {};
  const puser = other.id ? store.presenceUsers.get(other.id) : null;
  const user = {
    username: other.username || conv.name,
    avatar_color: other.avatar_color,
    country: other.country || (puser && puser.country),
    avatar_url: (puser && puser.avatar_url) || other.avatar_url
  };
  const av = el('chat-avatar');
  av.innerHTML = '';
  av.classList.remove('av0', 'av1', 'av2', 'av3', 'av4', 'av5', 'av6', 'av7');
  av.classList.add(avClass(user.avatar_color));
  av.innerHTML = avatarInner(user);
  el('chat-name').innerHTML = `${esc(user.username)}${flagHtml(user.country)}`;
  updateChatStatus(conv);
}

export function updateChatStatus(conv) {
  if (!conv || store.activeConvId !== Number(conv.id)) return;
  const online = !!(conv.other && store.presence.has(conv.other.id));
  el('chat-status-text').textContent = online ? 'متصل الآن' : 'غير متصل';
  el('chat-status').classList.toggle('on', online);
}

export function scrollBottom(smooth = false) {
  if (prefersReduced()) smooth = false;
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  updateJumpPill();
}

function atBottom(tol = 120) {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= tol;
}

function updateJumpPill() {
  if (!store.activeConvId) return;
  el('jump-pill').classList.toggle('show', !atBottom());
}

function markActiveRead() {
  const convId = store.activeConvId;
  if (!convId || store._lastReadId === convId) return;
  const thread = getMessages(convId);
  const lastIncoming = [...thread.items].reverse().find((m) => m.sender_id !== store.me?.id);
  if (!lastIncoming) return;
  store._lastReadId = convId;
  emitRead(convId, lastIncoming.id);
  const conv = getConv(convId);
  if (conv) {
    conv.unread = 0;
    conv.lastReadMessageId = lastIncoming.id;
  }
  clearLocalUnread(convId);
}

export function closeConversation() {
  store.activeConvId = null;
  document.body.classList.remove('chat-active');
  el('sidebar').classList.remove('away');
  el('chat-open').classList.add('hidden');
  el('chat-empty').classList.remove('hidden');
  el('typing-badge').classList.add('hidden');
  store._lastReadId = null;
}

export function pruneRows() {
  let rows = messagesEl.querySelectorAll('.msg-row');
  while (rows.length > MAX_ROWS) {
    const first = rows[0];
    if (!first) break;
    const prev = first.previousSibling;
    first.remove();
    if (prev && prev.classList && prev.classList.contains('day-sep')) prev.remove();
    rows = messagesEl.querySelectorAll('.msg-row');
  }
}

function prefersReduced() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}