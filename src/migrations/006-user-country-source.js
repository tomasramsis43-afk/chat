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
  const ddl = 'country_source TEXT DEFAULT NULL';
  if (!have.has('country_source')) {
    await db.query(`ALTER TABLE users ADD COLUMN ${ddl}`);
    console.log('[migrate] 006: added users.country_source');
  }
}

module.exports = { up };