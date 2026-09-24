const P = {
  at: (d) => `<path d="${d}" />`,
  circle: (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" />`,
  path: (s) => s,
  stroke: (d, extra = '') =>
    `<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="${d}" ${extra}/>`
};

const ICONS = {
  search: () => P.stroke('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm9.6 4.6-4.3-4.3'),
  send: () => P.stroke('M12 19V5m0 0-6 6m6-6 6 6'),
  back: () => P.stroke('M15 5l-7 7 7 7'),
  more: () =>
    '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  close: () => P.stroke('M6 6l12 12M18 6 6 18'),
  sun: () =>
    P.circle(12, 12, 4) +
    P.stroke('M12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6'),
  moon: () => P.stroke('M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z'),
  plus: () => P.stroke('M12 5v14M5 12h14'),
  chat: () =>
    P.stroke('M12 3a9 9 0 0 1 9 9c0 4.1-2.8 7.6-6.6 8.6L5 21l1.6-6.4A8.7 8.7 0 0 1 3 12a9 9 0 0 1 9-9Z') +
    P.path('<path d="M8.5 12h.01M12 12h.01M15.5 12h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  logout: () =>
    P.stroke('M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9'),
  pin: () => P.stroke('M9 4h6v3.5L16.5 10H20v2l-8 5-8-5v-2h3.5L9 7.5Zm3 10v6'),
  bell: () =>
    P.stroke('M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 20a2 2 0 0 1-3.4 0'),
  reply: () =>
    P.stroke('M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v4') +
    P.path('<path d="M20 19.5a7 7 0 0 0-10-6.2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  copy: () => P.stroke('M9 9h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm6 0V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2'),
  check: () => P.stroke('M4 12.5l5 5L20 6.5'),
  checkAll: () =>
    P.stroke('M3 13.5 7.5 18 13 12.5M8 13.5l4.5-4M14 10l1.8-1.8A3.2 3.2 0 0 0 21 8.4V12a9 9 0 0 1-9 9c-1 0-2-.16-2.9-.46') +
    P.stroke('M9.6 6.7A3.6 3.6 0 0 1 17 7'),
  clock: () => P.circle(12, 12, 9) + P.stroke('M12 7v5l3.4 2'),
  smile: () =>
    P.circle(12, 12, 9) +
    P.path('<path d="M8.8 14.6a3.8 3.8 0 0 0 6.4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>') +
    P.path('<path d="M9 9.6h.01M15 9.6h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  clip: () => P.stroke('M20 11.5 11.9 19.6a5.4 5.4 0 0 1-7.6-7.6L12.8 3.4a3.6 3.6 0 0 1 5.1 5.1l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l8-8'),
  phone: () =>
    P.stroke('M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.13.96.36 1.9.7 2.8a2 2 0 0 1-.45 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.45c.9.34 1.84.57 2.8.7a2 2 0 0 1 1.7 2.05Z'),
  video: () =>
    P.stroke('M22 8.5 17 12l5 3.5Zm-7-3H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-11a1 1 0 0 0-1-1Z'),
  user: () => P.circle(12, 8.2, 4) + P.stroke('M4.5 21a7.5 7.5 0 0 1 15 0'),
  chevron: () => P.stroke('m9 6 6 6-6 6'),
  trash: () => P.stroke('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'),
  pen: () => P.stroke('M4 20l4.2-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20Zm6.5-8.5 3 3'),
  alert: () => P.stroke('M12 9v4M12 17h.01') + P.path('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Zm1.7 8.6v1.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/> ')
};

const cache = new Map();

export function icon(name, size = 20, cls = '') {
  const key = `${name}|${size}`;
  const body = ICONS[name] ? ICONS[name]() : '';
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${body}</svg>`;
}