let socket = null;
const handlers = {};

export function setSocketHandlers(h) {
  Object.assign(handlers, h);
}

export function connectSocket() {
  if (socket) return socket;
  socket = io('/', { reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 8000 });

  socket.on('connect', () => handlers.onConnect && handlers.onConnect());
  socket.on('disconnect', () => handlers.onDisconnect && handlers.onDisconnect());
  socket.on('connect_error', (err) => handlers.onConnectError && handlers.onConnectError(err));
  socket.on('presence', (ids) => handlers.onPresence && handlers.onPresence(ids));
  socket.on('message:new', (msg) => handlers.onMessage && handlers.onMessage(msg));
  socket.on('conversation:read', (ev) => handlers.onRead && handlers.onRead(ev));
  socket.on('typing', (ev) => handlers.onTyping && handlers.onTyping(ev));

  return socket;
}

export function getSocket() {
  return socket;
}

export function isConnected() {
  return !!socket && socket.connected;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

export function emitSend(payload) {
  return new Promise((resolve) => {
    if (!isConnected()) return resolve({ ok: false, error: { code: 'OFFLINE' } });
    socket.emit('message:send', payload, resolve);
  });
}

export function emitRead(conversationId, lastReadId) {
  if (!isConnected()) return;
  socket.emit('conversation:read', { conversationId, lastReadId });
}

export function emitTyping(conversationId) {
  if (!isConnected()) return;
  socket.emit('typing', { conversationId });
}