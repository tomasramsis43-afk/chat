const config = require('./config');

let _io = null;

const socketsByUser = new Map();
const countsByIp = new Map();

function init(io) {
  _io = io;
}

function getIO() {
  return _io;
}

function register(socketId, userId, ip) {
  const userSet = socketsByUser.get(userId) || new Set();
  userSet.add(socketId);
  socketsByUser.set(userId, userSet);

  let ipCount = 0;
  if (ip) {
    countsByIp.set(ip, (countsByIp.get(ip) || 0) + 1);
    ipCount = countsByIp.get(ip);
  }

  return { userCount: userSet.size, ipCount };
}

function unregister(socketId, userId, ip) {
  const userSet = socketsByUser.get(userId);
  if (userSet) {
    userSet.delete(socketId);
    if (userSet.size === 0) socketsByUser.delete(userId);
  }
  if (ip && countsByIp.has(ip)) {
    const c = countsByIp.get(ip) - 1;
    if (c <= 0) countsByIp.delete(ip);
    else countsByIp.set(ip, c);
  }
}

function isOnline(userId) {
  const set = socketsByUser.get(userId);
  return !!set && set.size > 0;
}

function onlineUserIds() {
  return Array.from(socketsByUser.keys());
}

function connectedSockets() {
  return _io ? Array.from(_io.sockets.sockets.keys()) : [];
}

function emitToUser(userId, event, payload) {
  if (!_io || !isOnline(userId)) return;
  _io.to(`user:${userId}`).emit(event, payload);
}

function emitToUsers(userIds, event, payload) {
  if (!_io) return;
  const seen = new Set();
  for (const id of userIds) {
    if (seen.has(id) || !isOnline(id)) continue;
    seen.add(id);
    emitToUser(id, event, payload);
  }
}

function disconnectUser(userId) {
  if (!_io) return;
  const set = socketsByUser.get(userId);
  if (!set) return;
  for (const sid of set) {
    _io.in(sid).disconnectSockets(true);
  }
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
  usage
};