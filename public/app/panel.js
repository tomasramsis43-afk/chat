import { el, esc, avClass, avatarInner, toast, userFlagHtml, userTimezone, timeInTimezone } from './ui.js';
import { icon as ii } from './icons.js';
import { api } from './api.js';
import { store, getConv, isMuted, isGroup, getMembers, setMembers } from './store.js';
import { toggleMute } from './prefs.js';

let openConvId = null;

export function initPanel() {
  el('panel-close').innerHTML = ii('close', 18);
  el('panel-close').addEventListener('click', closePanel);
  el('panel').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePanel();
  });
}

function memberRow(m, canManage, isOwner) {
  const div = document.createElement('div');
  div.className = 'member-row';
  div.innerHTML = `
    <span class="avatar sm ${avClass(m.avatar_color)} ${m.online ? 'is-online' : ''}">${avatarInner(m)}</span>
    <span class="member-info">
      <span class="member-name">${esc(m.username)}${userFlagHtml(m)}</span>
      <span class="member-sub">${m.role === 'owner' ? 'المالك' : m.role === 'admin' ? 'مدير' : (m.online ? 'متصل' : 'غير متصل')}</span>
    </span>
    ${canManage && m.id !== store.me?.id ? `<button type="button" class="icon-btn slim member-remove" data-uid="${m.id}" aria-label="إزالة العضو">${ii('close', 15)}</button>` : ''}
  `;
  if (isOwner && m.role !== 'owner' && m.id !== store.me?.id) {
    const promote = document.createElement('button');
    promote.type = 'button';
    promote.className = 'icon-btn slim member-promote';
    promote.dataset.uid = String(m.id);
    promote.setAttribute('aria-label', 'ترقية لمالك');
    promote.innerHTML = ii('chevron', 15);
    div.querySelector('.member-info').appendChild(promote);
  }
  return div;
}

async function fetchMembers(convId) {
  try {
    const data = await api.get(`/api/conversations/${convId}/members`);
    setMembers(convId, data.members || []);
  } catch {}
}

