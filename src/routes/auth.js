const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');
const presence = require('../presence');
const {
  ApiError,
  parseCookies,
  randomToken,
  sha256Hex,
  toIso,
  safeUser,
  validateUsername,
  validatePassword
} = require('../utils');
const { requireAuth, authLimiter, authUserLimiter } = require('../middleware');

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#0984E3', '#E17055', '#FDCB6E', '#E84393', '#00CEC9', '#D63031'];
const DUMMY_HASH = bcrypt.hashSync('dummy-' + randomToken(6), 10);

const router = Router();

function setAuthCookies(res, accessToken, refreshRaw, refreshExpiresAt) {
  res.cookie(config.cookieNameAt, accessToken, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: config.accessTtlMs
  });
  res.cookie(config.cookieNameRt, refreshRaw, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: config.refreshTtlMs
  });
}

function clearAuthCookies(res) {
  res.clearCookie(config.cookieNameAt, { path: '/' });
  res.clearCookie(config.cookieNameRt, { path: '/api/auth' });
}

async function createSession(userId, req) {
  const raw = randomToken();
  const expiresAt = new Date(Date.now() + config.refreshTtlMs).toISOString();
  const now = new Date().toISOString();
  const rows = await db.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      userId,
      sha256Hex(raw),
      (req.headers['user-agent'] || '').slice(0, 255),
      req.ip || '',
      now,
      expiresAt
    ]
  );
  const sessionId = Number(rows[0].id);
  const accessToken = jwt.sign({ sub: userId, sid: sessionId }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.accessTtlSec
  });
  return { sessionId, accessToken, refreshRaw: raw, expiresAt };
}

function issueCookies(res, session) {
  setAuthCookies(res, session.accessToken, session.refreshRaw, session.expiresAt);
}

router.post('/register', authLimiter, async (req, res) => {
  const body = req.body || {};
  const username = validateUsername(body.username);
  const password = validatePassword(body.password);

  const existing = await db.query(
    'SELECT id FROM users WHERE username_lower = $1',
    [username.toLowerCase()]
  );
  if (existing.length) throw new ApiError(409, 'USERNAME_TAKEN', 'الاسم ده مستخدم بالفعل');

  const passwordHash = await bcrypt.hash(password, 10);
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const now = new Date().toISOString();

  const rows = await db.query(
    `INSERT INTO users (username, username_lower, password_hash, avatar_color, avatar_url, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, NULL, $5, NULL) RETURNING id`,
    [username, username.toLowerCase(), passwordHash, color, now]
  );
  const user = { id: Number(rows[0].id), username, avatar_color: color };

  const session = await createSession(user.id, req);
  issueCookies(res, session);
  res.status(201).json({ user });
});

router.post('/login', authLimiter, authUserLimiter, async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  const rows = await db.query(
    'SELECT id, username, password_hash, avatar_color FROM users WHERE username_lower = $1',
    [username.toLowerCase()]
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'بيانات تسجيل الدخول غير صحيحة');
  }

  const session = await createSession(Number(user.id), req);
  issueCookies(res, session);
  res.json({
    user: { id: Number(user.id), username: user.username, avatar_color: user.avatar_color }
  });
});

router.post('/refresh', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const rt = cookies[config.cookieNameRt];
  if (!rt) throw new ApiError(401, 'NO_SESSION', 'الجلسة منتهية');

  const rows = await db.query(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.ip, s.user_agent
     FROM sessions s WHERE s.refresh_token_hash = $1`,
    [sha256Hex(rt)]
  );
  const session = rows[0];
  const expired = !session || new Date(toIso(session.expires_at)).getTime() <= Date.now();

  if (!session || session.revoked_at || expired) {
    if (session) {
      await db.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1', [
        Number(session.id),
        new Date().toISOString()
      ]);
    }
    clearAuthCookies(res);
    throw new ApiError(401, 'NO_SESSION', 'الجلسة منتهية');
  }

  const sid = Number(session.id);
  await db.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1', [
    sid,
    new Date().toISOString()
  ]);

  const raw2 = randomToken();
  const expiresAt = new Date(Date.now() + config.refreshTtlMs).toISOString();
  const now = new Date().toISOString();
  const ins = await db.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [Number(session.user_id), sha256Hex(raw2), session.user_agent, session.ip, now, expiresAt]
  );

  const accessToken = jwt.sign(
    { sub: Number(session.user_id), sid: Number(ins[0].id) },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: config.accessTtlSec }
  );

  setAuthCookies(res, accessToken, raw2, expiresAt);
  res.json({ ok: true });
});

router.post('/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const rt = cookies[config.cookieNameRt];
  const at = cookies[config.cookieNameAt];
  const now = new Date().toISOString();

  let userId = req.user ? req.user.id : null;

  if (rt) {
    await db.query(
      'UPDATE sessions SET revoked_at = $2 WHERE refresh_token_hash = $1 AND revoked_at IS NULL',
      [sha256Hex(rt), now]
    );
  } else if (at) {
    try {
      const payload = jwt.verify(at, config.jwtSecret, { algorithms: ['HS256'] });
      userId = Number(payload.sub);
      await db.query(
        'UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND user_id = $3 AND revoked_at IS NULL',
        [Number(payload.sid), now, Number(payload.sub)]
      );
    } catch {}
  }

  if (userId) presence.disconnectUser(userId);

  clearAuthCookies(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const rows = await db.query(
    'SELECT id, username, avatar_color, avatar_url, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!rows.length) throw new ApiError(401, 'UNAUTHORIZED', 'مطلوب تسجيل الدخول');
  res.json({ user: safeUser(rows[0]) });
});

module.exports = router;