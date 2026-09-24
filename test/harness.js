process.env.NODE_ENV = 'test';

const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { ensureMigrated } = require('../src/migrate');
const { createServer } = require('../src/app');
const db = require('../src/db');

let state = null;

function jarOf(res) {
  return Array.from(res.headers.getSetCookie())
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function startServer() {
  if (state) return state;
  await ensureMigrated();
  const { app, server, io } = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  state = {
    app,
    server,
    io,
    port,
    base: `http://127.0.0.1:${port}`,
    db
  };
  return state;
}

async function closeServer() {
  if (!state) return;
  const { server, io, db: dbc } = state;
  io.close();
  await new Promise((resolve) => server.close(resolve));
  await dbc.close();
  state = null;
}

async function api(method, path, opts = {}) {
  const s = await startServer();
  const headers = { ...(opts.headers || {}) };
  const body = opts.body;
  if (body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.cookies !== undefined && !headers.Cookie) {
    headers.Cookie = opts.cookies;
  }
  const res = await fetch(s.base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data, headers: res.headers, cookies: jarOf(res) };
}

async function registerUser(username, password = 'password123') {
  const res = await api('POST', '/api/auth/register', { body: { username, password } });
  if (res.status !== 201) {
    throw new Error(`register ${username} failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { user: res.data.user, cookies: res.cookies, password };
}

async function loginUser(username, password = 'password123') {
  const res = await api('POST', '/api/auth/login', {
    body: { username, password }
  });
  return res;
}

async function loginUserOk(username, password = 'password123') {
  const res = await loginUser(username, password);
  if (res.status !== 200) {
    throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { user: res.data.user, cookies: res.cookies, password };
}

function connectClient(base, cookies, opts = {}) {
  const client = ioClient(base, {
    extraHeaders: { Cookie: cookies },
    reconnection: false,
    transports: opts.transports || ['websocket'],
    timeout: 5000,
    forceNew: true
  });
  return client;
}

function once(client, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(event, handler);
      reject(new Error(`timeout waiting for socket event '${event}'`));
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(timer);
      client.off(event, handler);
      resolve(payload);
    }
    client.once(event, handler);
  });
}

function emitAck(client, event, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting ack for '${event}'`));
    }, timeoutMs);
    client.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function openDm(me, otherId) {
  return api('POST', '/api/conversations', {
    cookies: me.cookies,
    body: { userId: otherId }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  startServer,
  closeServer,
  api,
  registerUser,
  loginUser,
  loginUserOk,
  connectClient,
  once,
  emitAck,
  openDm,
  sleep,
  jarOf
};