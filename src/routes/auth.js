const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');
const presence = require('../presence');
const google = require('../google');
const geo = require('../geo');
const revgeo = require('../revgeo');
const {
  ApiError,
  parseCookies,
  randomToken,
  sha256Hex,
  toIso,
  safeUser,
  validateUsername,
  validatePassword,
  isUniqueViolation
} = require('../utils');
const { requireAuth, authLimiter, authUserLimiter, googleLimiter, gpsLimiter } = require('../middleware');

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#0984E3', '#E17055', '#FDCB6E', '#E84393', '#00CEC9', '#D63031'];
const DUMMY_HASH = bcrypt.hashSync('dummy-' + randomToken(6), 10);
const TZ_RE = /^[A-Za-z_]{2,24}(\/[A-Za-z0-9_+\-]{1,32}){0,4}$/;

function sanitizeTz(v) {
  const tz = String(v || '').trim();
  if (!tz || tz.length > 80 || !TZ_RE.test(tz)) return null;
  return tz;
}

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

function baseRoot(req) {
  if (config.appUrl) return config.appUrl;
  const host = req.get('host') || 'localhost';
  let proto = req.secure ? 'https' : 'http';
  if (config.trustProxy) proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  return `${proto}://${host}`;
}

function googleRedirectUri(req) {
  return `${baseRoot(req)}/api/auth/google/callback`;
}

async function uniqueGoogleUsername(email) {
  const base = google.usernameFromEmail(email);
  let candidate = base;
  for (let i = 0; i < 8; i++) {
    if (i > 0) candidate = `${base.slice(0, 20 - 4)}_${i + 1}`;
    const rows = await db.query('SELECT id FROM users WHERE username_lower = $1', [
      candidate.toLowerCase()
    ]);
    if (!rows.length) return candidate;
  }
  return `${base.slice(0, 16)}_${randomToken(3)}`;
}

async function findOrCreateGoogleUser(profile, req) {
  const email = (profile.email || '').toLowerCase();
  if (!email) throw new ApiError(400, 'GOOGLE_NO_EMAIL', 'لا يوجد بريد إلكتروني في حساب غوغل');

  let rows = await db.query('SELECT id, country, country_source FROM users WHERE google_sub = $1', [profile.sub]);
  if (!rows.length) {
    rows = await db.query('SELECT id, country, country_source FROM users WHERE email = $1', [email]);
  }

  const now = new Date().toISOString();
  const loc = geo.locationForReq(req);
  const country = loc ? loc.country : null;
  const tzIp = loc ? loc.timezone : null;
  const tzLocal = sanitizeTz(req.body && req.body.timezone);

  if (rows.length) {
    const id = Number(rows[0].id);
    const gps = rows[0].country_source === 'gps';
    await db.query(
      `UPDATE users SET
         email = COALESCE(email, CAST($2 AS TEXT)),
         google_sub = COALESCE(google_sub, CAST($3 AS TEXT)),
         avatar_url = COALESCE(avatar_url, CAST($4 AS TEXT)),
         tz_ip = COALESCE(tz_ip, CAST($6 AS TEXT)),
         tz_local = COALESCE(tz_local, CAST($7 AS TEXT)),
         country = CASE WHEN CAST($5 AS TEXT) IS NOT NULL AND NOT $8 THEN CAST($5 AS TEXT) ELSE country END,
         country_source = CASE WHEN CAST($5 AS TEXT) IS NOT NULL AND NOT $8 THEN CAST('ip' AS TEXT) ELSE country_source END
       WHERE id = $1`,
      [id, email, profile.sub, profile.picture || null, country, tzIp, tzLocal, gps]
    );
    return { id };
  }

  const username = await uniqueGoogleUsername(email);
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const source = country ? 'ip' : null;
  const inserted = await db.query(
    `INSERT INTO users (username, username_lower, password_hash, avatar_color, avatar_url, email, google_sub, country, country_source, tz_ip, tz_local, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL) RETURNING id`,
    [username, username.toLowerCase(), DUMMY_HASH, color, profile.picture || null, email, profile.sub, country, source, tzIp, tzLocal, now]
  );
  return { id: Number(inserted[0].id) };
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
  const loc = geo.locationForReq(req);
  const country = loc ? loc.country : null;
  const tzIp = loc ? loc.timezone : null;
  const tzLocal = sanitizeTz(body.timezone);

  const rows = await db.query(
    `INSERT INTO users (username, username_lower, password_hash, avatar_color, avatar_url, country, country_source, tz_ip, tz_local, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, NULL) RETURNING id`,
    [username, username.toLowerCase(), passwordHash, color, country, country ? 'ip' : null, tzIp, tzLocal, now]
  );
  const user = {
    id: Number(rows[0].id),
    username,
    avatar_color: color,
    country: country || null,
    tz_ip: tzIp || null,
    tz_local: tzLocal || null
  };

  const session = await createSession(user.id, req);
  issueCookies(res, session);
  res.status(201).json({ user });
});

