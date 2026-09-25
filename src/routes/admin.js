'use strict';
const { Router } = require('express');
const db = require('../db');
const presence = require('../presence');
const {
  ApiError,
  safeUser,
  mapMessage,
  clampInt,
  validateId,
  validateNonnegInt,
  escapeLike
} = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');

const router = Router();
router.use(requireAuth, requireAdmin);

async function logAction(adminId, action, targetType, targetId, meta) {
  await db.query(
    `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, meta, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminId, action, targetType, targetId || null, meta ? JSON.stringify(meta) : null, new Date().toISOString()]
  );
}

// ===== لوحة عامة =====
router.get('/stats', async (req, res) => {
  const [users, online, guests, banned, openReports, admins] = await Promise.all([
    db.query('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL'),
    Promise.resolve({ n: presence.count() }),
    db.query('SELECT COUNT(*) AS n FROM users WHERE is_guest = TRUE AND deleted_at IS NULL'),
    db.query('SELECT COUNT(*) AS n FROM users WHERE banned_at IS NOT NULL'),
    db.query("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
    db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
  ]);
  res.json({
    totalUsers: Number(users[0].n),
    online: Number(online.n),
    guests: Number(guests[0].n),
    banned: Number(banned[0].n),
    openReports: Number(openReports[0].n),
    admins: Number(admins[0].n)
  });
});

// ===== المستخدمين =====
router.get('/users', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const cursor = req.query.cursor !== undefined ? validateNonnegInt(req.query.cursor) : null;
  const params = [];
  let where = 'deleted_at IS NULL';
  if (q) {
    params.push(`%${escapeLike(q.toLowerCase())}%`);
    where += ` AND username_lower LIKE $${params.length} ESCAPE '\\'`;
  }
  if (cursor !== null) {
    params.push(cursor);
    where += ` AND id < $${params.length}`;
  }
  params.push(limit + 1);
  const rows = await db.query(
    `SELECT id, username, avatar_color, avatar_url, gender, role, is_guest, banned_at, banned_reason, created_at, last_seen_at
     FROM users WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const users = page.map((u) => ({
    ...safeUser(u),
    is_guest: !!u.is_guest,
    banned_at: u.banned_at || null,
    banned_reason: u.banned_reason || null,
    online: presence.isOnline(Number(u.id))
  }));
  res.json({ users, nextCursor: hasMore ? Number(page[page.length - 1].id) : null });
});

router.post('/users/:id/ban', async (req, res) => {
  const targetId = validateId(req.params.id);
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500) || null;
  const rows = await db.query('SELECT role FROM users WHERE id = $1', [targetId]);
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'المستخدم غير موجود');
  if (rows[0].role === 'admin') throw new ApiError(400, 'BAD_REQUEST', 'لا يمكن حظر أدمن آخر');
  await db.query('UPDATE users SET banned_at = $2, banned_reason = $3 WHERE id = $1', [
    targetId,
    new Date().toISOString(),
    reason
  ]);
  presence.disconnectUser(targetId);
  await logAction(req.user.id, 'ban_user', 'user', targetId, { reason });
  res.json({ ok: true });
});

router.post('/users/:id/unban', async (req, res) => {
  const targetId = validateId(req.params.id);
  await db.query('UPDATE users SET banned_at = NULL, banned_reason = NULL WHERE id = $1', [targetId]);
  await logAction(req.user.id, 'unban_user', 'user', targetId, null);
  res.json({ ok: true });
});

router.post('/users/:id/promote', async (req, res) => {
  const targetId = validateId(req.params.id);
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [targetId]);
  await logAction(req.user.id, 'promote_admin', 'user', targetId, null);
  res.json({ ok: true });
});

router.post('/users/:id/demote', async (req, res) => {
  const targetId = validateId(req.params.id);
  if (targetId === req.user.id) throw new ApiError(400, 'BAD_REQUEST', 'لا يمكنك تنزيل نفسك');
  await db.query("UPDATE users SET role = 'user' WHERE id = $1", [targetId]);
  await logAction(req.user.id, 'demote_admin', 'user', targetId, null);
  res.json({ ok: true });
});