export function openPanel(convId) {
  convId = Number(convId);
  const conv = getConv(convId);
  if (!conv) return;
  openConvId = convId;
  const muted = isMuted(convId);
  const body = el('panel-body');
  body.innerHTML = '';
  body.replaceChildren();
  const frag = document.createDocumentFragment();

  if (isGroup(conv)) {
    const canManage = conv.role === 'owner' || conv.role === 'admin';
    const isOwner = conv.role === 'owner';
    const hero = document.createElement('div');
    hero.className = 'panel-hero';
    hero.innerHTML = `
      <span class="avatar xl ${avClass(conv.name)}">${avatarInner({ username: conv.name })}</span>
      <h3 class="panel-name">${esc(conv.name)}</h3>
      <p class="panel-status">${conv.memberCount || ''} عضو</p>
      ${canManage ? '<p class="panel-sub">أنت مدير هذه المجموعة</p>' : ''}
    `;
    frag.appendChild(hero);

    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    actions.innerHTML = `
      <button class="btn btn-ghost" type="button" data-act="copy-id">${ii('pen', 16)}<span>نسخ المعرّف</span></button>
      <button class="btn btn-ghost" type="button" data-act="mute">${ii('bell', 16)}<span>${muted ? 'إلغاء الكتم' : 'كتم الإشعارات'}</span></button>
      ${canManage ? `<button class="btn btn-ghost" type="button" data-act="rename">${ii('pen', 16)}<span>إعادة تسمية</span></button>` : ''}
      ${canManage ? `<button class="btn btn-ghost" type="button" data-act="add-member">${ii('plus', 16)}<span>إضافة عضو</span></button>` : ''}
      <button class="btn btn-ghost danger" type="button" data-act="leave">${ii('logout', 16)}<span>مغادرة</span></button>
      ${isOwner ? `<button class="btn btn-ghost danger" type="button" data-act="delete">${ii('trash', 16)}<span>حذف المجموعة</span></button>` : ''}
    `;
    frag.appendChild(actions);

    const listWrap = document.createElement('div');
    listWrap.className = 'members-wrap';
    const title = document.createElement('div');
    title.className = 'members-title';
    title.textContent = 'الأعضاء';
    listWrap.appendChild(title);
    const list = document.createElement('div');
    list.className = 'member-list';
    listWrap.appendChild(list);
    frag.appendChild(listWrap);

    const hint = document.createElement('p');
    hint.className = 'panel-hint';
    hint.textContent = 'يمكن للمديرين إضافة الأعضاء وإعادة تسمية المجموعة.';
    frag.appendChild(hint);

    body.appendChild(frag);

    const meId = store.me && store.me.id;
    const renderMembers = (members) => {
      list.innerHTML = '';
      const fragm = document.createDocumentFragment();
      for (const m of members) {
        fragm.appendChild(memberRow(m, canManage && m.id !== meId, isOwner));
      }
      list.appendChild(fragm);
    };

    const members = [...getMembers(convId).values()];
    renderMembers(members);
    if (!members.length) {
      fetchMembers(convId).then(() => {
        if (openConvId === convId) renderMembers([...getMembers(convId).values()]);
      });
    }

    list.addEventListener('click', async (e) => {
      const rm = e.target.closest('.member-remove');
      const pm = e.target.closest('.member-promote');
      if (rm) {
        const uid = Number(rm.dataset.uid);
        try {
          const data = await api.delete('/api/conversations/' + convId + '/members/' + uid);
          setMembers(convId, (data && data.members) || []);
          renderMembers([...getMembers(convId).values()]);
          toast('تمت إزالة العضو', 'ok');
        } catch (err) {
          toast(err.message || 'تعذّر إزالة العضو', 'error');
        }
      }
      if (pm) {
        const uid = Number(pm.dataset.uid);
        try {
          const data = await api.post('/api/conversations/' + convId + '/transfer', { userId: uid });
          store.conversations.set(convId, { ...getConv(convId), role: 'member' });
          setMembers(convId, (data && data.members) || []);
          openPanel(convId);
          toast('تم نقل الملكية', 'ok');
        } catch (err) {
          toast(err.message || 'تعذّر نقل الملكية', 'error');
        }
      }
    });

    body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'copy-id') copy(`${convId}`);
      else if (act === 'mute') {
        toggleMute(convId, 'المجموعة');
        openPanel(convId);
      } else if (act === 'rename') renameGroup(convId);
      else if (act === 'add-member') addMember(convId, openPanel);
      else if (act === 'leave') leaveGroup(convId);
      else if (act === 'delete') deleteGroup(convId);
    });

    el('panel').classList.add('open');
    document.body.classList.add('chat-panel');
    return;
  }

  const other = conv.other || {};
  const puser = other.id ? store.presenceUsers.get(other.id) : null;
  const online = other.id ? store.presence.has(other.id) : false;
  const name = other.username || conv.name;
  const user = {
    username: name,
    avatar_color: other.avatar_color,
    country: other.country || ((puser && puser.country) || null),
    tz_ip: other.tz_ip || ((puser && puser.tz_ip) || null),
    tz_local: other.tz_local || ((puser && puser.tz_local) || null),
    avatar_url: (puser && puser.avatar_url) || other.avatar_url
  };
  const localTime = timeInTimezone(userTimezone(user));

  body.innerHTML = `
    <div class="panel-hero">
      <span class="avatar xl ${avClass(user.avatar_color)} ${online ? 'is-online' : ''}">${avatarInner(user)}</span>
      <h3 class="panel-name">${esc(name)}${userFlagHtml(other)}</h3>
      <p class="panel-status ${online ? 'on' : ''}">${online ? 'متصل الآن' : 'غير متصل'}</p>
      ${localTime ? `<p class="panel-sub">التوقيت المحلي: ${localTime}</p>` : ''}
    </div>
    <div class="panel-actions">
      <button class="btn btn-ghost" type="button" data-act="copy-name">${ii('copy', 16)}<span>نسخ الاسم</span></button>
      <button class="btn btn-ghost" type="button" data-act="copy-id">${ii('pen', 16)}<span>نسخ المعرّف</span></button>
      <button class="btn btn-ghost" type="button" data-act="mute">${ii('bell', 16)}<span>${muted ? 'إلغاء الكتم' : 'كتم الإشعارات'}</span></button>
      ${other.id ? `<button class="btn btn-ghost" type="button" data-act="block" data-uid="${other.id}">${ii('close', 16)}<span id="block-btn-label">حظر المستخدم</span></button>` : ''}
      ${other.id ? `<button class="btn btn-ghost danger" type="button" data-act="report" data-uid="${other.id}">${ii('alert', 16)}<span>الإبلاغ عن المستخدم</span></button>` : ''}
    </div>
    <p class="panel-hint">المعرّف الرقمي يسمح لأصدقائك ببدء محادثة معك أعلى تطبيقات التدوير المدعومة.</p>
  `;

  if (other.id) refreshBlockLabel(other.id);

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'copy-name') copy(`${name}`);
    else if (act === 'copy-id') copy(`${convId}`);
    else if (act === 'mute') {
      toggleMute(convId, 'المحادثة');
      openPanel(convId);
    } else if (act === 'block') toggleBlock(Number(btn.dataset.uid), name);
    else if (act === 'report') reportUser(Number(btn.dataset.uid), name, convId);
  });

  el('panel').classList.add('open');
  document.body.classList.add('chat-panel');
}

