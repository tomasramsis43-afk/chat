import { el, esc, avClass, avatarInner, toast, userFlagHtml } from './ui.js';
import { icon as ii } from './icons.js';
import { store, getConv, isMuted, setConvMeta } from './store.js';

let meId = () => store.me?.id;
let openConvId = null;

export function initPanel() {
  el('panel-close').innerHTML = ii('close', 18);
  el('panel-close').addEventListener('click', closePanel);
  el('panel').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePanel();
  });
}

export function openPanel(convId) {
  convId = Number(convId);
  const conv = getConv(convId);
  if (!conv) return;
  openConvId = convId;
  const other = conv.other || {};
  const puser = other.id ? store.presenceUsers.get(other.id) : null;
  const online = other.id ? store.presence.has(other.id) : false;
  const isGroup = !!conv.name && !conv.other;
  const name = isGroup ? conv.name : other.username || conv.name;
  const user = {
    username: name,
    avatar_color: other.avatar_color,
    country: isGroup ? null : other.country || ((puser && puser.country) || null),
    tz_ip: isGroup ? null : other.tz_ip || ((puser && puser.tz_ip) || null),
    tz_local: isGroup ? null : other.tz_local || ((puser && puser.tz_local) || null),
    avatar_url: (puser && puser.avatar_url) || other.avatar_url
  };
  const muted = isMuted(convId);

  const body = el('panel-body');
  body.innerHTML = `
    <div class="panel-hero">
      <span class="avatar xl ${avClass(user.avatar_color)} ${online ? 'is-online' : ''}">${avatarInner(user)}</span>
      <h3 class="panel-name">${esc(name)}${userFlagHtml(isGroup ? null : other)}</h3>
      <p class="panel-status ${online ? 'on' : ''}">${online ? 'متصل الآن' : 'غير متصل'}</p>
      ${isGroup ? '<p class="panel-sub">محادثة جماعية</p>' : ''}
    </div>
    <div class="panel-actions">
      <button class="btn btn-ghost" type="button" data-act="copy-name">${ii('copy', 16)}<span>نسخ الاسم</span></button>
      <button class="btn btn-ghost" type="button" data-act="copy-id">${ii('pen', 16)}<span>نسخ المعرّف</span></button>
      <button class="btn btn-ghost" type="button" data-act="mute">${ii('bell', 16)}<span>${muted ? 'إلغاء الكتم' : 'كتم الإشعارات'}</span></button>
    </div>
    <p class="panel-hint">المعرّف الرقمي يسمح لأصدقائك ببدء محادثة معك أعلى تطبيقات التدوير المدعومة.</p>
  `;

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'copy-name') {
      copy(`${name}`);
    } else if (act === 'copy-id') {
      copy(`${convId}`);
    } else if (act === 'mute') {
      const next = setConvMeta(convId, { muted: !muted });
      openPanel(convId);
      toast(next.muted ? 'تم كتم المحادثة' : 'تم إلغاء كتم المحادثة', 'ok');
    }
  });

  el('panel').classList.add('open');
  document.body.classList.add('chat-panel');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('تم النسخ', 'ok');
  } catch {
    toast('تعذّر النسخ', 'warn');
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