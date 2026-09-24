const { Router } = require('express');
const db = require('../db');
const presence = require('../presence');
const {
  safeUser,
  toIso,
  clampInt,
  validateId,
  escapeLike
} = require('../utils');
const { requireAuth } = require('../middleware');

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = clampInt(req.query.limit, 1, 100, 50);
  let rows;
  if (q) {
    rows = await db.query(
`SELECT id, username, avatar_color, avatar_url, country, tz_ip, tz_local, gender, created_at
        FROM users
        WHERE username_lower LIKE $1 ESCAPE '\\' AND id <> $2 AND deleted_at IS NULL
       ORDER BY username
       LIMIT $3`,
      [`%${escapeLike(q.toLowerCase())}%`, req.user.id, limit]
    );
  } else {
    rows = await db.query(
`SELECT id, username, avatar_color, avatar_url, country, tz_ip, tz_local, gender, created_at
        FROM users
        WHERE id <> $1 AND deleted_at IS NULL
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

module.exports = router;