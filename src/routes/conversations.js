const { Router } = require('express');
const db = require('../db');
const presence = require('../presence');
const {
  ApiError,
  toIso,
  clampInt,
  validateId,
  validateNonnegInt,
  dmKey,
  isUniqueViolation,
  mapMessage
} = require('../utils');
const { requireAuth } = require('../middleware');

const router = Router();

async function assertMember(convId, userId) {
  const rows = await db.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [convId, userId]
  );
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'المحادثة غير موجودة');
}

async function getMembers(convId, exceptUserId = null) {
  let rows;
  if (exceptUserId === null) {
    rows = await db.query(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
      [convId]
    );
  } else {
    rows = await db.query(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2',
      [convId, exceptUserId]
    );
  }
  return rows.map((r) => Number(r.user_id));
}

router.get('/', requireAuth, async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const rows = await db.query(
    `SELECT c.id, c.type, c.dm_key, c.name, c.last_message_id, c.last_message_at, c.created_at,
            cm.last_read_message_id, cm.muted_until, cm.archived_at,
            m.content AS last_content, m.kind AS last_kind, m.sender_id AS last_sender_id,
            m.created_at AS last_created_at, m.deleted_at AS last_deleted_at,
            ou.id AS other_id, ou.username AS other_username, ou.avatar_color AS other_avatar_color,
            ou.country AS other_country, ou.tz_ip AS other_tz_ip, ou.tz_local AS other_tz_local,
            (SELECT COUNT(*) FROM messages sm
              WHERE sm.conversation_id = c.id
                AND sm.id > cm.last_read_message_id
                AND sm.sender_id <> $1) AS unread
     FROM conversation_members cm
     JOIN conversations c ON c.id = cm.conversation_id
     LEFT JOIN messages m ON m.id = c.last_message_id
     LEFT JOIN conversation_members om
       ON om.conversation_id = c.id AND om.user_id <> $1 AND c.type = 'dm'
     LEFT JOIN users ou ON ou.id = om.user_id
     WHERE cm.user_id = $1
     ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
     LIMIT $2`,
    [req.user.id, limit]
  );

  const conversations = rows.map((row) => {
    const deleted = !!row.last_deleted_at;
    const online = row.other_id ? presence.isOnline(Number(row.other_id)) : false;
    return {
      id: Number(row.id),
      type: row.type,
      name: row.type === 'dm' ? row.other_username : row.name,
      other: row.other_id
        ? {
            id: Number(row.other_id),
            username: row.other_username,
            avatar_color: row.other_avatar_color,
            country: row.other_country || null,
            tz_ip: row.other_tz_ip || null,
            tz_local: row.other_tz_local || null,
            online
          }
        : null,
      lastMessage: row.last_message_id
        ? {
            id: Number(row.last_message_id),
            content: deleted ? null : row.last_content,
            kind: row.last_kind,
            sender_id: Number(row.last_sender_id),
            created_at: toIso(row.last_created_at),
            deleted
          }
        : null,
      lastMessageAt: toIso(row.last_message_at),
      unread: Number(row.unread || 0),
      lastReadMessageId: Number(row.last_read_message_id || 0),
      muted: !!row.muted_until,
      archived: !!row.archived_at
    };
  });

  res.json({ conversations });
});

router.get('/:id/messages', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  await assertMember(convId, req.user.id);

  const before = req.query.before !== undefined ? validateNonnegInt(req.query.before) : null;
  const after = req.query.after !== undefined ? validateNonnegInt(req.query.after) : null;
  const limit = clampInt(req.query.limit, 1, 100, 50);

  const rows = await db.query(
    `SELECT id, conversation_id, sender_id, content, kind, client_msg_id, reply_to_id,
            created_at, edited_at, deleted_at
     FROM messages
     WHERE conversation_id = $1
       AND ($2 IS NULL OR id < $2)
       AND ($3 IS NULL OR id > $3)
     ORDER BY id DESC
     LIMIT $4`,
    [convId, before, after, limit + 1]
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const messages = page.slice().reverse().map(mapMessage);
  const nextBefore = hasMore ? Number(rows[limit - 1].id) : null;

  res.json({ messages, nextBefore });
});

