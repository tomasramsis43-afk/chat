const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const { ApiError, parseCookies } = require('./utils');

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function requireJsonBody(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const ct = (req.headers['content-type'] || '');
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
    keyGenerator: opts.keyGenerator,
    handler: (req, res) =>
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'طلبات كثيرة جدًا، انتظر قليلًا' }
      })
  });
}

const apiLimiter = makeLimiter(config.limits.api);

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

function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'الموارد غير موجودة' } });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof ApiError) {
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message } });
  }
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res
      .status(err.status || 400)
      .json({ error: { code: 'BAD_REQUEST', message: 'طلب غير صالح' } });
  }
  if (err && err.code && (err.code === '23505' || String(err.message).includes('UNIQUE'))) {
    return res
      .status(409)
      .json({ error: { code: 'CONFLICT', message: 'بيانات مكررة' } });
  }
  console.error('[api]', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'حصل خطأ في السيرفر' } });
}

module.exports = {
  auth,
  requireAuth,
  corsMiddleware,
  requireJsonBody,
  makeLimiter,
  apiLimiter,
  authLimiter,
  authUserLimiter,
  googleLimiter,
  notFound,
  errorHandler
};