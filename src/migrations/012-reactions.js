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

async function up() {
  const T = ts();
  if (!(await tableExists('message_reactions'))) {
    await db.query(`CREATE TABLE message_reactions (
      id ${pk()},
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at ${T} NOT NULL,
      UNIQUE (message_id, user_id, emoji)
    )`);
    await db.query('CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions (message_id)');
    console.log('[migrate] 012: created message_reactions');
  }
}

module.exports = { up };
