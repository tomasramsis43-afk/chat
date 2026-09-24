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
  mapMessage,
  safeUser
} = require('../utils');
const { requireAuth } = require('../middleware');

const router = Router();
const GROUP_MAX_MEMBERS = 50;

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

async function memberRole(convId, userId) {
  const rows = await db.query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [convId, userId]
  );
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'المحادثة غير موجودة');
  return rows[0].role;
}

async function requireManageRole(convId, userId) {
  const role = await memberRole(convId, userId);
  if (role !== 'owner' && role !== 'admin') {
    throw new ApiError(403, 'FORBIDDEN', 'صلاحية مدير مطلوبة');
  }
  return role;
}

function validateGroupName(value) {
  const name = String(value || '').trim();
  if (name.length < 2 || name.length > 64) {
    throw new ApiError(400, 'BAD_REQUEST', 'اسم المجموعة يجب أن يكون 2-64 حرفًا');
  }
  return name;
}

async function memberList(convId) {
  const rows = await db.query(
    `SELECT u.id, u.username, u.avatar_color, u.avatar_url, u.country, u.tz_ip, u.tz_local,
            u.created_at, cm.role, cm.joined_at
     FROM conversation_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = $1
     ORDER BY cm.joined_at, u.username`,
    [convId]
  );
  return rows.map((r) => ({
    ...safeUser(r),
    role: r.role,
    joined_at: toIso(r.joined_at),
    online: presence.isOnline(Number(r.id))
  }));
}

async function emitGroupUpdate(convId, extra = {}) {
  const ids = await getMembers(convId);
  presence.emitToUsers(ids, 'conversation:members', {
    conversationId: convId,
    members: await memberList(convId),
    ...extra
  });
}

router.get('/', requireAuth, async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const beforeTs = req.query.beforeTs !== undefined ? String(req.query.beforeTs).trim() : null;
  const beforeId = req.query.beforeId !== undefined ? validateNonnegInt(req.query.beforeId) : null;

  const params = [req.user.id];
  let where = ' cm.user_id = $1';
  if (beforeTs && beforeId !== null) {
    const kTs = params.length + 1;
    const kId = params.length + 2;
    where += ` AND (
      COALESCE(c.last_message_at, c.created_at) < $${kTs}
      OR (COALESCE(c.last_message_at, c.created_at) = $${kTs} AND c.id < $${kId})
    )`;
    params.push(beforeTs, beforeId);
  }
  params.push(limit + 1);

  const rows = await db.query(
    `SELECT c.id, c.type, c.dm_key, c.name, c.last_message_id, c.last_message_at, c.created_at,
            cm.last_read_message_id, cm.muted_until, cm.archived_at, cm.role AS cm_role,
            m.content AS last_content, m.kind AS last_kind, m.sender_id AS last_sender_id,
            m.created_at AS last_created_at, m.deleted_at AS last_deleted_at,
m.media_url AS last_media_url, m.media_name AS last_media_name,
             cm.pinned_at AS cm_pinned_at,
             ou.id AS other_id, ou.username AS other_username, ou.avatar_color AS other_avatar_color,
             ou.country AS other_country, ou.tz_ip AS other_tz_ip, ou.tz_local AS other_tz_local,
             ou.gender AS other_gender,
            (SELECT COUNT(*) FROM conversation_members mc
              WHERE mc.conversation_id = c.id) AS member_count,
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
     WHERE${where}
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
     LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1] || null;
  const nextBeforeTs = hasMore && last ? toIso(last.last_message_at || last.created_at) : null;
  const nextBeforeId = hasMore && last ? Number(last.id) : null;

  const conversations = page.map((row) => {
    const deleted = !!row.last_deleted_at;
    const online = row.other_id ? presence.isOnline(Number(row.other_id)) : false;
    const mutedUntil = toIso(row.muted_until);
    const mutedNow = mutedUntil ? new Date(mutedUntil).getTime() > Date.now() : false;
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
            gender: row.other_gender || null,
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
            deleted,
            mediaUrl: row.last_media_url || null,
            mediaName: row.last_media_name || null
          }
        : null,
      lastMessageAt: toIso(row.last_message_at),
      unread: Number(row.unread || 0),
      lastReadMessageId: Number(row.last_read_message_id || 0),
      created_at: toIso(row.created_at),
      pinned: !!row.cm_pinned_at,
      muted: mutedNow,
      mutedUntil,
      archived: !!row.archived_at,
      memberCount: row.type === 'group' ? Number(row.member_count || 0) : null,
      role: row.cm_role || null
    };
  });

  res.json({ conversations, nextBeforeTs, nextBeforeId });
});

router.get('/:id/messages', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  await assertMember(convId, req.user.id);

  const before = req.query.before !== undefined ? validateNonnegInt(req.query.before) : null;
  const after = req.query.after !== undefined ? validateNonnegInt(req.query.after) : null;
  const limit = clampInt(req.query.limit, 1, 100, 50);

  const params = [convId];
  let where = ' conversation_id = $1';
  if (before !== null) {
    where += ` AND id < $${params.length + 1}`;
    params.push(before);
  }
  if (after !== null) {
    where += ` AND id > $${params.length + 1}`;
    params.push(after);
  }
  params.push(limit + 1);

  const rows = await db.query(
    `SELECT id, conversation_id, sender_id, content, kind, media_url, media_name, media_size, media_mime,
            client_msg_id, reply_to_id, created_at, edited_at, deleted_at
     FROM messages
     WHERE${where}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params
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

router.post('/group', requireAuth, async (req, res) => {
  const name = validateGroupName((req.body || {}).name);
  const rawMembers = (req.body || {}).memberIds;
  if (rawMembers !== undefined && !Array.isArray(rawMembers)) {
    throw new ApiError(400, 'BAD_REQUEST', 'memberIds يجب أن يكون مصفوفة');
  }

  const memberIds = [];
  const seen = new Set([req.user.id]);
  for (const m of rawMembers || []) {
    const id = validateId(m);
    if (!seen.has(id)) {
      seen.add(id);
      memberIds.push(id);
    }
  }
  if (memberIds.length > GROUP_MAX_MEMBERS) {
    throw new ApiError(400, 'BAD_REQUEST', `حد أقصى ${GROUP_MAX_MEMBERS} عضوًا للمجموعة`);
  }

  if (memberIds.length) {
    const ph = memberIds.map((_, i) => `$${i + 1}`).join(',');
    const rows = await db.query(`SELECT id FROM users WHERE id IN (${ph})`, memberIds);
    const found = new Set(rows.map((r) => Number(r.id)));
    for (const id of memberIds) {
      if (!found.has(id)) throw new ApiError(404, 'NOT_FOUND', 'المستخدم غير موجود');
    }
  }

  const convId = await db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const r = await tx.query(
      `INSERT INTO conversations (type, name, created_by, created_at)
       VALUES ('group', $1, $2, $3) RETURNING id`,
      [name, req.user.id, now]
    );
    const id = Number(r[0].id);
    await tx.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3)`,
      [id, req.user.id, now]
    );
    for (const userId of memberIds) {
      await tx.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
         VALUES ($1, $2, 'member', $3)`,
        [id, userId, now]
      );
    }
    return id;
  });

  res.status(201).json({ conversation: await summary(convId, req.user.id) });
});

