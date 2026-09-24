const db = require('../db');

const cols = [
  { name: 'pinned_at', sqlite: 'pinned_at TEXT', pg: 'pinned_at TIMESTAMPTZ' }
];

async function up() {
  let have;
  if (db.isPostgres) {
    const rows = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversation_members'`
    );
    have = new Set(rows.map((r) => r.column_name));
  } else {
    const rows = await db.query('PRAGMA table_info(conversation_members)');
    have = new Set(rows.map((r) => r.name));
  }
  for (const col of cols) {
    if (have.has(col.name)) continue;
    const ddl = db.isPostgres ? col.pg : col.sqlite;
    await db.query(`ALTER TABLE conversation_members ADD COLUMN ${ddl}`);
    console.log(`[migrate] 008: added conversation_members.${col.name}`);
  }
}

module.exports = { up };