router.post('/login', authLimiter, authUserLimiter, async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  const rows = await db.query(
    'SELECT id, username, password_hash, avatar_color, country, country_source, tz_ip, tz_local FROM users WHERE username_lower = $1',
    [username.toLowerCase()]
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'بيانات تسجيل الدخول غير صحيحة');
  }

  const loc = geo.locationForReq(req);
  const country = loc ? loc.country : null;
  const tzIp = loc ? loc.timezone : null;
  const tzLocal = sanitizeTz(body.timezone);
  if (country || tzIp) {
    await db.query(
      `UPDATE users SET
         country = CASE WHEN CAST($2 AS TEXT) IS NOT NULL AND country_source <> CAST($3 AS TEXT) THEN CAST($2 AS TEXT) ELSE country END,
         tz_ip = COALESCE(CAST($4 AS TEXT), tz_ip),
         country_source = CASE WHEN CAST($2 AS TEXT) IS NOT NULL AND country_source <> CAST($3 AS TEXT) THEN CAST($5 AS TEXT) ELSE country_source END
       WHERE id = $1`,
      [Number(user.id), country, 'gps', tzIp, 'ip']
    );
  }
  if (tzLocal) {
    await db.query('UPDATE users SET tz_local = $2 WHERE id = $1', [Number(user.id), tzLocal]);
  }

  const session = await createSession(Number(user.id), req);
  issueCookies(res, session);
  const finalCountry = user.country_source === 'gps' ? user.country : country || user.country || null;
  res.json({
    user: {
      id: Number(user.id),
      username: user.username,
      avatar_color: user.avatar_color,
      country: finalCountry,
      tz_ip: tzIp || user.tz_ip || null,
      tz_local: tzLocal || user.tz_local || null
    }
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

router.get('/google/start', googleLimiter, async (req, res, next) => {
  try {
    if (!config.google.enabled) {
      throw new ApiError(400, 'GOOGLE_DISABLED', 'تسجيل الدخول عبر غوغل غير مفعّل');
    }
    const redirectUri = googleRedirectUri(req);
    const { url } = google.authorizeUrl(redirectUri);
    res.json({ url });
  } catch (e) {
    next(e);
  }
});

router.get('/google/callback', googleLimiter, async (req, res) => {
  const root = baseRoot(req);
  const redirect = (ok, code) =>
    res.redirect(`${root}/?auth=google&status=${ok ? 'ok' : 'error'}&code=${encodeURIComponent(code)}`);

  if (!config.google.enabled) return redirect(false, 'GOOGLE_DISABLED');
  if (!google.consumeState(req.query.state)) return redirect(false, 'GOOGLE_BAD_STATE');

  try {
    const token = await google.exchangeCode(String(req.query.code || ''), googleRedirectUri(req));
    const profile = await google.verifyIdToken(token.id_token);
    if (profile.email_verified !== true) return redirect(false, 'GOOGLE_EMAIL_UNVERIFIED');

    const user = await findOrCreateGoogleUser(profile, req);
    const session = await createSession(user.id, req);
    issueCookies(res, session);
    redirect(true, 'OK');
  } catch (err) {
    console.error('google callback error:', err.message);
    redirect(false, err.code || 'GOOGLE_FAILED');
  }
});

router.post('/location', gpsLimiter, requireAuth, async (req, res) => {
  const body = req.body || {};
  const lat = Number(body.latitude);
  const lon = Number(body.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new ApiError(400, 'BAD_COORDINATES', 'إحداثيات غير صالحة');
  }
  const code = await revgeo.lookup(lat, lon);
  if (!code) throw new ApiError(502, 'GEO_FAILED', 'تعذّر تحديد البلد من موقعك');
  await db.query(
    'UPDATE users SET country = $2, country_source = $3 WHERE id = $1',
    [req.user.id, code, 'gps']
  );
  res.json({ country: code });
});

router.get('/me', requireAuth, async (req, res) => {
  const rows = await db.query(
    'SELECT id, username, avatar_color, avatar_url, country, tz_ip, tz_local, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!rows.length) throw new ApiError(401, 'UNAUTHORIZED', 'مطلوب تسجيل الدخول');
  res.json({ user: safeUser(rows[0]) });
});

module.exports = router;