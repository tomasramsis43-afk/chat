const db = require('../db');

const ts = () => (db.isPostgres ? 'TIMESTAMPTZ' : 'TEXT');
const pk = () => (db.isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT');

async function tableExists(name) {
  if (db.isPostgres) {
    const r = await db.query('SELECT to_regclass($1) AS t', [name]);
    return !!r[0] && r[0].t !== null;
  }
  const r = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=$1", [name]);
  return r.length > 0;
}

async function userColumns() {
  if (db.isPostgres) {
    const rows = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`);
    return new Set(rows.map((r) => r.column_name));
  }
  const rows = await db.query('PRAGMA table_info(users)');
  return new Set(rows.map((r) => r.name));
}

async function index(def) {
  await db.query(`CREATE INDEX IF NOT EXISTS ${def}`);
}

async function up() {
  const T = ts();

  // 1) users.role — 'user' | 'admin'. أول مستخدم مسجّل يترقّى تلقائيًا لـ admin لو مفيش أدمن أصلاً (bootstrap).
  const have = await userColumns();
  if (!have.has('role')) {
    await db.query(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
    console.log('[migrate] 011: added users.role');
  }
  if (!have.has('banned_at')) {
    await db.query(`ALTER TABLE users ADD COLUMN banned_at ${T}`);
    console.log('[migrate] 011: added users.banned_at');
  }
  if (!have.has('banned_reason')) {
    await db.query(`ALTER TABLE users ADD COLUMN banned_reason TEXT`);
    console.log('[migrate] 011: added users.banned_reason');
  }

  // 2) blocks — حظر مستخدم لمستخدم (يمنع الرسائل والظهور في البحث بينهم)
  if (!(await tableExists('blocks'))) {
    await db.query(`CREATE TABLE blocks (
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at ${T} NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id)
    )`);
    await index('idx_blocks_blocked ON blocks (blocked_id)');
    console.log('[migrate] 011: created blocks');
  }

  // 3) reports — بلاغات المستخدمين عن رسائل/حسابات
  if (!(await tableExists('reports'))) {
    await db.query(`CREATE TABLE reports (
      id ${pk()},
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reported_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id INTEGER,
      conversation_id INTEGER,
      reason TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
      created_at ${T} NOT NULL,
      resolved_at ${T},
      resolved_by INTEGER
    )`);
    await index('idx_reports_status ON reports (status, created_at)');
    await index('idx_reports_reported ON reports (reported_user_id)');
    console.log('[migrate] 011: created reports');
  }

  // 4) admin_audit_log — كل فتح لمحادثة أو إجراء إداري (حظر/حل بلاغ) بيتسجل هنا، عشان الشفافية والمساءلة
  if (!(await tableExists('admin_audit_log'))) {
    await db.query(`CREATE TABLE admin_audit_log (
      id ${pk()},
      admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER,
      meta TEXT,
      created_at ${T} NOT NULL
    )`);
    await index('idx_audit_admin ON admin_audit_log (admin_id, created_at)');
    await index('idx_audit_target ON admin_audit_log (target_type, target_id)');
    console.log('[migrate] 011: created admin_audit_log');
  }
}

module.exports = { up };
