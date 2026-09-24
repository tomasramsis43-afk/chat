const db = require('../db');

async function up() {
  if (db.isPostgres) {
    const rows = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`
    );
    const have = new Set(rows.map((r) => r.column_name));
    if (!have.has('country')) {
      await db.query('ALTER TABLE users ADD COLUMN country TEXT');
      console.log('[migrate] 004: added users.country');
    }
  } else {
    const rows = await db.query('PRAGMA table_info(users)');
    const have = new Set(rows.map((r) => r.name));
    if (!have.has('country')) {
      await db.query('ALTER TABLE users ADD COLUMN country TEXT');
      console.log('[migrate] 004: added users.country');
    }
  }
}

module.exports = { up };