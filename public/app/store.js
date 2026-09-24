export const store = {
  me: null,
  socketConnected: false,
  online: false,
  presence: new Set(),
  presenceUsers: new Map(),
  activeConvId: null,
  conversations: new Map(),
  convLocalUnread: new Map(),
  messages: new Map(),
  convMeta: loadMeta(),
  convMembers: new Map(),
  convFilter: 'all'
};

function loadMeta() {
  try {
    const raw = JSON.parse(localStorage.getItem('salem_meta') || '{}');
    const out = new Map();
    for (const [k, v] of Object.entries(raw)) out.set(Number(k), v);
    return out;
  } catch {
    return new Map();
  }
}

export function persistMeta() {
  const raw = {};
  for (const [k, v] of store.convMeta) raw[k] = v;
  try {
    localStorage.setItem('salem_meta', JSON.stringify(raw));
  } catch {}
}

export function convMeta(convId) {
  const m = store.convMeta.get(convId);
  return m || { pinned: false, muted: false };
}

export function setConvMeta(convId, patch) {
  const cur = convMeta(convId);
  store.convMeta.set(convId, { ...cur, ...patch });
  persistMeta();
  return store.convMeta.get(convId);
}

export function isPinned(convId) {
  const c = getConv(convId);
  if (c) return !!c.pinned;
  return !!convMeta(convId).pinned;
}

export function isMuted(convId) {
  const c = getConv(convId);
  if (c) return !!c.muted;
  return !!convMeta(convId).muted;
}

export function getConv(convId) {
  return store.conversations.get(Number(convId));
}

export function setConv(conv) {
  store.conversations.set(Number(conv.id), conv);
}

export function getMessages(convId) {
  if (!store.messages.has(convId)) {
    store.messages.set(convId, { items: [], nextBefore: null, loaded: false });
  }
  return store.messages.get(convId);
}

export function getMembers(convId) {
  return store.convMembers.get(Number(convId)) || new Map();
}

export function setMembers(convId, arr) {
  const map = new Map();
  for (const u of arr || []) map.set(Number(u.id), u);
  store.convMembers.set(Number(convId), map);
  return map;
}

export function memberOf(convId, userId) {
  return getMembers(convId).get(Number(userId)) || null;
}

export function otherMembers(convId) {
  const meId = store.me && store.me.id;
  const map = getMembers(convId);
  const out = [];
  for (const m of map.values()) {
    if (Number(m.id) !== Number(meId)) out.push(m);
  }
  return out;
}

export function isGroup(conv) {
  return !!conv && conv.type === 'group';
}

export function localUnread(convId) {
  return store.convLocalUnread.get(convId) || 0;
}

export function bumpLocalUnread(convId) {
  store.convLocalUnread.set(convId, localUnread(convId) + 1);
}

export function clearLocalUnread(convId) {
  store.convLocalUnread.delete(convId);
}

export function totalUnread(conv) {
  return (conv.unread || 0) + localUnread(Number(conv.id));
}

export function sortKey(conv) {
  const p = isPinned(conv.id) ? 0 : 1;
  const t = conv.lastMessageAt ? new Date(conv.lastMessageAt).getTime() : conv.created_at ? new Date(conv.created_at).getTime() : 0;
  return { p, t };
}

export function visibleConversations(filter = store.convFilter) {
  let items = [...store.conversations.values()];
  if (filter === 'unread') items = items.filter((c) => totalUnread(c) > 0);
  else if (filter === 'pinned') items = items.filter((c) => isPinned(c.id));
  else if (filter === 'groups') items = items.filter((c) => c.type === 'group');
  items.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka.p !== kb.p) return ka.p - kb.p;
    return kb.t - ka.t;
  });
  return items;
}