import { el } from './ui.js';
import { icon as ii } from './icons.js';
import { store } from './store.js';

let onShowSection = null;
let opened = false;

function mount() {
  return el('nav-menu');
}

export function initNavDrawer(opts = {}) {
  onShowSection = opts.onShowSection || null;
  el('menu-btn').innerHTML = ii('menu', 20);
  el('nav-close').innerHTML = ii('close', 18);
  el('menu-btn').addEventListener('click', toggleNavDrawer);
  el('nav-close').addEventListener('click', closeNavDrawer);
  el('nav-backdrop').addEventListener('click', closeNavDrawer);
  el('nav-online-tab').addEventListener('click', () => {
    closeNavDrawer();
    if (onShowSection) onShowSection('online');
  });
  el('nav-convs-tab').addEventListener('click', () => {
    closeNavDrawer();
    if (onShowSection) onShowSection('convs');
  });
}

export function toggleNavDrawer() {
  if (opened) closeNavDrawer();
  else openNavDrawer();
}

export function isNavOpen() {
  return opened;
}

export function openNavDrawer() {
  if (opened) return;
  opened = true;
  renderNavDrawer();
  mount().classList.add('open');
  mount().setAttribute('aria-hidden', 'false');
  el('nav-backdrop').classList.remove('hidden');
  el('nav-backdrop').setAttribute('aria-hidden', 'false');
  document.body.classList.add('nav-open');
}

export function closeNavDrawer() {
  if (!opened) return;
  opened = false;
  mount().classList.remove('open');
  mount().setAttribute('aria-hidden', 'true');
  el('nav-backdrop').classList.add('hidden');
  el('nav-backdrop').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('nav-open');
}

export function renderNavDrawer() {
  el('nav-online-count').textContent = String(store.presenceUsers.size);
}