// ===== البلاغات =====
router.get('/reports', async (req, res) => {
  const status = ['open', 'reviewing', 'resolved', 'dismissed'].includes(req.query.status)
    ? req.query.status
    : 'open';
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const rows = await db.query(
    `SELECT r.id, r.reason, r.details, r.status, r.created_at, r.resolved_at,
            r.message_id, r.conversation_id,
            reporter.id AS reporter_id, reporter.username AS reporter_username,
            target.id AS target_id, target.username AS target_username, target.banned_at AS target_banned_at
     FROM reports r
     JOIN users reporter ON reporter.id = r.reporter_id
     JOIN users target ON target.id = r.reported_user_id
     WHERE r.status = $1
     ORDER BY r.created_at DESC
     LIMIT $2`,
    [status, limit]
  );
  const reports = rows.map((r) => ({
    id: Number(r.id),
    reason: r.reason,
    details: r.details || null,
    status: r.status,
    created_at: r.created_at,
    resolved_at: r.resolved_at || null,
    message_id: r.message_id ? Number(r.message_id) : null,
    conversation_id: r.conversation_id ? Number(r.conversation_id) : null,
    reporter: { id: Number(r.reporter_id), username: r.reporter_username },
    target: {
      id: Number(r.target_id),
      username: r.target_username,
      banned: !!r.target_banned_at
    }
  }));
  res.json({ reports });
});

router.post('/reports/:id/resolve', async (req, res) => {
  const reportId = validateId(req.params.id);
  const status = String((req.body || {}).status || 'resolved');
  if (!['resolved', 'dismissed', 'reviewing'].includes(status)) {
    throw new ApiError(400, 'BAD_REQUEST', 'حالة غير صالحة');
  }
  const resolvedAt = status === 'reviewing' ? null : new Date().toISOString();
  await db.query(
    'UPDATE reports SET status = $2, resolved_at = $3, resolved_by = $4 WHERE id = $1',
    [reportId, status, resolvedAt, req.user.id]
  );
  await logAction(req.user.id, 'resolve_report', 'report', reportId, { status });
  res.json({ ok: true });
});

// ===== المحادثات (للإشراف — كل فتح بيتسجل في سجل التدقيق) =====
router.get('/conversations', async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 100, 30);
  const cursor = req.query.cursor !== undefined ? validateNonnegInt(req.query.cursor) : null;
  const params = [];
  let where = '1=1';
  if (cursor !== null) {
    params.push(cursor);
    where += ` AND c.id < $${params.length}`;
  }
  params.push(limit + 1);
  const rows = await db.query(
    `SELECT c.id, c.type, c.name, c.last_message_at, c.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT json_agg_or_list) AS members_placeholder
     FROM conversations c
     WHERE ${where}
     ORDER BY c.id DESC
     LIMIT $${params.length}`.replace(', \n            (SELECT json_agg_or_list) AS members_placeholder', ''),
    params
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ids = page.map((c) => Number(c.id));
  let membersByConv = new Map();
  if (ids.length) {
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    const memberRows = await db.query(
      `SELECT cm.conversation_id, u.id, u.username
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id IN (${ph})`,
      ids
    );
    for (const m of memberRows) {
      const cid = Number(m.conversation_id);
      if (!membersByConv.has(cid)) membersByConv.set(cid, []);
      membersByConv.get(cid).push({ id: Number(m.id), username: m.username });
    }
  }
  const conversations = page.map((c) => ({
    id: Number(c.id),
    type: c.type,
    name: c.name || null,
    last_message_at: c.last_message_at || null,
    created_at: c.created_at,
    message_count: Number(c.message_count),
    members: membersByConv.get(Number(c.id)) || []
  }));
  res.json({ conversations, nextCursor: hasMore ? Number(page[page.length - 1].id) : null });
});

router.get('/conversations/:id/messages', async (req, res) => {
  const convId = validateId(req.params.id);
  const before = req.query.before !== undefined ? validateNonnegInt(req.query.before) : null;
  const limit = clampInt(req.query.limit, 1, 200, 100);

  const params = [convId];
  let where = ' conversation_id = $1';
  if (before !== null) {
    where += ` AND id < $${params.length + 1}`;
    params.push(before);
  }
  params.push(limit + 1);

  const rows = await db.query(
    `SELECT id, conversation_id, sender_id, content, kind, media_url, media_name, media_size, media_mime,
            reply_to_id, created_at, edited_at, deleted_at
     FROM messages WHERE${where} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const messages = page.slice().reverse().map(mapMessage);

  // سجل تدقيق: كل مرة أدمن يفتح فيها رسائل محادثة بيتسجل هنا (وقت، أدمن، محادثة)
  await logAction(req.user.id, 'view_conversation_messages', 'conversation', convId, { count: messages.length });

  res.json({ messages, nextBefore: hasMore ? Number(rows[limit - 1].id) : null });
});

// ===== سجل التدقيق =====
router.get('/audit-log', async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 100);
  const rows = await db.query(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.meta, a.created_at, u.username AS admin_username
     FROM admin_audit_log a JOIN users u ON u.id = a.admin_id
     ORDER BY a.id DESC LIMIT $1`,
    [limit]
  );
  res.json({
    entries: rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      target_type: r.target_type,
      target_id: r.target_id ? Number(r.target_id) : null,
      meta: r.meta ? JSON.parse(r.meta) : null,
      created_at: r.created_at,
      admin: r.admin_username
    }))
  });
});

module.exports = router;
