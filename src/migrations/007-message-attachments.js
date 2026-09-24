const db = require('../db');

const messageCols = [
  { name: 'media_url', sqlite: 'media_url TEXT', pg: 'media_url TEXT' },
  { name: 'media_name', sqlite: 'media_name TEXT', pg: 'media_name TEXT' },
  { name: 'media_size', sqlite: 'media_size INTEGER', pg: 'media_size INTEGER' },
  { name: 'media_mime', sqlite: 'media_mime TEXT', pg: 'media_mime TEXT' }
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
      console.log(`[migrate] 007: added messages.${col.name}`);
    }
  } else {
    const rows = await db.query('PRAGMA table_info(messages)');
    const have = new Set(rows.map((r) => r.name));
    for (const col of messageCols) {
      if (have.has(col.name)) continue;
      await db.query(`ALTER TABLE messages ADD COLUMN ${col.sqlite}`);
      console.log(`[migrate] 007: added messages.${col.name}`);
    }
  }
}

module.exports = { up };