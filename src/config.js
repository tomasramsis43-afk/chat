const path = require('path');
const os = require('os');
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

// ===== Server / Proxy =====
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const trustProxy = process.env.TRUST_PROXY === 'true';
const APP_URL = process.env.APP_URL || '';

// ===== CORS =====
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

// ===== Database =====
const rawDbFile = process.env.DB_FILE || '';
const DB_SSL = (process.env.DB_SSL || (isProd ? 'require' : 'disabled')).toLowerCase();
let dbSsl = false;
if (DB_SSL === 'require') dbSsl = { rejectUnauthorized: false };
else if (DB_SSL === 'verify-full') dbSsl = { rejectUnauthorized: true };

// ===== Storage =====
const uploadDir = isTest
  ? path.join(os.tmpdir(), 'salem-chat-uploads')
  : path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'));
const STORAGE_PROVIDER = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
if (STORAGE_PROVIDER !== 'local' && STORAGE_PROVIDER !== 's3') {
  errors.push('STORAGE_PROVIDER يجب أن يكون local أو s3.');
}
if (isProd && STORAGE_PROVIDER === 's3') {
  if (!process.env.S3_BUCKET) errors.push('S3_BUCKET مطلوب مع STORAGE_PROVIDER=s3 في الإنتاج.');
  if (!process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
    errors.push('S3_ACCESS_KEY_ID و S3_SECRET_ACCESS_KEY مطلوبان مع STORAGE_PROVIDER=s3 في الإنتاج.');
  }
  if (!process.env.S3_ENDPOINT) errors.push('S3_ENDPOINT مطلوب مع STORAGE_PROVIDER=s3 في الإنتاج.');
}

// أسماء المستخدمين اللي بتترقّى تلقائيًا لـ admin عند التسجيل (فاصلة بينها كوما).
// يُستخدم أيضًا في scripts/promote-admin.js لترقية مستخدم موجود بالفعل.
const adminUsernames = new Set(
  (process.env.ADMIN_USERNAMES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

if (isProd && errors.length) {
  for (const e of errors) console.error('[config] ✗ ' + e);
  console.error('\n[config] أوقف التشغيل: الإعدادات المطلوبة غير مكتملة.');
  process.exit(1);
}

module.exports = {
  nodeEnv: NODE_ENV,
  isProd,
  isTest,
  port: PORT,
  host: HOST,
  jwtSecret,
  accessTtlSec: 15 * 60,
  accessTtlMs: 15 * 60 * 1000,
  refreshTtlDays: 30,
  refreshTtlMs: 30 * 86400 * 1000,
  cookieSecure: isProd ? true : process.env.COOKIE_SECURE === 'true',
  cookieNameAt: 'salem_at',
  cookieNameRt: 'salem_rt',
  trustProxy,
  appUrl: APP_URL,
  // ===== Google (اختياري) =====
  google: {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    enabled: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  },
  allowedOrigins,
  adminUsernames,
  // ===== Database =====
  dbUrl: DATABASE_URL,
  dbFile: rawDbFile === ':memory:' ? ':memory:' : rawDbFile ? path.resolve(rawDbFile) : null,
  dbSsl,
  pg: {
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECT_TIMEOUT_MS || 10000),
    statementTimeoutMs: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 0)
  },
  // ===== Limits / Rate limiting =====
  limits: {
    api: { windowMs: 60 * 1000, limit: Number(process.env.RATE_API || 300) },
    auth: { windowMs: 15 * 60 * 1000, limit: Number(process.env.RATE_AUTH || 10) },
    authUser: { windowMs: 15 * 60 * 1000, limit: Number(process.env.RATE_AUTH_USER || 5) },
    upload: { windowMs: 60 * 1000, limit: Number(process.env.RATE_UPLOAD || 30) },
    msgMaxLength: Number(process.env.MSG_MAX_LEN || 4000),
    uploadMaxBytes: Number(process.env.UPLOAD_MAX_BYTES || 5 * 1024 * 1024),
    uploadMaxBase64: process.env.UPLOAD_MAX_BASE64 || '7mb',
    typingIntervalMs: 2000,
    maxSocketsPerUser: Number(process.env.SOCKET_MAX_PER_USER || 8),
    maxSocketsPerIp: Number(process.env.SOCKET_MAX_PER_IP || 20),
    message: {
      burst: Number(process.env.MSG_RATE_BURST || 10),
      perSec: Number(process.env.MSG_RATE_PER_SEC || 5)
    }
  },
  // ===== Socket.IO =====
  socket: {
    pingInterval: Number(process.env.SOCKET_PING_INTERVAL_MS || 25000),
    pingTimeout: Number(process.env.SOCKET_PING_TIMEOUT_MS || 20000),
    maxHttpBufferSize: Number(process.env.SOCKET_MAX_BUFFER_BYTES || 16 * 1024),
    upgradeTimeout: Number(process.env.SOCKET_UPGRADE_TIMEOUT_MS || 10000)
  },
  // ===== Uploads / Storage =====
  uploadDir,
  storage: {
    provider: STORAGE_PROVIDER,
    localDir: uploadDir,
    s3: {
      endpoint: process.env.S3_ENDPOINT || '',
      region: process.env.S3_REGION || 'us-east-1',
      bucket: process.env.S3_BUCKET || '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false'
    }
  },
  geoCacheFile: isTest
    ? path.join(os.tmpdir(), `salem-revgeo-cache-${process.pid}.json`)
    : path.resolve(
        process.env.GEO_CACHE_FILE || path.join(__dirname, '..', 'data', 'revgeo-cache.json')
      ),
  bodyLimit: process.env.BODY_LIMIT || '16kb',
  // ===== Logging =====
  logging: {
    level: process.env.LOG_LEVEL || (isTest ? 'warn' : isProd ? 'info' : 'debug'),
    json: process.env.LOG_JSON === 'true'
  },
  // ===== Server lifecycle =====
  server: {
    migrateRetries: Number(process.env.MIGRATE_RETRIES || 0),
    migrateRetryDelayMs: Number(process.env.MIGRATE_RETRY_DELAY_MS || 2000),
    shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000)
  },
  // ===== Optional (multi-instance scaling) =====
  // تُستخدم فقط عند الحاجة لتشغيل أكثر من خادم — ليست مطلوبة في الخادم الواحد.
  redisUrl: process.env.REDIS_URL || ''
};