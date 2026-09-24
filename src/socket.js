const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const presence = require('./presence');
const {
  parseCookies,
  validateId,
  validateNonnegInt,
  validateMessageContent,
  validateClientMsgId,
  mapMessage
} = require('./utils');

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
}

const msgBuckets = new Map();
function messageRateAllow(userId) {
  const now = Date.now();
  const burst = 10;
  const perSec = 5;
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

const bucketCleanup = setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [userId, b] of msgBuckets) {
    if (b.ts < cutoff) msgBuckets.delete(userId);
  }
}, 10 * 60 * 1000);
if (bucketCleanup.unref) bucketCleanup.unref();

const typingLast = new Map();
function typingAllowed(userId, convId) {
  const now = Date.now();
  const key = `${userId}:${convId}`;
  const last = typingLast.get(key);
  if (last && now - last < config.limits.typingIntervalMs) return false;
  typingLast.set(key, now);
  return true;
}

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

function err(code, message) {
  return { error: { code, message } };
}

function replyWith(fn, caught) {
  const code = caught && caught.code ? caught.code : 'BAD_REQUEST';
  fn(err(code, caught.message || 'طلب غير صالح'));
}

function attachSocketIO(httpServer) {
  const io = new Server(httpServer, {
    maxHttpBufferSize: 16 * 1024,
    cors: {
      origin: config.allowedOrigins.size ? Array.from(config.allowedOrigins) : false,
      credentials: true
    }
  });
  presence.init(io);

  io.use((socket, next) => {
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
      socket.auth = {
        userId: Number(payload.sub),
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

    socket.on('disconnect', () => {
      presence.unregister(socket.id, userId, ip);
      broadcastPresence();
    });

    if (userCount > presence.usage.maxUserSockets || ipCount > presence.usage.maxIpSockets) {
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
        const content = validateMessageContent(data.content);
        const replyToId =
          data.replyToId === undefined ? null : validateNonnegInt(data.replyToId);

        if (!messageRateAllow(userId)) {
          return reply(err('RATE_LIMITED', 'إرسال رسائل أسرع من اللازم، انتظر قليلًا'));
        }

        await assertMember(convId, userId);

        if (cid) {
          const dup = await db.query(
            'SELECT id, conversation_id, sender_id, content, kind, reply_to_id, created_at, edited_at, deleted_at FROM messages WHERE conversation_id = $1 AND client_msg_id = $2',
            [convId, cid]
          );
          if (dup.length) {
            return reply({ ok: true, message: mapMessage(dup[0]), duplicate: true });
          }
        }

        let inserted;
        try {
          const now = new Date().toISOString();
          inserted = await db.query(
            `INSERT INTO messages (conversation_id, sender_id, content, kind, client_msg_id, reply_to_id, created_at)
             VALUES ($1, $2, $3, 'text', $4, $5, $6) RETURNING id, created_at`,
            [convId, userId, content, cid, replyToId, now]
          );
        } catch (err) {
          const isDup = err && (err.code === '23505' || String(err.message).includes('UNIQUE'));
          if (isDup && cid) {
            const existing = await db.query(
              'SELECT id, conversation_id, sender_id, content, kind, reply_to_id, created_at, edited_at, deleted_at FROM messages WHERE conversation_id = $1 AND client_msg_id = $2',
              [convId, cid]
            );
            if (existing.length) {
              return reply({ ok: true, message: mapMessage(existing[0]), duplicate: true });
            }
          }
          throw err;
        }

        const message = {
          id: Number(inserted[0].id),
          conversation_id: convId,
          sender_id: userId,
          content,
          kind: 'text',
          reply_to_id: replyToId,
          created_at: inserted[0].created_at instanceof Date
            ? inserted[0].created_at.toISOString()
            : inserted[0].created_at,
          edited_at: null,
          deleted_at: null,
          deleted: false
        };

        await db.query(
          'UPDATE conversations SET last_message_id = $1, last_message_at = $2, updated_at = $2 WHERE id = $3',
          [message.id, message.created_at, convId]
        );

        const others = await getOtherMembers(convId, userId);
        for (const otherId of others) {
          presence.emitToUser(otherId, 'message:new', message);
        }
        socket.to(`user:${userId}`).emit('message:new', message);

        reply({ ok: true, message });
      } catch (caught) {
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

module.exports = { attachSocketIO };