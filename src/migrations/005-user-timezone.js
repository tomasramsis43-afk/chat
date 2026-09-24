const db = require('../db');

const cols = [
  { name: 'tz_ip', sqlite: 'tz_ip TEXT', pg: 'tz_ip TEXT' },
  { name: 'tz_local', sqlite: 'tz_local TEXT', pg: 'tz_local TEXT' }
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
    console.log(`[migrate] 005: added users.${col.name}`);
  }
}

module.exports = { up };