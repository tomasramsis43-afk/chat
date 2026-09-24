const $ = (id) => document.getElementById(id);

export function el(id) {
  return $(id);
}

export function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

export function initials(name) {
  const s = String(name || '').trim();
  return s ? Array.from(s)[0] : '؟';
}

const AVATAR_PALETTE = ['#6C5CE7', '#00B894', '#0984E3', '#E17055', '#FDCB6E', '#E84393', '#00CEC9', '#D63031'];

export function avClass(color) {
  const idx = AVATAR_PALETTE.indexOf(String(color || '').toUpperCase());
  return 'av' + (idx >= 0 ? idx : 2);
}

export function paintAvatar(node, user) {
  if (!node || !user) return;
  node.textContent = initials(user.username);
  node.classList.remove('av0', 'av1', 'av2', 'av3', 'av4', 'av5', 'av6', 'av7');
  node.classList.add(avClass(user.avatar_color));
}

export function timeOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
}

export function dayStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'اليوم';
  if (sameDay(d, yest)) return 'أمس';
  return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function toast(message, kind = 'error') {
  const box = $('toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  box.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    while (box.firstChild) box.firstChild.remove();
  }, 3200);
}

let toastTimer = null;

export function convPreview(conv) {
  if (conv.lastMessage) {
    if (conv.lastMessage.deleted) {
      return (conv.lastMessage.sender_id === store.me?.id ? 'حذفت' : 'حُذفت') + ' رسالة';
    }
    const mine = conv.lastMessage.sender_id === store.me?.id;
    return (mine ? 'أنت: ' : '') + conv.lastMessage.content;
  }
  return 'لا توجد رسائل بعد';
}

import { store } from './store.js';