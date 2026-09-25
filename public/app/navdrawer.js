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
  const mb = el('menu-btn');
  if (!mb) return;
  mb.innerHTML = ii('menu', 20);
  const nc = el('nav-close');
  if (nc) nc.innerHTML = ii('close', 18);
  const gIc = el('nav-ic-create');
  if (gIc) gIc.innerHTML = ii('plus', 18);
  const oIc = el('nav-ic-online');
  if (oIc) oIc.innerHTML = ii('users', 18);
  const cIc = el('nav-ic-convs');
  if (cIc) cIc.innerHTML = ii('chat', 18);
  mb.addEventListener('click', toggleNavDrawer);
  const nb = el('nav-backdrop');
  if (nb) nb.addEventListener('click', closeNavDrawer);
  const onTab = el('nav-online-tab');
  if (onTab) onTab.addEventListener('click', () => {
    closeNavDrawer();
    if (onShowSection) onShowSection('online');
  });
  const ct = el('nav-convs-tab');
  if (ct) ct.addEventListener('click', () => {
    closeNavDrawer();
    if (onShowSection) onShowSection('convs');
  });
  if (nc) nc.addEventListener('click', closeNavDrawer);
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
  const m = mount();
  if (!m) return;
  opened = true;
  renderNavDrawer();
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  const nb = el('nav-backdrop');
  if (nb) {
    nb.classList.remove('hidden');
    nb.setAttribute('aria-hidden', 'false');
  }
  document.body.classList.add('nav-open');
}

export function closeNavDrawer() {
  if (!opened) return;
  opened = false;
  const m = mount();
  if (m) {
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
  }
  const nb = el('nav-backdrop');
  if (nb) {
    nb.classList.add('hidden');
    nb.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('nav-open');
}

export function renderNavDrawer() {
  const c = el('nav-online-count');
  if (c) c.textContent = String(store.presenceUsers.size);
}
