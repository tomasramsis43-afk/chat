const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const { attachSocketIO } = require('./socket');
const {
  corsMiddleware,
  requireJsonBody,
  apiLimiter,
  notFound,
  errorHandler
} = require('./middleware');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const conversationRoutes = require('./routes/conversations');

function createServer() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

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
      crossOriginEmbedderPolicy: false
    })
  );
  app.use(compression());
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(corsMiddleware);
  app.use(requireJsonBody);

  app.use('/api', apiLimiter, require('./middleware').auth);

  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/conversations', conversationRoutes);

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      maxAge: config.isProd ? '1h' : 0,
      etag: true,
      index: 'index.html'
    })
  );

  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);
  const io = attachSocketIO(server);

  return { app, server, io };
}

module.exports = { createServer };