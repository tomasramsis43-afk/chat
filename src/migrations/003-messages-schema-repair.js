const db = require('../db');

const messageCols = [
  {
    name: 'client_msg_id',
    sqlite: 'client_msg_id TEXT',
    pg: 'client_msg_id TEXT'
  },
  {
    name: 'reply_to_id',
    sqlite: 'reply_to_id INTEGER',
    pg: 'reply_to_id INTEGER'
  },
  {
    name: 'kind',
    sqlite: "kind TEXT NOT NULL DEFAULT 'text'",
    pg: "kind TEXT NOT NULL DEFAULT 'text'"
  },
  {
    name: 'created_at',
    sqlite: 'created_at TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\'))',
    pg: 'created_at TIMESTAMPTZ NOT NULL DEFAULT now()'
  },
  {
    name: 'edited_at',
    sqlite: 'edited_at TEXT',
    pg: 'edited_at TIMESTAMPTZ'
  },
  {
    name: 'deleted_at',
    sqlite: 'deleted_at TEXT',
    pg: 'deleted_at TIMESTAMPTZ'
  }
];

async function up() {
  if (db.isPostgres) {
    const rows = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'messages'`
    );
    const have = new Set(rows.map((r) => r.column_name));
    for (const col of messageCols) {
      if (have.has(col.name)) continue;
      await db.query(`ALTER TABLE messages ADD COLUMN ${col.pg}`);
      console.log(`[migrate] 003: added messages.${col.name}`);
    }
  } else {
    const rows = await db.query('PRAGMA table_info(messages)');
    const have = new Set(rows.map((r) => r.name));
    for (const col of messageCols) {
      if (have.has(col.name)) continue;
      await db.query(`ALTER TABLE messages ADD COLUMN ${col.sqlite}`);
      console.log(`[migrate] 003: added messages.${col.name}`);
    }
  }
}

module.exports = { up };