async function renameGroup(convId) {
  const conv = store.conversations.get(Number(convId));
  const name = prompt('الاسم الجديد للمجموعة:', conv && conv.name || '');
  if (name === null) return;
  const trimmed = String(name).trim();
  if (trimmed.length < 2 || trimmed.length > 64) {
    toast('الاسم يجب أن يكون 2-64 حرفًا', 'error');
    return;
  }
  try {
    const data = await api.patch('/api/conversations/' + convId, { name: trimmed });
    if (data && data.conversation) {
      store.conversations.set(Number(convId), { ...store.conversations.get(Number(convId)), ...data.conversation });
    }
    openPanel(convId);
    toast('تمت إعادة التسمية', 'ok');
  } catch (err) {
    toast(err.message || 'تعذّر إعادة التسمية', 'error');
  }
}

function addMember(convId, refreshPanel) {
  const name = prompt('اسم المستخدم المضاف للمجموعة:');
  if (!name) return;
  (async () => {
    let user;
    try {
      const q = String(name).trim();
      const data = await api.get(`/api/users?q=${encodeURIComponent(q)}&limit=5`);
      const list = (data.users || []).filter((u) => !getMembers(convId).has(Number(u.id)));
      if (list.length === 1) user = list[0];
      else if (list.length > 1) {
        const pick = prompt('مستخدمون متطابقون، اكتب رقمًا للاختيار:\n' + list.map((u, i) => `${i + 1}. ${u.username}`).join('\n'));
        const idx = parseInt(pick, 10);
        if (!idx || idx < 1 || idx > list.length) return;
        user = list[idx - 1];
      }
      if (!user) {
        toast('لم يتم العثور على المستخدم', 'error');
        return;
      }
      const data2 = await api.post('/api/conversations/' + convId + '/members', { userId: user.id });
      setMembers(convId, (data2 && data2.members) || []);
      if (refreshPanel) refreshPanel(convId);
      toast('تمت إضافة العضو', 'ok');
    } catch (err) {
      toast(err.message || 'تعذّرت إضافة العضو', 'error');
    }
  })();
}

