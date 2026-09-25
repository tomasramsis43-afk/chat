const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const logger = require('./logger');
const { createStore } = require('./rate-limit-store');
const { ApiError, parseCookies, isUniqueViolation } = require('./utils');

function requestId(req, res, next) {
  const incoming = String(req.headers['x-request-id'] || '').slice(0, 64);
  req.id = incoming || crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
}

function auth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[config.cookieNameAt];
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    req.user = {
      id: Number(payload.sub),
      sid: payload.sid ? Number(payload.sid) : null
    };
  } catch {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'UNAUTHORIZED', 'مطلوب تسجيل الدخول'));
  next();
}

// نجيب الدور من قاعدة البيانات في كل طلب أدمن (مش من الـ JWT) عشان لو حد
// اتنزّل من admin يفقد الصلاحية فورًا من غير ما ينتظر انتهاء التوكن.
async function requireAdmin(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'UNAUTHORIZED', 'مطلوب تسجيل الدخول'));
  try {
    const db = require('./db');
    const rows = await db.query('SELECT role, banned_at FROM users WHERE id = $1', [req.user.id]);
    const u = rows[0];
    if (!u || u.role !== 'admin') {
      return next(new ApiError(403, 'FORBIDDEN', 'صلاحيات أدمن مطلوبة'));
    }
    if (u.banned_at) return next(new ApiError(403, 'FORBIDDEN', 'الحساب موقوف'));
    next();
  } catch (e) {
    next(e);
  }
}

function originAllowed(origin, req) {
  if (config.allowedOrigins.has(origin)) return true;
  if (!origin) return true;
  try {
    const self = new URL(origin);
    return self.host === req.headers.host && (self.protocol === 'http:' || self.protocol === 'https:');
  } catch {
    return false;
  }
}

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    if (!originAllowed(origin, req)) {
      return next(new ApiError(403, 'FORBIDDEN', 'Origin غير مسموح'));
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, X-Request-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function requireJsonBody(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const ct = req.headers['content-type'] || '';
  if (ct && !ct.includes('application/json')) {
    return next(
      new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type يجب أن يكون application/json')
    );
  }
  next();
}

function makeLimiter(opts) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: opts.store || createStore(),
    keyGenerator: opts.keyGenerator,
    handler: (req, res) =>
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'طلبات كثيرة جدًا، انتظر قليلًا' }
      })
  });
}

const apiLimiter = makeLimiter(config.limits.api);

const uploadLimiter = makeLimiter(config.limits.upload);

const authLimiter = makeLimiter({
  windowMs: config.limits.auth.windowMs,
  limit: config.limits.auth.limit
});

const authUserLimiter = makeLimiter({
  windowMs: config.limits.authUser.windowMs,
  limit: config.limits.authUser.limit,
  keyGenerator: (req) => {
    const u = (req.body && req.body.username) || '';
    return `${req.ip}:${String(u).trim().toLowerCase()}`;
  }
});

const googleLimiter = makeLimiter({
  windowMs: config.limits.auth.windowMs,
  limit: Math.max(30, config.limits.auth.limit * 3)
});

const gpsLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 30
});

function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'الموارد غير موجودة' } });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof ApiError) {
    if (err.status >= 500) {
      logger.error('api error', { code: err.code, message: err.message, requestId: req.id, path: req.originalUrl });
    } else {
      logger.debug('api error', { code: err.code, message: err.message, requestId: req.id, path: req.originalUrl });
    }
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    logger.warn('bad request body', { type: err.type, status: err.status, requestId: req.id });
    return res
      .status(err.status || 400)
      .json({ error: { code: 'BAD_REQUEST', message: 'طلب غير صالح' } });
  }
  if (err && isUniqueViolation(err)) {
    return res
      .status(409)
      .json({ error: { code: 'CONFLICT', message: 'بيانات مكررة' } });
  }
  const errId = crypto.randomBytes(4).toString('hex');
  logger.error('unhandled error', {
    id: errId,
    requestId: req.id,
    path: req.originalUrl,
    message: err && err.message,
    stack: err && err.stack
  });
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'حصل خطأ في السيرفر', id: errId }
  });
}

module.exports = {
  requestId,
  auth,
  requireAuth,
  requireAdmin,
  corsMiddleware,
  requireJsonBody,
  makeLimiter,
  apiLimiter,
  uploadLimiter,
  authLimiter,
  authUserLimiter,
  googleLimiter,
  gpsLimiter,
  notFound,
  errorHandler
};