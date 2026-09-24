import { icon } from './icons.js';
import { q, qa } from './ui.js';

let current = null;

export function closeMenu() {
  if (current) {
    current.remove();
    current = null;
  }
}

export function showMenu(items, x, y, anchorEl = null) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === 'sep') {
      const s = document.createElement('div');
      s.className = 'menu-sep';
      menu.appendChild(s);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (it.danger ? ' danger' : '');
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `${icon(it.icon, 18)}<span>${it.label}</span>`;
    b.addEventListener('click', () => {
      closeMenu();
      it.action && it.action();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  current = menu;

  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const pad = 8;
  let px = Math.min(Math.max(x, pad), window.innerWidth - mw - pad);
  let py = Math.min(Math.max(y, pad), window.innerHeight - mh - pad);
  menu.style.left = `${px}px`;
  menu.style.top = `${py}px`;

  const onDoc = (e) => {
    if (!menu.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const opts = qa('[role=menuitem]', menu);
      const idx = opts.findIndex((o) => document.activeElement === o);
      const next = (idx + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts[next].focus();
      e.preventDefault();
    }
  };
  setTimeout(() => document.addEventListener('click', onDoc), 0);
  document.addEventListener('keydown', onKey);
  return menu;
}

export function menuAtEl(el, items) {
  const r = el.getBoundingClientRect();
  showMenu(items, r.right, r.bottom + 4);
}