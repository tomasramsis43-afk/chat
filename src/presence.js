'use strict';
const config = require('./config');

// ===== Abstrakte حضور (Presence store) =====
// في خادم واحد: ذاكرة (MemoryPresenceStore). عند التوسع لعدة خوادم يُستبدل
// بحلّ موزّع (Redis) يطبّق نفس الواجهة دون تغيير بقية التطبيق.

class MemoryPresenceStore {
  constructor() {
    this.socketsByUser = new Map();
    this.countsByIp = new Map();
  }

  add(socketId, userId, ip) {
    const userSet = this.socketsByUser.get(userId) || new Set();
    userSet.add(socketId);
    this.socketsByUser.set(userId, userSet);

    let ipCount = 0;
    if (ip) {
      this.countsByIp.set(ip, (this.countsByIp.get(ip) || 0) + 1);
      ipCount = this.countsByIp.get(ip);
    }
    return { userCount: userSet.size, ipCount };
  }

  remove(socketId, userId, ip) {
    const userSet = this.socketsByUser.get(userId);
    if (userSet) {
      userSet.delete(socketId);
      if (userSet.size === 0) this.socketsByUser.delete(userId);
    }
    if (ip && this.countsByIp.has(ip)) {
      const c = this.countsByIp.get(ip) - 1;
      if (c <= 0) this.countsByIp.delete(ip);
      else this.countsByIp.set(ip, c);
    }
  }

  isOnline(userId) {
    const set = this.socketsByUser.get(userId);
    return !!set && set.size > 0;
  }

  userIds() {
    return Array.from(this.socketsByUser.keys());
  }

  userCount() {
    return this.socketsByUser.size;
  }

  socketCount() {
    let n = 0;
    for (const set of this.socketsByUser.values()) n += set.size;
    return n;
  }

  ipCount() {
    return this.countsByIp.size;
  }
}

let store = new MemoryPresenceStore();
let _io = null;

function init(io) {
  _io = io;
}

function getIO() {
  return _io;
}

function register(socketId, userId, ip) {
  const result = store.add(socketId, userId, ip);
  // مقارنة بالحدود الحالية (تظل من config)
  return result;
}

function unregister(socketId, userId, ip) {
  store.remove(socketId, userId, ip);
}

function isOnline(userId) {
  return store.isOnline(userId);
}

function onlineUserIds() {
  return store.userIds();
}

function connectedSockets() {
  return _io ? Array.from(_io.sockets.sockets.keys()) : [];
}

function emitToUser(userId, event, payload) {
  if (!_io || !store.isOnline(userId)) return;
  _io.to(`user:${userId}`).emit(event, payload);
}

function emitToUsers(userIds, event, payload) {
  if (!_io) return;
  const seen = new Set();
  for (const id of userIds) {
    if (seen.has(id) || !store.isOnline(id)) continue;
    seen.add(id);
    _io.to(`user:${id}`).emit(event, payload);
  }
}

function disconnectUser(userId) {
  if (!_io) return;
  const sockets = _io.sockets;
  if (!sockets) return;
  for (const socket of sockets.sockets.values()) {
    const a = socket.auth;
    if (a && Number(a.userId) === Number(userId)) {
      _io.in(socket.id).disconnectSockets(true);
    }
  }
}

function count() {
  return store.userCount();
}

const usage = {
  maxUserSockets: config.limits.maxSocketsPerUser,
  maxIpSockets: config.limits.maxSocketsPerIp
};

module.exports = {
  init,
  getIO,
  register,
  unregister,
  isOnline,
  onlineUserIds,
  connectedSockets,
  emitToUser,
  emitToUsers,
  disconnectUser,
  count,
  usage
};