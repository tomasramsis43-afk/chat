import { api, ApiError } from './api.js';
import { toast, el, esc, qa } from './ui.js';

// ===== المظهر =====
(function initTheme() {
  const saved = localStorage.getItem('salem_theme');
  document.documentElement.dataset.theme = saved === 'light' || saved === 'dark' ? saved : 'dark';
})();
el('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('salem_theme', next);
});

const REASON_LABEL = {
  spam: 'سبام',
  harassment: 'تحرّش/إزعاج',
  inappropriate_content: 'محتوى غير لائق',
  fake_profile: 'حساب وهمي',
  underage: 'قاصر',
  other: 'أخرى'
};

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

// ===== التحقق من صلاحية الدخول =====
async function boot() {
  let me;
  try {
    const data = await api.get('/api/auth/me');
    me = data.user;
  } catch {
    return location.replace('/');
  }
  if (!me || me.role !== 'admin') {
    return location.replace('/');
  }
  el('admin-whoami').textContent = `مسجّل الدخول: ${me.username}`;
  el('admin-gate').classList.add('hidden');
  el('admin-root').classList.remove('hidden');
  setupTabs();
  loadOverview();
}

// ===== التبويبات =====
function setupTabs() {
  qa('.admin-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      qa('.admin-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      qa('.admin-panel').forEach((p) => p.classList.add('hidden'));
      el(`tab-${tab}`).classList.remove('hidden');
      if (tab === 'overview') loadOverview();
      if (tab === 'users') loadUsers(true);
      if (tab === 'reports') loadReports();
      if (tab === 'conversations') loadConversations(true);
      if (tab === 'audit') loadAudit();
    });
  });
}

// ===== نظرة عامة =====
async function loadOverview() {
  const grid = el('stats-grid');
  grid.innerHTML = '<div class="sk sk-l1"></div>';
  try {
    const s = await api.get('/api/admin/stats');
    const cards = [
      ['إجمالي المستخدمين', s.totalUsers],
      ['متصل الآن', s.online],
      ['زوّار', s.guests],
      ['محظورون', s.banned],
      ['بلاغات مفتوحة', s.openReports],
      ['أدمن', s.admins]
    ];
    grid.innerHTML = cards
      .map(([label, val]) => `<div class="stat-card"><div class="stat-val">${esc(val)}</div><div class="stat-label">${esc(label)}</div></div>`)
      .join('');
    const badge = el('reports-badge');
    if (s.openReports > 0) {
      badge.textContent = String(s.openReports);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) {
    toast(e.message || 'تعذر تحميل الإحصائيات');
  }
}

// ===== المستخدمين =====
let usersCursor = null;
let usersSearchTimer = null;

el('users-search').addEventListener('input', () => {
  clearTimeout(usersSearchTimer);
  usersSearchTimer = setTimeout(() => loadUsers(true), 300);
});
el('users-more').addEventListener('click', () => loadUsers(false));

async function loadUsers(reset) {
  if (reset) {
    usersCursor = null;
    el('users-tbody').innerHTML = '';
  }
  const q = el('users-search').value.trim();
  const params = new URLSearchParams({ limit: '30' });
  if (q) params.set('q', q);
  if (usersCursor !== null) params.set('cursor', String(usersCursor));
  try {
    const data = await api.get(`/api/admin/users?${params}`);
    const tbody = el('users-tbody');
    for (const u of data.users) {
      tbody.appendChild(renderUserRow(u));
    }
    usersCursor = data.nextCursor;
    el('users-more').classList.toggle('hidden', usersCursor === null);
  } catch (e) {
    toast(e.message || 'تعذر تحميل المستخدمين');
  }
}

function renderUserRow(u) {
  const tr = document.createElement('tr');
  const statusHtml = u.banned_at
    ? `<span class="pill danger" title="${esc(u.banned_reason || '')}">موقوف</span>`
    : u.online
    ? '<span class="pill ok">أونلاين</span>'
    : '<span class="pill muted">—</span>';

  tr.innerHTML = `
    <td class="cell-user">${esc(u.username)}</td>
    <td>${u.is_guest ? 'زائر' : 'مسجّل'}</td>
    <td>${u.role === 'admin' ? '<span class="pill accent">أدمن</span>' : 'عضو'}</td>
    <td>${statusHtml}</td>
    <td class="cell-dim">${esc(fmtDate(u.created_at))}</td>
    <td class="cell-actions"></td>
  `;
  const actions = tr.querySelector('.cell-actions');

  if (u.role !== 'admin') {
    const banBtn = document.createElement('button');
    banBtn.className = 'btn btn-ghost btn-sm';
    banBtn.textContent = u.banned_at ? 'فك الحظر' : 'حظر';
    banBtn.addEventListener('click', () => (u.banned_at ? unbanUser(u.id, tr) : banUser(u.id, u.username, tr)));
    actions.appendChild(banBtn);

    const promoteBtn = document.createElement('button');
    promoteBtn.className = 'btn btn-ghost btn-sm';
    promoteBtn.textContent = 'ترقية لأدمن';
    promoteBtn.addEventListener('click', () => promoteUser(u.id));
    actions.appendChild(promoteBtn);
  } else {
    const demoteBtn = document.createElement('button');
    demoteBtn.className = 'btn btn-ghost btn-sm';
    demoteBtn.textContent = 'إلغاء صلاحية الأدمن';
    demoteBtn.addEventListener('click', () => demoteUser(u.id));
    actions.appendChild(demoteBtn);
  }
  return tr;
}

async function banUser(id, username, tr) {
  const reason = prompt(`سبب حظر "${username}" (اختياري):`, '');
  if (reason === null) return;
  try {
    await api.post(`/api/admin/users/${id}/ban`, { reason });
    toast('تم حظر المستخدم', 'ok');
    loadUsers(true);
  } catch (e) {
    toast(e.message || 'تعذر الحظر');
  }
}

async function unbanUser(id) {
  try {
    await api.post(`/api/admin/users/${id}/unban`, {});
    toast('تم فك الحظر', 'ok');
    loadUsers(true);
  } catch (e) {
    toast(e.message || 'تعذر فك الحظر');
  }
}

async function promoteUser(id) {
  if (!confirm('ترقية هذا المستخدم إلى أدمن بصلاحيات كاملة؟')) return;
  try {
    await api.post(`/api/admin/users/${id}/promote`, {});
    toast('تمت الترقية', 'ok');
    loadUsers(true);
  } catch (e) {
    toast(e.message || 'تعذرت الترقية');
  }
}

async function demoteUser(id) {
  if (!confirm('إلغاء صلاحيات الأدمن لهذا المستخدم؟')) return;
  try {
    await api.post(`/api/admin/users/${id}/demote`, {});
    toast('تم الإلغاء', 'ok');
    loadUsers(true);
  } catch (e) {
    toast(e.message || 'تعذر الإلغاء');
  }
}

// ===== البلاغات =====
let reportsStatus = 'open';
qa('#reports-status .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    qa('#reports-status .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    reportsStatus = btn.dataset.status;
    loadReports();
  });
});

