import { api } from './api.js';
import { el, q, qa, esc, avClass, avatarInner, timeOf, dayStamp, toast, userFlagHtml, userTimezone, timeInTimezone } from './ui.js';
import { icon as ii } from './icons.js';
import { emitRead, emitReaction } from './socket.js';
import { store, getConv, getMessages, clearLocalUnread, isGroup, getMembers, setMembers, memberOf } from './store.js';
import { showMenu } from './menu.js';

const PAGE = 45;
const MAX_ROWS = 900;
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥'];

function fmtSize(bytes) {
  const n = Number(bytes);
  if (!n || n < 1) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

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
  ensureGroupMembers(conv).then(() => {
    if (store.activeConvId === convId) {
      if (getConv(convId)) {
        paintHeader(getConv(convId));
        updateChatStatus(getConv(convId));
      }
    }
  });
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
      const d = elOrCreate('thread-empty', 'تعذّر تحميل الرسائل — أعد المحاولة.');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost retry-btn';
      btn.textContent = 'إعادة المحاولة';
      btn.addEventListener('click', () => {
        d.remove();
        if (thread._loading) return;
        thread.loaded = false;
        thread._loading = true;
        preserveLoader();
        const sk = document.createElement('div');
        sk.className = 'thread-skel';
        sk.innerHTML = skLines(12);
        messagesEl.appendChild(sk);
        loadFirstPage(thread);
      });
      d.appendChild(btn);
      messagesEl.appendChild(d);
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
  let prevRow = null;
  for (const m of thread.items) {
    const dk = dayKey(m.created_at);
    if (dk && dk !== curDay) {
      curDay = dk;
      frag.appendChild(daySep(m.created_at));
      prevRow = null;
    }
    const row = buildRow(m, false, prevRow);
    frag.appendChild(row);
    prevRow = row;
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
  if (conv && isGroup(conv)) {
    const mem = memberOf(cid, m.sender_id);
    if (mem) return { mine: false, name: mem.username, member: mem };
    return { mine: false, name: 'عضو' };
  }
  if (conv && conv.other && conv.other.id === m.sender_id) return { mine: false, name: conv.other.username };
  return { mine: false, name: 'مستخدم' };
}

async function ensureGroupMembers(conv) {
  if (!conv || !isGroup(conv)) return;
  if (getMembers(conv.id).size > 0) return;
  try {
    const data = await api.get(`/api/conversations/${conv.id}/members`);
    setMembers(conv.id, data.members || []);
  } catch {}
}

function buildRow(m, tmp = false, prevRow = null) {
  const cid = m.conversation_id || store.activeConvId;
  const { mine, name, member } = senderOf(cid, m);
  const grouped = !!(
    prevRow &&
    prevRow.classList &&
    prevRow.classList.contains('msg-row') &&
    prevRow.dataset.day === dayKey(m.created_at) &&
    prevRow.classList.contains('mine') === mine &&
    prevRow.dataset.sender === String(m.sender_id)
  );
  const row = document.createElement('div');
  row.className = `msg-row ${mine ? 'mine' : 'theirs'}${grouped ? ' grouped' : ''}`;
  row.dataset.sender = String(m.sender_id);
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
    bubble.appendChild(body);
  } else if (m.kind === 'image' && m.media_url) {
    bubble.classList.add('media');
    const link = document.createElement('a');
    link.className = 'media-link';
    link.href = m.media_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.src = m.media_url;
    img.alt = m.media_name || 'صورة';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.classList.add('broken'));
    link.appendChild(img);
    bubble.appendChild(link);
    if (m.content) {
      body.textContent = m.content;
      bubble.appendChild(body);
    }
  } else if (m.kind === 'file' && m.media_url) {
    bubble.classList.add('media');
    const fa = document.createElement('a');
    fa.className = 'msg-file';
    fa.href = m.media_url;
    fa.download = m.media_name || 'ملف';
    fa.rel = 'noopener noreferrer';
    fa.innerHTML = `<span class="file-ico">${ii('clip', 20)}</span>
      <span class="file-info">
        <span class="file-name">${esc(m.media_name || 'ملف')}</span>
        <span class="file-meta">${fmtSize(m.media_size)}</span>
      </span>`;
    bubble.appendChild(fa);
    if (m.content) {
      body.textContent = m.content;
      bubble.appendChild(body);
    }
  } else if (m.kind && m.kind !== 'text') {
    bubble.classList.add('media');
    body.textContent = m.kind === 'image' ? 'صورة' : 'ملف';
    bubble.appendChild(body);
  } else {
    body.textContent = m.content || '';
    bubble.appendChild(body);
  }
  inner.appendChild(bubble);

  if (!m.deleted) {
    inner.appendChild(buildReactionsBar(m));
  }

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
    const xb = document.createElement('button');
    xb.type = 'button';
    xb.className = 'act-btn';
    xb.setAttribute('aria-label', 'تفاعل');
    xb.innerHTML = '🙂';
    xb.addEventListener('click', (e) => {
      e.stopPropagation();
      openReactionPicker(m, xb);
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
    actions.appendChild(xb);
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
  if (!mine && conv && (conv.other || isGroup(conv))) {
    const src = member || conv.other;
    if (src) {
      const av = document.createElement('span');
      av.className = `avatar xs ${avClass(src.avatar_color)}`;
      av.innerHTML = avatarInner(src);
      row.appendChild(av);
    }
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

function buildReactionsBar(m) {
  const bar = document.createElement('div');
  bar.className = 'msg-reactions';
  bar.dataset.forId = String(m.id);
  renderReactionPills(bar, m.reactions || []);
  return bar;
}

function renderReactionPills(bar, reactions) {
  bar.innerHTML = '';
  if (!reactions || !reactions.length) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  for (const r of reactions) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `reaction-pill${r.mine ? ' mine' : ''}`;
    pill.innerHTML = `<span>${esc(r.emoji)}</span><span class="reaction-count">${r.count}</span>`;
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleReaction(Number(bar.dataset.forId), r.emoji);
    });
    bar.appendChild(pill);
  }
}

