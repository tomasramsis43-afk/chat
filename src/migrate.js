const fs = require('fs');
const path = require('path');
const db = require('./db');

async function ensureMigrated() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+[-_.].+\.js$/.test(f))
    .sort();

  const ts = (c) => (c.isPostgres ? 'TIMESTAMPTZ' : 'TEXT');
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at ${ts(db)} NOT NULL
    )`
  );

  const applied = new Set(
    (await db.query('SELECT version FROM schema_migrations')).map((r) => Number(r.version))
  );

  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (applied.has(version)) continue;
    const migration = require(path.join(dir, file));
    await migration.up();
    applied.add(version);
    console.log(`[migrate] applied ${file}`);
  }
}

module.exports = { ensureMigrated };