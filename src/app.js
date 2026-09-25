'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const db = require('./db');
const logger = require('./logger');
const metrics = require('./metrics');
const { attachSocketIO } = require('./socket');
const {
  requestId,
  corsMiddleware,
  requireJsonBody,
  apiLimiter,
  notFound,
  errorHandler
} = require('./middleware');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const conversationRoutes = require('./routes/conversations');
const uploadRoutes = require('./routes/uploads');
const adminRoutes = require('./routes/admin');
const { serveUpload } = require('./uploads');

function createServer() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(metrics.recordRequest);
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.http(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`, {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - start,
        requestId: req.id
      });
    });
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", 'https://fonts.googleapis.com'],
          'font-src': ['https://fonts.gstatic.com'],
          'img-src': ["'self'", 'data:', 'https://lh3.googleusercontent.com'],
          'connect-src': ["'self'", 'ws:', 'wss:'],
          'frame-ancestors': ["'none'"]
        }
      },
      crossOriginEmbedderPolicy: false,
      permissionsPolicy: {
        permissions: {
          geolocation: ["'self'"],
          camera: [],
          microphone: [],
          payment: [],
          usb: [],
          magnetometer: []
        }
      }
    })
  );
  app.use(compression());
  app.use((req, res, next) => {
    const isUpload =
      req.method === 'POST' && /^\/api\/conversations\/\d+\/attachments$/.test(req.path);
    express.json({ limit: isUpload ? config.limits.uploadMaxBase64 : config.bodyLimit })(
      req,
      res,
      next
    );
  });
  app.use(corsMiddleware);
  app.use(requireJsonBody);

  // Health checks (خفيفة، بدون استعلامات ثقيلة)
  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
  app.get('/ready', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });
  app.get('/metrics', (req, res) => {
    res.type('text/plain');
    res.send(metrics.render({ db: db.poolStatus() }));
  });

  app.use('/api', apiLimiter, require('./middleware').auth);

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/conversations', conversationRoutes);
  app.use('/api/conversations', uploadRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      maxAge: 0,
      etag: true,
      index: 'index.html'
    })
  );

  app.get(
    '/uploads/:file',
    require('./middleware').auth,
    require('./middleware').requireAuth,
    serveUpload
  );

  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);
  const io = attachSocketIO(server);

  return { app, server, io };
}

module.exports = { createServer };