let openPicker = null;
function closeReactionPicker() {
  if (openPicker) {
    openPicker.remove();
    openPicker = null;
    document.removeEventListener('click', closeReactionPicker, true);
  }
}

function openReactionPicker(m, anchor) {
  closeReactionPicker();
  const pop = document.createElement('div');
  pop.className = 'reaction-picker';
  for (const emoji of REACTION_EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'reaction-picker-btn';
    b.textContent = emoji;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleReaction(m.id, emoji);
      closeReactionPicker();
    });
    pop.appendChild(b);
  }
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const popW = pop.offsetWidth || 220;
  pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 8)}px`;
  pop.style.left = `${Math.min(window.innerWidth - popW - 8, Math.max(8, r.left))}px`;
  openPicker = pop;
  setTimeout(() => document.addEventListener('click', closeReactionPicker, true), 0);
}

async function toggleReaction(messageId, emoji) {
  const convId = store.activeConvId;
  const list = getMessages(convId).items;
  const idx = list.findIndex((x) => x.id === messageId);
  const res = await emitReaction(messageId, emoji);
  if (!res || !res.ok) {
    toast((res && res.error && res.error.message) || 'تعذّر إرسال التفاعل', 'error');
    return;
  }
  if (idx !== -1) {
    applyReactionToMessage(list[idx], { emoji, userId: store.me.id, added: res.added });
    const bar = q(`.msg-reactions[data-for-id="${messageId}"]`, messagesEl);
    if (bar) renderReactionPills(bar, list[idx].reactions);
  }
}

function applyReactionToMessage(message, { emoji, userId, added }) {
  const mine = store.me && userId === store.me.id;
  const reactions = message.reactions ? [...message.reactions] : [];
  const idx = reactions.findIndex((r) => r.emoji === emoji);
  if (added) {
    if (idx === -1) reactions.push({ emoji, count: 1, mine });
    else {
      reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, mine: reactions[idx].mine || mine };
    }
  } else if (idx !== -1) {
    const next = reactions[idx].count - 1;
    const stillMine = reactions[idx].mine && !mine;
    if (next <= 0) reactions.splice(idx, 1);
    else reactions[idx] = { ...reactions[idx], count: next, mine: stillMine };
  }
  message.reactions = reactions;
}

export function applyReactionUpdate(ev) {
  if (!ev || !ev.messageId) return;
  const convId = Number(ev.conversationId);
  const cache = store.messages.get(convId);
  if (!cache) return;
  const message = cache.items.find((x) => x.id === Number(ev.messageId));
  if (!message) return;
  applyReactionToMessage(message, ev);
  if (store.activeConvId === convId) {
    const bar = q(`.msg-reactions[data-for-id="${ev.messageId}"]`, messagesEl);
    if (bar) renderReactionPills(bar, message.reactions);
  }
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
  messagesEl.appendChild(buildRow(m, false, last));
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
  if (store.activeConvId === convId) {
    const last = messagesEl.lastElementChild;
    messagesEl.appendChild(buildRow(tmp, true, last));
    if (atBottom() || isMine(tmp)) scrollBottom(true);
  }
}

export function confirmPending(convId, tmpId, confirmed) {
  if (!confirmed) return rejectPending(convId, tmpId);
  const thread = getMessages(convId);
  const idx = thread.items.findIndex((m) => m.id === tmpId);
  if (idx >= 0) thread.items[idx] = confirmed;
  if (store.activeConvId !== convId) return;
  const row = q(`[data-tmp="${tmpId}"]`, messagesEl);
  if (row) {
    row.replaceWith(buildRow(confirmed, false, row.previousElementSibling));
    if (atBottom() || isMine(confirmed)) scrollBottom(true);
    return;
  }
  const last = messagesEl.lastElementChild;
  messagesEl.appendChild(buildRow(confirmed, false, last));
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
      let prevRow = null;
      for (const m of old) {
        const dk = dayKey(m.created_at);
        if (dk && dk !== curDay) {
          curDay = dk;
          frag.appendChild(daySep(m.created_at));
          prevRow = null;
        }
        const row = buildRow(m, false, prevRow);
        frag.appendChild(row);
        prevRow = row;
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
  if (isGroup(conv)) {
    const name = conv.name || 'مجموعة';
    const av = el('chat-avatar');
    av.innerHTML = '';
    av.classList.remove('av0', 'av1', 'av2', 'av3', 'av4', 'av5', 'av6', 'av7');
    av.classList.add(avClass(name));
    av.innerHTML = `<span class="avatar-letter">${esc(Array.from(name)[0] || '؟')}</span>`;
    el('chat-name').innerHTML = `${esc(name)}`;
    updateChatStatus(conv);
    return;
  }
  const other = conv.other || {};
  const puser = other.id ? store.presenceUsers.get(other.id) : null;
  const user = {
    username: other.username || conv.name,
    avatar_color: other.avatar_color,
    country: other.country || (puser && puser.country) || null,
    tz_ip: other.tz_ip || (puser && puser.tz_ip) || null,
    tz_local: other.tz_local || (puser && puser.tz_local) || null,
    avatar_url: (puser && puser.avatar_url) || other.avatar_url
  };
  const av = el('chat-avatar');
  av.innerHTML = '';
  av.classList.remove('av0', 'av1', 'av2', 'av3', 'av4', 'av5', 'av6', 'av7');
  av.classList.add(avClass(user.avatar_color));
  av.innerHTML = avatarInner(user);
  el('chat-name').innerHTML = `${esc(user.username)}${userFlagHtml(user)}`;
  updateChatStatus(conv);
}

export function updateChatStatus(conv) {
  if (!conv || store.activeConvId !== Number(conv.id)) return;
  if (isGroup(conv)) {
    const members = getMembers(conv.id);
    const total = conv.memberCount || members.size || 0;
    let onlineCount = 0;
    for (const m of members.values()) if (m.online) onlineCount++;
    const tz = null;
    el('chat-status-text').textContent = total
      ? `${total} عضو${onlineCount ? ` · ${onlineCount} متصل` : ''}`
      : 'مجموعة';
    el('chat-status').classList.toggle('on', false);
  } else {
    const online = !!(conv.other && store.presence.has(conv.other.id));
    el('chat-status-text').textContent = online ? 'متصل الآن' : 'غير متصل';
    const tz = userTimezone(conv.other);
    const lt = timeInTimezone(tz);
    if (lt) el('chat-status-text').textContent += ` · ${lt} محليًا`;
    el('chat-status').classList.toggle('on', online);
  }
}

setInterval(() => {
  const convId = store.activeConvId;
  if (!convId) return;
  const conv = getConv(convId);
  if (conv && (isGroup(conv) || userTimezone(conv.other))) updateChatStatus(conv);
}, 60000);

export function scrollBottom(smooth = false) {
  if (prefersReduced()) smooth = false;
  const target = messagesEl.scrollHeight;
  const distance = target - messagesEl.scrollTop - messagesEl.clientHeight;
  const behavior = smooth && distance <= 400 ? 'smooth' : 'auto';
  messagesEl.scrollTo({ top: target, behavior });
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