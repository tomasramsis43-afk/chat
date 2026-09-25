const { Router } = require('express');
const db = require('../db');
const presence = require('../presence');
const {
  safeUser,
  toIso,
  clampInt,
  validateId,
  escapeLike,
  ApiError
} = require('../utils');
const { requireAuth } = require('../middleware');

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const notBlocked = `id NOT IN (
    SELECT blocked_id FROM blocks WHERE blocker_id = $BY
    UNION
    SELECT blocker_id FROM blocks WHERE blocked_id = $BY
  )`;
  let rows;
  if (q) {
    rows = await db.query(
`SELECT id, username, avatar_color, avatar_url, country, tz_ip, tz_local, gender, created_at
        FROM users
        WHERE username_lower LIKE $1 ESCAPE '\\' AND id <> $2 AND deleted_at IS NULL AND ${notBlocked.replace(/\$BY/g, '$2')}
       ORDER BY username
       LIMIT $3`,
      [`%${escapeLike(q.toLowerCase())}%`, req.user.id, limit]
    );
  } else {
    rows = await db.query(
`SELECT id, username, avatar_color, avatar_url, country, tz_ip, tz_local, gender, created_at
        FROM users
        WHERE id <> $1 AND deleted_at IS NULL AND ${notBlocked.replace(/\$BY/g, '$1')}
       ORDER BY username
       LIMIT $2`,
      [req.user.id, limit]
    );
  }
  const users = rows.map((u) => ({ ...safeUser(u), online: presence.isOnline(Number(u.id)) }));
  res.json({ users });
});

router.get('/:id', requireAuth, async (req, res) => {
  const userId = validateId(req.params.id);
  const rows = await db.query(
    'SELECT id, username, avatar_color, avatar_url, country, tz_ip, tz_local, gender, created_at FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
  if (!rows.length) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'المستخدم غير موجود' } });
  }
  const user = safeUser(rows[0]);
  res.json({ user: { ...user, online: presence.isOnline(userId) } });
});

router.get('/:id/shared-conversation', requireAuth, async (req, res) => {
  const otherId = validateId(req.params.id);
  const dmKey = require('../utils').dmKey(req.user.id, otherId);
  const rows = await db.query(
    'SELECT id FROM conversations WHERE dm_key = $1',
    [dmKey]
  );
  if (!rows.length) return res.json({ conversation: null });
  const member = await db.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [rows[0].id, req.user.id]
  );
  if (!member.length) return res.json({ conversation: null });
  res.json({ conversation: { id: Number(rows[0].id) } });
});

// ===== حظر / إلغاء حظر =====

router.get('/me/blocked', requireAuth, async (req, res) => {
  const rows = await db.query(
    `SELECT u.id, u.username, u.avatar_color, u.avatar_url, u.created_at
     FROM blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
    [req.user.id]
  );
  res.json({ users: rows.map(safeUser) });
});

router.post('/:id/block', requireAuth, async (req, res) => {
  const targetId = validateId(req.params.id);
  if (targetId === req.user.id) throw new ApiError(400, 'BAD_REQUEST', 'لا يمكنك حظر نفسك');
  const now = new Date().toISOString();
  try {
    await db.query(
      'INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ($1, $2, $3)',
      [req.user.id, targetId, now]
    );
  } catch (e) {
    // متحظور بالفعل بين نفس الطرفين — عملية idempotent، نتجاهل تعارض المفتاح الأساسي
  }
  res.json({ ok: true });
});

router.delete('/:id/block', requireAuth, async (req, res) => {
  const targetId = validateId(req.params.id);
  await db.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [
    req.user.id,
    targetId
  ]);
  res.json({ ok: true });
});

// ===== بلاغات =====

const REPORT_REASONS = new Set([
  'spam',
  'harassment',
  'inappropriate_content',
  'fake_profile',
  'underage',
  'other'
]);

router.post('/:id/report', requireAuth, async (req, res) => {
  const targetId = validateId(req.params.id);
  const body = req.body || {};
  const reason = String(body.reason || '').trim();
  if (!REPORT_REASONS.has(reason)) throw new ApiError(400, 'BAD_REASON', 'سبب البلاغ غير صالح');
  const details = String(body.details || '').trim().slice(0, 1000) || null;
  const messageId = body.messageId ? validateId(body.messageId) : null;
  const conversationId = body.conversationId ? validateId(body.conversationId) : null;

  await db.query(
    `INSERT INTO reports (reporter_id, reported_user_id, message_id, conversation_id, reason, details, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)`,
    [req.user.id, targetId, messageId, conversationId, reason, details, new Date().toISOString()]
  );
  res.status(201).json({ ok: true });
});

module.exports = router;
