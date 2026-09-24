const db = require('../db');

const cols = [
  { name: 'is_guest', sqlite: 'is_guest INTEGER NOT NULL DEFAULT 0', pg: 'is_guest BOOLEAN NOT NULL DEFAULT FALSE' },
  { name: 'deleted_at', sqlite: 'deleted_at TEXT', pg: 'deleted_at TIMESTAMPTZ' }
];

async function up() {
  let have;
  if (db.isPostgres) {
    const rows = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`
    );
    have = new Set(rows.map((r) => r.column_name));
  } else {
    const rows = await db.query('PRAGMA table_info(users)');
    have = new Set(rows.map((r) => r.name));
  }
  for (const col of cols) {
    if (have.has(col.name)) continue;
    const ddl = db.isPostgres ? col.pg : col.sqlite;
    await db.query(`ALTER TABLE users ADD COLUMN ${ddl}`);
    console.log(`[migrate] 010: added users.${col.name}`);
  }
}

module.exports = { up };