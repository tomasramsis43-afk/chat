'use strict';
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const metrics = require('./metrics');
const presence = require('./presence');
const {
  parseCookies,
  validateId,
  validateNonnegInt,
  validateClientMsgId,
  mapMessage
} = require('./utils');
const { validateMediaPayload } = require('./uploads');

let presenceTimer = null;

async function presencePayload() {
  const ids = presence.onlineUserIds();
  if (!ids.length) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const rows = await db.query(
    `SELECT id, username, avatar_color, country FROM users WHERE id IN (${ph})`,
    ids
  );
  return rows.map((u) => ({
    id: Number(u.id),
    username: u.username,
    avatar_color: u.avatar_color,
    country: u.country || null
  }));
}

function broadcastPresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(async () => {
    presenceTimer = null;
    if (presence.connectedSockets().length === 0) return;
    const list = await presencePayload();
    const io = presence.getIO();
    if (io) io.emit('presence', list);
  }, 300);
  if (presenceTimer.unref) presenceTimer.unref();
}

// ===== Message rate limiting (token bucket) =====
// في خادم واحد: في الذاكرة. عند التوسع لعدة خوادم يُستبدل بحل موزّع عبر نفس الواجهة.
const msgBuckets = new Map();
function messageRateAllow(userId) {
  const now = Date.now();
  const { burst, perSec } = config.limits.message;
  let b = msgBuckets.get(userId);
  if (!b) {
    b = { tokens: burst, ts: now };
    msgBuckets.set(userId, b);
  }
  const elapsed = (now - b.ts) / 1000;
  b.tokens = Math.min(burst, b.tokens + elapsed * perSec);
  b.ts = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return true;
  }
  return false;
}

// ===== Typing throttle =====
const typingLast = new Map();
function typingAllowed(userId, convId) {
  const now = Date.now();
  const key = `${userId}:${convId}`;
  const last = typingLast.get(key);
  if (last && now - last < config.limits.typingIntervalMs) return false;
  typingLast.set(key, now);
  return true;
}

// ===== Periodic cleanup لمنع التسريبات في الذاكرة + تسجيل لتصفيتها عند الإغلاق =====
const timers = [];
function scheduleCleanup(fn, ms) {
  const t = setInterval(fn, ms);
  if (t.unref) t.unref();
  timers.push(t);
}

scheduleCleanup(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [userId, b] of msgBuckets) {
    if (b.ts < cutoff) msgBuckets.delete(userId);
  }
}, 10 * 60 * 1000);

scheduleCleanup(() => {
  const cutoff = Date.now() - 2 * 60 * 1000;
  for (const [key, ts] of typingLast) {
    if (ts < cutoff) typingLast.delete(key);
  }
}, 5 * 60 * 1000);

async function assertMember(convId, userId) {
  const rows = await db.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [convId, userId]
  );
  if (!rows.length) {
    const err = new Error('المحادثة غير موجودة');
    err.code = 'FORBIDDEN';
    throw err;
  }
}

async function getOtherMembers(convId, exceptUserId) {
  const rows = await db.query(
    'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2',
    [convId, exceptUserId]
  );
  return rows.map((r) => Number(r.user_id));
}

// يمنع إرسال رسالة لو في حظر (بأي اتجاه) بين المرسل وأي عضو تاني في المحادثة —
// ده أساسًا بيغطي الـ DM (عضو واحد تاني) وهو أهم سيناريو للحظر.
async function assertNotBlocked(convId, userId) {
  const others = await getOtherMembers(convId, userId);
  if (!others.length) return;
  const ph = others.map((_, i) => `$${i + 2}`).join(',');
  const rows = await db.query(
    `SELECT 1 FROM blocks WHERE
       (blocker_id = $1 AND blocked_id IN (${ph}))
       OR (blocked_id = $1 AND blocker_id IN (${ph}))
     LIMIT 1`,
    [userId, ...others]
  );
  if (rows.length) {
    const e = new Error('لا يمكن إرسال رسائل، يوجد حظر بينكما');
    e.code = 'BLOCKED';
    throw e;
  }
}

function err(code, message) {
  return { error: { code, message } };
}

