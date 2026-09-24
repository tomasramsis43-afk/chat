const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

const errors = [];
const JWT_SECRET = process.env.JWT_SECRET || '';
let jwtSecret = JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET === 'dev-secret-change-me') {
  if (isProd) {
    errors.push('JWT_SECRET مطلوب في الإنتاج (قيمة عشوائية من 32 حرفًا على الأقل).');
  } else {
    jwtSecret = crypto.randomBytes(48).toString('hex');
  }
}

const DATABASE_URL = process.env.DATABASE_URL || '';
if (isProd && !DATABASE_URL) {
  errors.push('DATABASE_URL مطلوب في الإنتاج.');
}

const rawDbFile = process.env.DB_FILE || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

const APP_URL = process.env.APP_URL || '';

function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

const appOrigin = originOf(APP_URL) || (isProd ? null : 'http://localhost:3000');
const extraOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = new Set([...(appOrigin ? [appOrigin] : []), ...extraOrigins]);

if (isProd && errors.length) {
  for (const e of errors) console.error('[config] ✗ ' + e);
  console.error('\n[config] أوقف التشغيل: الإعدادات المطلوبة غير مكتملة.');
  process.exit(1);
}

module.exports = {
  nodeEnv: NODE_ENV,
  isProd,
  isTest,
  port: Number(process.env.PORT || 3000),
  jwtSecret,
  accessTtlSec: 15 * 60,
  accessTtlMs: 15 * 60 * 1000,
  refreshTtlDays: 30,
  refreshTtlMs: 30 * 86400 * 1000,
  cookieSecure: isProd ? true : process.env.COOKIE_SECURE === 'true',
  cookieNameAt: 'salem_at',
  cookieNameRt: 'salem_rt',
  dbUrl: DATABASE_URL,
  dbFile: rawDbFile === ':memory:' ? ':memory:' : rawDbFile ? path.resolve(rawDbFile) : null,
  trustProxy: process.env.TRUST_PROXY === 'true',
  appUrl: APP_URL,
  google: {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    enabled: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  },
  allowedOrigins,
  limits: {
    api: { windowMs: 60 * 1000, limit: Number(process.env.RATE_API || 300) },
    auth: { windowMs: 15 * 60 * 1000, limit: Number(process.env.RATE_AUTH || 10) },
    authUser: { windowMs: 15 * 60 * 1000, limit: Number(process.env.RATE_AUTH_USER || 5) },
    msgMaxLength: Number(process.env.MSG_MAX_LEN || 4000),
    typingIntervalMs: 2000,
    maxSocketsPerUser: 8,
    maxSocketsPerIp: 20
  },
  bodyLimit: '16kb'
};