import { icon } from './icons.js';

export const el = (id) => document.getElementById(id);

export const q = (sel, root = document) => root.querySelector(sel);
export const qa = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

export function initialsOf(name) {
  const s = String(name || '').trim();
  return s ? Array.from(s)[0] : '؟';
}

const AVATAR_PALETTE = ['#6C5CE7', '#00B894', '#0984E3', '#E17055', '#FDCB6E', '#E84393', '#00CEC9', '#D63031'];

export function avClass(color) {
  const idx = AVATAR_PALETTE.indexOf(String(color || '').toUpperCase());
  return 'av' + (idx >= 0 ? idx : 2);
}

export function avatarInner(user, cls = '') {
  if (user && user.avatar_url) {
    return `<img class="avatar-img" src="${esc(user.avatar_url)}" alt="" loading="lazy">`;
  }
  return `<span class="avatar-letter">${esc(initialsOf(user ? user.username : '؟'))}</span>`;
}

export function paintAvatar(node, user) {
  if (!node || !user) return;
  const img = node.querySelector('img.avatar-img');
  if (user.avatar_url) {
    if (img) img.src = user.avatar_url;
    else {
      node.replaceChildren();
      const i = document.createElement('img');
      i.className = 'avatar-img';
      i.src = user.avatar_url;
      i.alt = '';
      node.appendChild(i);
    }
    node.classList.remove('av0', 'av1', 'av2', 'av3', 'av4', 'av5', 'av6', 'av7');
    return;
  }
  if (img) img.remove();
  node.classList.remove('av0', 'av1', 'av2', 'av3', 'av4', 'av5', 'av6', 'av7');
  node.classList.add(avClass(user.avatar_color));
  node.textContent = initialsOf(user.username);
}

const MM = {
  0: 'يناير', 1: 'فبراير', 2: 'مارس', 3: 'أبريل', 4: 'مايو', 5: 'يونيو',
  6: 'يوليو', 7: 'أغسطس', 8: 'سبتمبر', 9: 'أكتوبر', 10: 'نوفمبر', 11: 'ديسمبر'
};

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function timeOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
}

export function shortStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, yest)) return 'أمس';
  return `${d.getDate()} ${MM[d.getMonth()]}`;
}

export function dayStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return 'اليوم';
  if (sameDay(d, yest)) return 'أمس';
  return `${d.getDate()} ${MM[d.getMonth()]} ${d.getFullYear()}`;
}

let toastTimer = null;

export function toast(message, kind = 'error') {
  const box = el('toasts');
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  const ic = kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'alert';
  t.innerHTML = `${icon(ic, 15)}<span>${esc(message)}</span>`;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    while (box.firstChild) box.firstChild.remove();
  }, 3200);
}

export function skeletonRows(rows) {
  return Array.from({ length: rows }, () => '<div class="sk-row"><div class="sk sk-av"></div><div class="sk-col"><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div></div>').join('');
}

export function clampText(text, max = 120) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

const COUNTRY_NAMES = {
  EG: 'مصر', SA: 'السعودية', AE: 'الإمارات', QA: 'قطر', KW: 'الكويت', BH: 'البحرين', OM: 'عُمان',
  IQ: 'العراق', YE: 'اليمن', SY: 'سوريا', JO: 'الأردن', LB: 'لبنان', PS: 'فلسطين', SD: 'السودان',
  LY: 'ليبيا', TN: 'تونس', DZ: 'الجزائر', MA: 'المغرب', MR: 'موريتانيا', SO: 'الصومال', DJ: 'جيبوتي', KM: 'جزر القمر',
  TR: 'تركيا', US: 'الولايات المتحدة', GB: 'بريطانيا', FR: 'فرنسا', DE: 'ألمانيا', IT: 'إيطاليا',
  ES: 'إسبانيا', NL: 'هولندا', SE: 'السويد', NO: 'النرويج', DK: 'الدنمارك', BE: 'بلجيكا', AT: 'النمسا',
  CH: 'سويسرا', RU: 'روسيا', CA: 'كندا', AU: 'أستراليا', IN: 'الهند', PK: 'باكستان', CN: 'الصين',
  JP: 'اليابان', BR: 'البرازيل'
};

export function flagEmoji(code) {
  if (!/^[A-Z]{2}$/.test(String(code || ''))) return null;
  return String.fromCodePoint(...[...String(code)].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)));
}

export function countryName(code) {
  if (!/^[A-Z]{2}$/.test(String(code || ''))) return null;
  return COUNTRY_NAMES[code] || null;
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

function locationUncertain(ipTz, localTz) {
  if (!ipTz || !localTz) return false;
  return ipTz !== localTz;
}

export function flagHtml(country, ipTz, localTz) {
  const emo = flagEmoji(country);
  if (!emo) return '';
  if (locationUncertain(ipTz, localTz)) {
    const label = 'الموقع غير مؤكد (VPN أو وكيل)';
    return `<span class="flag flag-vpn" role="img" title="${esc(label)}" aria-label="${esc(label)}">؟</span>`;
  }
  const name = countryName(country);
  const label = name ? `${name} (${country})` : `(${country})`;
  return `<span class="flag" role="img" title="${esc(label)}" aria-label="${esc(label)}">${emo}</span>`;
}

export function userFlagHtml(user) {
  if (!user) return '';
  return flagHtml(user.country, user.tz_ip, user.tz_local);
}

export function sendTimeZone() {
  return browserTimeZone() || null;
}

export function flagNode(code) {
  const s = document.createElement('span');
  s.className = 'flag';
  const emo = flagEmoji(code);
  if (!emo) return '';
  const name = countryName(code);
  const label = name ? `${name} (${code})` : `(${code})`;
  s.setAttribute('role', 'img');
  s.title = label;
  s.setAttribute('aria-label', label);
  s.textContent = emo;
  return s;
}