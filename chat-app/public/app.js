const API = '';
let token = localStorage.getItem('chat_token');
let me = JSON.parse(localStorage.getItem('chat_user') || 'null');
let socket = null;
let members = [];
let onlineIds = new Set();
let currentChatUser = null;
let typingTimeout = null;

const $ = (id) => document.getElementById(id);

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('login-form').classList.toggle('hidden', tab !== 'login');
    $('register-form').classList.toggle('hidden', tab !== 'register');
  });
});

// ---------- Auth ----------
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const username = $('login-username').value;
  const password = $('login-password').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setSession(data.token, data.user);
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('register-error').textContent = '';
  const username = $('register-username').value;
  const password = $('register-password').value;
  try {
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setSession(data.token, data.user);
  } catch (err) {
    $('register-error').textContent = err.message;
  }
});

function setSession(t, u) {
  token = t; me = u;
  localStorage.setItem('chat_token', t);
  localStorage.setItem('chat_user', JSON.stringify(u));
  boot();
}

$('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('chat_token');
  localStorage.removeItem('chat_user');
  if (socket) socket.disconnect();
  location.reload();
});

// ---------- Avatar helper ----------
function initials(name) { return name.trim()[0].toUpperCase(); }
function paintAvatar(el, user) {
  el.textContent = initials(user.username);
  el.style.background = user.avatar_color;
}

// ---------- Boot ----------
async function boot() {
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  paintAvatar($('my-avatar'), me);
  $('my-name').textContent = me.username;

  connectSocket();
  await loadMembers();
}

async function loadMembers() {
  const res = await fetch('/api/members', { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) return logoutForced();
  members = await res.json();
  renderMembers();
}

function renderMembers() {
  const list = $('members-list');
  list.innerHTML = '';
  $('no-members').classList.toggle('hidden', members.length > 0);
  members.forEach(u => {
    const li = document.createElement('li');
    li.className = 'member-item';
    const isOn = onlineIds.has(u.id);
    li.innerHTML = `
      <div class="avatar" style="background:${u.avatar_color}">${initials(u.username)}</div>
      <div class="member-info">
        <div class="member-name">${escapeHtml(u.username)}</div>
        <div class="member-sub">${isOn ? 'متصل الآن' : 'غير متصل'}</div>
      </div>
      <div class="online-dot ${isOn ? 'on' : ''}"></div>
    `;
    li.addEventListener('click', () => openChat(u));
    list.appendChild(li);
  });
}

function logoutForced() {
  localStorage.clear();
  location.reload();
}

// ---------- Socket ----------
function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('online-users', (ids) => {
    onlineIds = new Set(ids);
    renderMembers();
    if (currentChatUser) updateChatStatus();
  });

  socket.on('new-message', (msg) => {
    if (currentChatUser && msg.sender_id === currentChatUser.id) {
      appendMessage(msg, false);
      scrollMessagesToBottom();
    }
  });

  socket.on('message-sent', (msg) => {
    if (currentChatUser && msg.receiver_id === currentChatUser.id) {
      appendMessage(msg, true);
      scrollMessagesToBottom();
    }
  });

  socket.on('typing', ({ fromUserId }) => {
    if (currentChatUser && fromUserId === currentChatUser.id) {
      $('typing-indicator').classList.remove('hidden');
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => $('typing-indicator').classList.add('hidden'), 1800);
    }
  });
}

// ---------- Chat view ----------
async function openChat(user) {
  currentChatUser = user;
  $('members-view').classList.add('hidden');
  $('chat-view').classList.remove('hidden');
  paintAvatar($('chat-avatar'), user);
  $('chat-username').textContent = user.username;
  updateChatStatus();
  $('messages').innerHTML = '';
  $('typing-indicator').classList.add('hidden');

  const res = await fetch(`/api/messages/${user.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const msgs = await res.json();
  msgs.forEach(m => appendMessage(m, m.sender_id === me.id));
  scrollMessagesToBottom();
  $('message-input').focus();
}

function updateChatStatus() {
  const isOn = onlineIds.has(currentChatUser.id);
  const el = $('chat-status');
  el.textContent = isOn ? 'متصل الآن' : 'غير متصل';
  el.classList.toggle('on', isOn);
}

$('back-btn').addEventListener('click', () => {
  currentChatUser = null;
  $('chat-view').classList.add('hidden');
  $('members-view').classList.remove('hidden');
  loadMembers();
});

function appendMessage(msg, mine) {
  const row = document.createElement('div');
  row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;
  const time = new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  row.innerHTML = `<div class="bubble">${escapeHtml(msg.content)}<span class="msg-time">${time}</span></div>`;
  $('messages').appendChild(row);
}

function scrollMessagesToBottom() {
  const el = $('messages');
  el.scrollTop = el.scrollHeight;
}

$('message-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('message-input');
  const content = input.value.trim();
  if (!content || !currentChatUser) return;
  socket.emit('private-message', { toUserId: currentChatUser.id, content });
  input.value = '';
});

let lastTypingEmit = 0;
$('message-input').addEventListener('input', () => {
  if (!currentChatUser) return;
  const now = Date.now();
  if (now - lastTypingEmit > 1200) {
    socket.emit('typing', { toUserId: currentChatUser.id });
    lastTypingEmit = now;
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Init ----------
if (token && me) boot();
