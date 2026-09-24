export const store = {
  me: null,
  socketConnected: false,
  presence: new Set(),
  presenceUsers: new Map(),
  activeConvId: null,
  conversations: new Map(),
  convLocalUnread: new Map(),
  messages: new Map()
};

export function getConv(convId) {
  return store.conversations.get(convId);
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

export function localUnread(convId) {
  return store.convLocalUnread.get(convId) || 0;
}

export function bumpLocalUnread(convId) {
  store.convLocalUnread.set(convId, localUnread(convId) + 1);
}

export function clearLocalUnread(convId) {
  store.convLocalUnread.delete(convId);
}