function replyWith(fn, caught) {
  const code = caught && caught.code ? caught.code : 'BAD_REQUEST';
  fn(err(code, caught.message || 'طلب غير صالح'));
}

function attachSocketIO(httpServer) {
  const io = new Server(httpServer, {
    maxHttpBufferSize: config.socket.maxHttpBufferSize,
    pingInterval: config.socket.pingInterval,
    pingTimeout: config.socket.pingTimeout,
    upgradeTimeout: config.socket.upgradeTimeout,
    cors: {
      origin: config.allowedOrigins.size ? Array.from(config.allowedOrigins) : false,
      credentials: true
    }
  });
  presence.init(io);

  io.engine.on('connection_error', (socketErr) => {
    logger.warn('socket engine connection_error', {
      code: socketErr && socketErr.code,
      message: socketErr && socketErr.message
    });
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie || '');
      const token = cookies[config.cookieNameAt];
      if (!token) return next(new Error('UNAUTHORIZED'));

      const origin = socket.handshake.headers.origin;
      if (origin) {
        let allowed = config.allowedOrigins.has(origin);
        if (!allowed) {
          try {
            const self = new URL(origin);
            allowed =
              self.host === socket.handshake.headers.host &&
              (self.protocol === 'http:' || self.protocol === 'https:');
          } catch {}
        }
        if (!allowed) return next(new Error('FORBIDDEN'));
      }

      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      const uid = Number(payload.sub);
      const banRows = await db.query('SELECT banned_at FROM users WHERE id = $1', [uid]);
      if (!banRows.length || banRows[0].banned_at) return next(new Error('UNAUTHORIZED'));
      socket.auth = {
        userId: uid,
        sid: payload.sid ? Number(payload.sid) : null,
        ip: socket.handshake.address || ''
      };
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, sid, ip } = socket.auth || {};

    const { userCount, ipCount } = presence.register(socket.id, userId, ip);
    socket.join(`user:${userId}`);

    metrics.incGauge('socket_connections_active', {}, 1);
    metrics.inc('socket_connections_total', {}, 1);

    socket.on('disconnect', () => {
      presence.unregister(socket.id, userId, ip);
      metrics.incGauge('socket_connections_active', {}, -1);
      broadcastPresence();
    });

    socket.on('error', (socketErr) => {
      logger.debug('socket error', { message: socketErr && socketErr.message, requestId: socket.id });
    });

    if (userCount > presence.usage.maxUserSockets || ipCount > presence.usage.maxIpSockets) {
      metrics.inc('socket_errors_total', { code: 'TOO_MANY_SESSIONS' }, 1);
      socket.emit('session:error', {
        error: { code: 'TOO_MANY_SESSIONS', message: 'عدد الجلسات المفتوحة تجاوز الحد' }
      });
      socket.disconnect(true);
      return;
    }

    presencePayload().then((list) => socket.emit('presence', list));
    broadcastPresence();

    socket.on('message:send', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const data = payload || {};
        const convId = validateId(data.conversationId);
        const cid = validateClientMsgId(data.clientMsgId);
        const contentRaw = typeof data.content === 'string' ? data.content : '';
        const replyToId =
          data.replyToId === undefined ? null : validateNonnegInt(data.replyToId);

        const media = validateMediaPayload({ ...data, content: contentRaw });

        if (!messageRateAllow(userId)) {
          metrics.inc('socket_message_rate_limited_total', {}, 1);
          return reply(err('RATE_LIMITED', 'إرسال رسائل أسرع من اللازم، انتظر قليلًا'));
        }

        await assertMember(convId, userId);
        await assertNotBlocked(convId, userId);

        if (cid) {
          const dup = await db.query(
            'SELECT id, conversation_id, sender_id, content, kind, media_url, media_name, media_size, media_mime, reply_to_id, created_at, edited_at, deleted_at FROM messages WHERE conversation_id = $1 AND client_msg_id = $2',
            [convId, cid]
          );
          if (dup.length) {
            return reply({ ok: true, message: mapMessage(dup[0]), duplicate: true });
          }
        }

        // insert + تحديث last_message داخل معاملة واحدة لتقليل round-trips وللذرّيّة.
        let inserted;
        try {
          const now = new Date().toISOString();
          inserted = await db.transaction(async (tx) => {
            const r = await tx.query(
              `INSERT INTO messages (conversation_id, sender_id, content, kind, media_url, media_name, media_size, media_mime, client_msg_id, reply_to_id, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, created_at`,
              [convId, userId, media.content, media.kind, media.mediaUrl, media.mediaName, media.mediaSize, media.mediaMime, cid, replyToId, now]
            );
            const msgId = Number(r[0].id);
            await tx.query(
              'UPDATE conversations SET last_message_id = $1, last_message_at = $2, updated_at = $2 WHERE id = $3',
              [msgId, now, convId]
            );
            return r;
          });
        } catch (txErr) {
          const isDup =
            txErr && (txErr.code === '23505' || String(txErr.message).includes('UNIQUE'));
          if (isDup && cid) {
            const existing = await db.query(
              'SELECT id, conversation_id, sender_id, content, kind, media_url, media_name, media_size, media_mime, reply_to_id, created_at, edited_at, deleted_at FROM messages WHERE conversation_id = $1 AND client_msg_id = $2',
              [convId, cid]
            );
            if (existing.length) {
              return reply({ ok: true, message: mapMessage(existing[0]), duplicate: true });
            }
          }
          throw txErr;
        }

        const message = {
          id: Number(inserted[0].id),
          conversation_id: convId,
          sender_id: userId,
          content: media.content,
          kind: media.kind,
          media_url: media.mediaUrl,
          media_name: media.mediaName,
          media_size: media.mediaSize,
          media_mime: media.mediaMime,
          reply_to_id: replyToId,
          created_at:
            inserted[0].created_at instanceof Date
              ? inserted[0].created_at.toISOString()
              : inserted[0].created_at,
          edited_at: null,
          deleted_at: null,
          deleted: false
        };

        const others = await getOtherMembers(convId, userId);
        for (const otherId of others) {
          presence.emitToUser(otherId, 'message:new', message);
        }
        socket.to(`user:${userId}`).emit('message:new', message);

        metrics.inc('socket_messages_sent_total', {}, 1);
        reply({ ok: true, message });
      } catch (caught) {
        metrics.inc('socket_message_errors_total', {}, 1);
        logger.debug('message:send error', { message: caught.message, code: caught.code });
        replyWith(reply, caught);
      }
    });

    socket.on('conversation:read', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const data = payload || {};
        const convId = validateId(data.conversationId);
        const lastReadId = validateNonnegInt(data.lastReadId);

        await assertMember(convId, userId);

        const rows = await db.query(
          `UPDATE conversation_members
           SET last_read_message_id = CASE WHEN last_read_message_id > $2
              THEN last_read_message_id ELSE $2 END
           WHERE conversation_id = $1 AND user_id = $3
           RETURNING last_read_message_id`,
          [convId, lastReadId, userId]
        );
        if (!rows.length) throw new Error('المحادثة غير موجودة');
        const effective = Number(rows[0].last_read_message_id);
        if (effective >= lastReadId) {
          presence.emitToUsers(await getOtherMembers(convId, userId), 'conversation:read', {
            conversationId: convId,
            userId,
            lastReadId: effective
          });
        }
        metrics.inc('socket_read_receipts_total', {}, 1);
        reply({ ok: true, lastReadId: effective });
      } catch (caught) {
        replyWith(reply, caught);
      }
    });

    socket.on('typing', (payload, ack) => {
      try {
        const data = payload || {};
        const convId = validateId(data.conversationId);
        if (!typingAllowed(userId, convId)) {
          if (typeof ack === 'function') ack({ ok: true, throttled: true });
          return;
        }
        metrics.inc('socket_typing_events_total', {}, 1);
        getOtherMembers(convId, userId).then((others) => {
          presence.emitToUsers(others, 'typing', { conversationId: convId, userId });
        });
        if (typeof ack === 'function') ack({ ok: true });
      } catch {
        if (typeof ack === 'function') ack(err('BAD_REQUEST', 'طلب غير صالح'));
      }
    });
  });

  return io;
}

function shutdown() {
  if (presenceTimer) {
    clearTimeout(presenceTimer);
    presenceTimer = null;
  }
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

module.exports = { attachSocketIO, shutdown };