async function leaveGroup(convId) {
  const meId = store.me && store.me.id;
  if (!meId) return;
  try {
    const data = await api.delete(`/api/conversations/${convId}/members/${meId}`);
    if (data && data.deleted) closeGroup(convId);
    else {
      store.conversations.delete(Number(convId));
      store.convMembers.delete(Number(convId));
    }
    closePanel();
    toast('غادرت المجموعة', 'ok');
  } catch (err) {
    toast(err.message || 'تعذّرت المغادرة', 'error');
  }
}

async function deleteGroup(convId) {
  if (!confirm('حذف المجموعة نهائيًا؟ لا يمكن التراجع.')) return;
  try {
    await api.delete(`/api/conversations/${convId}`);
    closeGroup(convId);
    closePanel();
    toast('تم حذف المجموعة', 'ok');
  } catch (err) {
    toast(err.message || 'تعذّر حذف المجموعة', 'error');
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('تم النسخ', 'ok');
  } catch {
    toast('تعذّر النسخ', 'warn');
  }
}

let blockedIdsCache = null;

async function loadBlockedIds() {
  try {
    const data = await api.get('/api/users/me/blocked');
    blockedIdsCache = new Set((data.users || []).map((u) => Number(u.id)));
  } catch {
    blockedIdsCache = blockedIdsCache || new Set();
  }
  return blockedIdsCache;
}

async function refreshBlockLabel(userId) {
  const ids = await loadBlockedIds();
  const label = el('panel-body').querySelector('#block-btn-label');
  if (label) label.textContent = ids.has(Number(userId)) ? 'إلغاء حظر المستخدم' : 'حظر المستخدم';
}

async function toggleBlock(userId, name) {
  const ids = await loadBlockedIds();
  const blocked = ids.has(userId);
  try {
    if (blocked) {
      await api.delete(`/api/users/${userId}/block`);
      ids.delete(userId);
      toast(`تم إلغاء حظر ${name}`, 'ok');
    } else {
      if (!confirm(`حظر ${name}؟ لن يقدر يبعتلك رسائل بعد كده.`)) return;
      await api.post(`/api/users/${userId}/block`, {});
      ids.add(userId);
      toast(`تم حظر ${name}`, 'ok');
    }
    if (openConvId !== null) refreshBlockLabel(userId);
  } catch (err) {
    toast(err.message || 'تعذّرت العملية', 'error');
  }
}

const REPORT_REASONS = [
  ['spam', 'سبام / إعلانات'],
  ['harassment', 'تحرّش أو إزعاج'],
  ['inappropriate_content', 'محتوى غير لائق'],
  ['fake_profile', 'حساب وهمي'],
  ['underage', 'يبدو أنه قاصر'],
  ['other', 'سبب آخر']
];

async function reportUser(userId, name, convId) {
  const menu = REPORT_REASONS.map(([, label], i) => `${i + 1}. ${label}`).join('\n');
  const pick = prompt(`الإبلاغ عن ${name} — اختر رقم السبب:\n${menu}`);
  if (pick === null) return;
  const idx = parseInt(pick, 10);
  if (!idx || idx < 1 || idx > REPORT_REASONS.length) {
    toast('اختيار غير صالح', 'error');
    return;
  }
  const reason = REPORT_REASONS[idx - 1][0];
  const details = prompt('تفاصيل إضافية (اختياري):', '') || '';
  try {
    await api.post(`/api/users/${userId}/report`, { reason, details, conversationId: convId });
    toast('تم إرسال البلاغ، شكرًا لك', 'ok');
  } catch (err) {
    toast(err.message || 'تعذّر إرسال البلاغ', 'error');
  }
}

export function refreshPanel() {
  if (openConvId !== null) openPanel(openConvId);
}

export function closePanel() {
  openConvId = null;
  el('panel').classList.remove('open');
  document.body.classList.remove('chat-panel');
}

export function isPanelOpen() {
  return openConvId !== null;
}

export function panelConvId() {
  return openConvId;
}

export function closeGroup(convId) {
  store.conversations.delete(Number(convId));
  store.convMembers.delete(Number(convId));
}