router.post('/', requireAuth, async (req, res) => {
  const otherId = validateId((req.body || {}).userId);
  if (otherId === req.user.id) {
    throw new ApiError(400, 'BAD_REQUEST', 'لا يمكن فتح محادثة مع نفسك');
  }

  const userExists = await db.query('SELECT id FROM users WHERE id = $1', [otherId]);
  if (!userExists.length) {
    throw new ApiError(404, 'NOT_FOUND', 'المستخدم غير موجود');
  }

  const key = dmKey(req.user.id, otherId);
  const found = await db.query('SELECT id FROM conversations WHERE dm_key = $1', [key]);
  if (found.length) {
    const id = Number(found[0].id);
    await db.query(
      'INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [id, req.user.id, 'member', new Date().toISOString()]
    );
    return res.json({ conversation: await summary(id, req.user.id) });
  }

  try {
    const convId = await db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const r = await tx.query(
        `INSERT INTO conversations (type, dm_key, created_by, created_at)
         VALUES ('dm', $1, $2, $3) RETURNING id`,
        [key, req.user.id, now]
      );
      const id = Number(r[0].id);
      await tx.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', $3)`,
        [id, req.user.id, now]
      );
      await tx.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
         VALUES ($1, $2, 'member', $3)`,
        [id, otherId, now]
      );
      return id;
    });
    res.status(201).json({ conversation: await summary(convId, req.user.id) });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await db.query('SELECT id FROM conversations WHERE dm_key = $1', [key]);
      if (existing.length) {
        return res.json({ conversation: await summary(Number(existing[0].id), req.user.id) });
      }
    }
    throw err;
  }
});

router.post('/:id/read', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  await assertMember(convId, req.user.id);
  const lastReadId = validateNonnegInt((req.body || {}).lastReadId);

  const rows = await db.query(
    `UPDATE conversation_members
     SET last_read_message_id = CASE WHEN last_read_message_id > $2
        THEN last_read_message_id ELSE $2 END
     WHERE conversation_id = $1 AND user_id = $3
     RETURNING last_read_message_id`,
    [convId, lastReadId, req.user.id]
  );
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'المحادثة غير موجودة');

  const effective = Number(rows[0].last_read_message_id);
  if (effective >= lastReadId) {
    presence.emitToUsers(await getMembers(convId, req.user.id), 'conversation:read', {
      conversationId: convId,
      userId: req.user.id,
      lastReadId: effective
    });
  }

  res.json({ lastReadId: effective });
});

async function summary(convId, forUserId) {
  const rows = await db.query(
    `SELECT c.id, c.type, c.name,
            ou.id AS other_id, ou.username AS other_username, ou.avatar_color AS other_avatar_color,
            ou.country AS other_country, ou.tz_ip AS other_tz_ip, ou.tz_local AS other_tz_local
     FROM conversations c
     LEFT JOIN conversation_members om ON om.conversation_id = c.id AND om.user_id <> $1
     LEFT JOIN users ou ON ou.id = om.user_id
     WHERE c.id = $2`,
    [forUserId, convId]
  );
  const row = rows[0] || { id: convId, type: 'dm' };
  const result = {
    id: Number(row.id),
    type: row.type
  };
  if (row.type === 'dm' && row.other_id) {
    const otherId = Number(row.other_id);
    result.other = {
      id: otherId,
      username: row.other_username,
      avatar_color: row.other_avatar_color,
      country: row.other_country || null,
      tz_ip: row.other_tz_ip || null,
      tz_local: row.other_tz_local || null,
      online: presence.isOnline(otherId)
    };
  } else if (row.name !== null && row.name !== undefined) {
    result.name = row.name;
  }
  return result;
}

module.exports = router;