router.get('/:id/members', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  await assertMember(convId, req.user.id);
  res.json({ members: await memberList(convId) });
});

router.post('/:id/members', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  const me = await memberRole(convId, req.user.id);
  if (me !== 'owner' && me !== 'admin') {
    throw new ApiError(403, 'FORBIDDEN', 'صلاحية مدير مطلوبة');
  }
  const userId = validateId((req.body || {}).userId);
  if (userId === req.user.id) {
    throw new ApiError(400, 'BAD_REQUEST', 'أنت عضو بالفعل');
  }
  const userExists = await db.query('SELECT id FROM users WHERE id = $1', [userId]);
  if (!userExists.length) {
    throw new ApiError(404, 'NOT_FOUND', 'المستخدم غير موجود');
  }
  const current = await db.query(
    'SELECT COUNT(*) AS c FROM conversation_members WHERE conversation_id = $1',
    [convId]
  );
  if (Number(current[0].c) >= GROUP_MAX_MEMBERS) {
    throw new ApiError(400, 'BAD_REQUEST', `حد أقصى ${GROUP_MAX_MEMBERS} عضوًا للمجموعة`);
  }
  await db.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
     VALUES ($1, $2, 'member', $3) ON CONFLICT DO NOTHING`,
    [convId, userId, new Date().toISOString()]
  );
  await emitGroupUpdate(convId, { action: 'add' });
  res.json({ ok: true, members: await memberList(convId) });
});

router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  const targetId = validateId(req.params.userId);
  const myRole = await memberRole(convId, req.user.id);
  const targetRows = await db.query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [convId, targetId]
  );
  if (!targetRows.length) throw new ApiError(404, 'NOT_FOUND', 'العضو غير موجود');
  const targetRole = targetRows[0].role;

  const isSelf = targetId === req.user.id;
  if (!isSelf && myRole !== 'owner' && myRole !== 'admin') {
    throw new ApiError(403, 'FORBIDDEN', 'صلاحية مدير مطلوبة');
  }
  if (isSelf && targetRole === 'owner') {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'لا يمكنك مغادرة المجموعة كمالك — انقل الملكية أو احذف المجموعة'
    );
  }

  await db.query(
    'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [convId, targetId]
  );

  const remaining = await db.query(
    'SELECT user_id, role, joined_at FROM conversation_members WHERE conversation_id = $1 ORDER BY joined_at',
    [convId]
  );

  if (!remaining.length) {
    await db.query('DELETE FROM conversations WHERE id = $1', [convId]);
    presence.emitToUsers(await getMembers(convId), 'conversation:deleted', { conversationId: convId });
    return res.json({ ok: true, deleted: true });
  }

  if (!remaining.some((r) => r.role === 'owner')) {
    const first = remaining[0];
    await db.query(
      'UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2',
      [convId, first.user_id, 'owner']
    );
  }

  await emitGroupUpdate(convId, { action: 'remove', userId: targetId });
  res.json({ ok: true, members: await memberList(convId) });
});

router.patch('/:id', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  await requireManageRole(convId, req.user.id);
  const name = validateGroupName((req.body || {}).name);
  await db.query('UPDATE conversations SET name = $2 WHERE id = $1', [convId, name]);
  const summary_data = await summary(convId, req.user.id);
  presence.emitToUsers(await getMembers(convId), 'conversation:renamed', {
    conversationId: convId,
    name
  });
  res.json({ conversation: summary_data });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  const myRole = await memberRole(convId, req.user.id);
  if (myRole !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'المالك فقط يمكنه حذف المجموعة');
  const members = await getMembers(convId);
  await db.query('DELETE FROM conversations WHERE id = $1', [convId]);
  presence.emitToUsers(members, 'conversation:deleted', { conversationId: convId });
  res.json({ ok: true, deleted: true });
});

router.post('/:id/transfer', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  const myRole = await memberRole(convId, req.user.id);
  if (myRole !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'المالك فقط يمكنه نقل الملكية');
  const userId = validateId((req.body || {}).userId);
  if (userId === req.user.id) {
    throw new ApiError(400, 'BAD_REQUEST', 'أنت المالك بالفعل');
  }
  const target = await db.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [convId, userId]
  );
  if (!target.length) throw new ApiError(404, 'NOT_FOUND', 'المستخدم ليس عضوًا في المجموعة');
  await db.transaction(async (tx) => {
    await tx.query(
      'UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2',
      [convId, req.user.id, 'admin']
    );
    await tx.query(
      'UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2',
      [convId, userId, 'owner']
    );
  });
  await emitGroupUpdate(convId, { action: 'transfer' });
  res.json({ ok: true, members: await memberList(convId) });
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
            ou.country AS other_country, ou.tz_ip AS other_tz_ip, ou.tz_local AS other_tz_local,
            ou.gender AS other_gender,
            cm.role AS cm_role,
            (SELECT COUNT(*) FROM conversation_members mc
              WHERE mc.conversation_id = c.id) AS member_count
     FROM conversations c
     LEFT JOIN conversation_members om ON om.conversation_id = c.id AND om.user_id <> $1
     LEFT JOIN users ou ON ou.id = om.user_id
     LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
     WHERE c.id = $2`,
    [forUserId, convId]
  );
  const row = rows[0] || { id: convId, type: 'dm' };
  const result = {
    id: Number(row.id),
    type: row.type,
    role: row.cm_role || null
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
      gender: row.other_gender || null,
      online: presence.isOnline(otherId)
    };
  } else if (row.name !== null && row.name !== undefined) {
    result.name = row.name;
    result.memberCount = Number(row.member_count || 0);
  }
  return result;
}

router.post('/:id/pin', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  await assertMember(convId, req.user.id);
  const pinned = !!(req.body || {}).pinned;
  await db.query(
    'UPDATE conversation_members SET pinned_at = $1 WHERE conversation_id = $2 AND user_id = $3',
    [pinned ? new Date().toISOString() : null, convId, req.user.id]
  );
  res.json({ pinned });
});

router.post('/:id/mute', requireAuth, async (req, res) => {
  const convId = validateId(req.params.id);
  await assertMember(convId, req.user.id);
  const raw = (req.body || {}).until;
  let until = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new ApiError(400, 'BAD_REQUEST', 'وقت الكتم غير صالح');
    }
    if (d.getTime() <= Date.now()) {
      throw new ApiError(400, 'BAD_REQUEST', 'وقت الكتم يجب أن يكون مستقبليًا');
    }
    until = d.toISOString();
  }
  await db.query(
    'UPDATE conversation_members SET muted_until = $1 WHERE conversation_id = $2 AND user_id = $3',
    [until, convId, req.user.id]
  );
  res.json({ muted: !!until, mutedUntil: until });
});

module.exports = router;