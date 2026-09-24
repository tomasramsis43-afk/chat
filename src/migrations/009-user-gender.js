const db = require('../db');

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
  if (have.has('gender')) {
    console.log('[migrate] 009: users.gender already present');
    return;
  }
  await db.query('ALTER TABLE users ADD COLUMN gender TEXT');
  console.log('[migrate] 009: added users.gender');
}

module.exports = { up };