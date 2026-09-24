'use strict';
const { ensureMigrated } = require('./src/migrate');
const { createServer } = require('./src/app');
const config = require('./src/config');
const db = require('./src/db');
const logger = require('./src/logger');
const { shutdown: shutdownSockets } = require('./src/socket');

let closing = false;

async function shutdown(server, io, signal, opts = {}) {
  if (closing) return;
  closing = true;
  const { exit = true } = opts;
  logger.info('shutting down', { signal });

  const forceTimer = setTimeout(() => {
    logger.error('forced exit after timeout');
    process.exit(1);
  }, config.server.shutdownTimeoutMs);
  if (forceTimer.unref) forceTimer.unref();

  try {
    if (io) io.close(() => logger.info('socket.io closed'));
  } catch (err) {
    logger.warn('io.close error', { message: err && err.message });
  }

  try {
    shutdownSockets();
  } catch (err) {
    logger.warn('socket cleanup error', { message: err && err.message });
  }

  try {
    const done = new Promise((resolve) => server.close(resolve));
    // يقطع اتصالات keep-alive الخاملة فورًا حتى يُغلق `server.close` بسرعة وبشكل محدد
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    const timer = setTimeout(() => {
      logger.warn('http server forced close (open connections)');
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      resolve();
    }, Math.min(config.server.shutdownTimeoutMs / 2, 5000));
    if (timer.unref) timer.unref();
    await done;
    clearTimeout(timer);
  } catch (err) {
    logger.warn('http server close error', { message: err && err.message });
  }

  try {
    await db.close();
  } catch (err) {
    logger.warn('db close error', { message: err && err.message });
  }

  clearTimeout(forceTimer);
  if (exit) process.exit(0);
}

async function createChatServer() {
  await ensureMigrated();

  const { server, io } = createServer();
  const listen = new Promise((resolve) => server.listen(config.port, config.host, resolve));
  await listen;
  logger.info('listening', { port: config.port, env: config.nodeEnv, dialect: db.dialect });

  process.on('SIGINT', () => shutdown(server, io, 'SIGINT', { exit: true }));
  process.on('SIGTERM', () => shutdown(server, io, 'SIGTERM', { exit: true }));
  process.on('unhandledRejection', (err) => {
    logger.error('unhandledRejection', { message: err && err.message, stack: err && err.stack });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { message: err && err.message, stack: err && err.stack });
  });

  return { server, io, shutdown: () => shutdown(server, io, 'shutdown', { exit: false }) };
}

if (require.main === module) {
  createChatServer().catch((err) => {
    logger.error('فشل التشغيل', { message: err && err.message, stack: err && err.stack });
    process.exit(1);
  });
}

module.exports = { createChatServer };