async function loadReports() {
  const list = el('reports-list');
  list.innerHTML = '<div class="sk sk-l1"></div>';
  try {
    const data = await api.get(`/api/admin/reports?status=${reportsStatus}&limit=50`);
    if (!data.reports.length) {
      list.innerHTML = '<p class="empty-hint">لا توجد بلاغات هنا.</p>';
      return;
    }
    list.innerHTML = '';
    for (const r of data.reports) list.appendChild(renderReportCard(r));
  } catch (e) {
    toast(e.message || 'تعذر تحميل البلاغات');
  }
}

function renderReportCard(r) {
  const card = document.createElement('div');
  card.className = 'admin-card';
  card.innerHTML = `
    <div class="admin-card-head">
      <strong>${esc(r.target.username)}</strong>
      ${r.target.banned ? '<span class="pill danger">موقوف</span>' : ''}
      <span class="pill">${esc(REASON_LABEL[r.reason] || r.reason)}</span>
      <span class="cell-dim">${esc(fmtDate(r.created_at))}</span>
    </div>
    <p class="admin-card-body">${r.details ? esc(r.details) : '<span class="cell-dim">بدون تفاصيل إضافية</span>'}</p>
    <p class="cell-dim">بلاغ من: ${esc(r.reporter.username)}</p>
    <div class="admin-card-actions"></div>
  `;
  const actions = card.querySelector('.admin-card-actions');
  if (r.status === 'open' || r.status === 'reviewing') {
    if (r.conversation_id) {
      const viewBtn = document.createElement('button');
      viewBtn.className = 'btn btn-ghost btn-sm';
      viewBtn.textContent = 'فتح المحادثة';
      viewBtn.addEventListener('click', () => openConversation(r.conversation_id, `محادثة — بلاغ #${r.id}`));
      actions.appendChild(viewBtn);
    }
    const resolveBtn = document.createElement('button');
    resolveBtn.className = 'btn btn-primary btn-sm';
    resolveBtn.textContent = 'تم الحل';
    resolveBtn.addEventListener('click', () => resolveReport(r.id, 'resolved'));
    actions.appendChild(resolveBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn btn-ghost btn-sm';
    dismissBtn.textContent = 'رفض البلاغ';
    dismissBtn.addEventListener('click', () => resolveReport(r.id, 'dismissed'));
    actions.appendChild(dismissBtn);
  }
  return card;
}

async function resolveReport(id, status) {
  try {
    await api.post(`/api/admin/reports/${id}/resolve`, { status });
    toast('تم التحديث', 'ok');
    loadReports();
    loadOverview();
  } catch (e) {
    toast(e.message || 'تعذر التحديث');
  }
}

// ===== المحادثات =====
let convCursor = null;
el('conversations-more').addEventListener('click', () => loadConversations(false));

async function loadConversations(reset) {
  if (reset) {
    convCursor = null;
    el('conversations-list').innerHTML = '';
  }
  const params = new URLSearchParams({ limit: '30' });
  if (convCursor !== null) params.set('cursor', String(convCursor));
  try {
    const data = await api.get(`/api/admin/conversations?${params}`);
    const list = el('conversations-list');
    for (const c of data.conversations) list.appendChild(renderConversationCard(c));
    convCursor = data.nextCursor;
    el('conversations-more').classList.toggle('hidden', convCursor === null);
  } catch (e) {
    toast(e.message || 'تعذر تحميل المحادثات');
  }
}

function renderConversationCard(c) {
  const names = c.members.map((m) => m.username).join(' ، ') || '—';
  const card = document.createElement('div');
  card.className = 'admin-card';
  card.innerHTML = `
    <div class="admin-card-head">
      <strong>${esc(names)}</strong>
      <span class="pill">${c.type === 'dm' ? 'محادثة فردية' : 'مجموعة'}</span>
      <span class="cell-dim">${esc(c.message_count)} رسالة</span>
    </div>
    <p class="cell-dim">آخر نشاط: ${esc(fmtDate(c.last_message_at || c.created_at))}</p>
    <div class="admin-card-actions"></div>
  `;
  const btn = document.createElement('button');
  btn.className = 'btn btn-ghost btn-sm';
  btn.textContent = 'عرض الرسائل';
  btn.addEventListener('click', () => openConversation(c.id, names));
  card.querySelector('.admin-card-actions').appendChild(btn);
  return card;
}

async function openConversation(id, title) {
  const overlay = el('conv-viewer');
  const body = el('conv-viewer-messages');
  el('conv-viewer-title').textContent = title || 'رسائل المحادثة';
  body.innerHTML = '<div class="sk sk-l1"></div>';
  overlay.classList.remove('hidden');
  try {
    const data = await api.get(`/api/admin/conversations/${id}/messages?limit=100`);
    if (!data.messages.length) {
      body.innerHTML = '<p class="empty-hint">لا توجد رسائل.</p>';
      return;
    }
    body.innerHTML = '';
    for (const m of data.messages) {
      const row = document.createElement('div');
      row.className = 'audit-log-msg';
      row.innerHTML = `<span class="cell-dim">${esc(fmtDate(m.created_at))} — مرسل #${esc(m.sender_id)}</span><p>${m.deleted ? '<em>[محذوفة]</em>' : esc(m.content || (m.kind !== 'text' ? `[${esc(m.kind)}]` : ''))}</p>`;
      body.appendChild(row);
    }
  } catch (e) {
    body.innerHTML = `<p class="empty-hint">${esc(e.message || 'تعذر التحميل')}</p>`;
  }
}

el('conv-viewer-close').addEventListener('click', () => el('conv-viewer').classList.add('hidden'));
el('conv-viewer').addEventListener('click', (e) => {
  if (e.target.id === 'conv-viewer') el('conv-viewer').classList.add('hidden');
});

// ===== سجل التدقيق =====
const ACTION_LABEL = {
  ban_user: 'حظر مستخدم',
  unban_user: 'فك حظر مستخدم',
  promote_admin: 'ترقية لأدمن',
  demote_admin: 'إلغاء صلاحية أدمن',
  resolve_report: 'حل/رفض بلاغ',
  view_conversation_messages: 'فتح رسائل محادثة'
};

async function loadAudit() {
  const list = el('audit-list');
  list.innerHTML = '<div class="sk sk-l1"></div>';
  try {
    const data = await api.get('/api/admin/audit-log?limit=100');
    if (!data.entries.length) {
      list.innerHTML = '<p class="empty-hint">لا يوجد سجل بعد.</p>';
      return;
    }
    list.innerHTML = '';
    for (const en of data.entries) {
      const row = document.createElement('div');
      row.className = 'audit-row';
      const label = ACTION_LABEL[en.action] || en.action;
      row.innerHTML = `<span class="cell-dim">${esc(fmtDate(en.created_at))}</span><span><strong>${esc(en.admin)}</strong> — ${esc(label)}${en.target_id ? ` (#${esc(en.target_id)})` : ''}</span>`;
      list.appendChild(row);
    }
  } catch (e) {
    toast(e.message || 'تعذر تحميل السجل');
  }
}

boot();
