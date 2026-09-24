'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');
const logger = require('./logger');

// قيمة ثابتة تُستخدم لقفل الـ migrations عبر أكثر من خادم على نفس PostgreSQL.
const MIGRATION_LOCK_KEY = 1396963397; // "SALE"

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

  const pending = files.filter((file) => !applied.has(Number.parseInt(file, 10)));

  const runPending = async () => {
    for (const file of pending) {
      const migration = require(path.join(dir, file));
      await migration.up();
      const version = Number.parseInt(file, 10);
      // بعض الـ migrations تسجل نفسها (001). نتجنب duplicate key.
      try {
        await db.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
          [version, file, new Date().toISOString()]
        );
      } catch (err) {
        // 001 يسجّل نفسه داخل up()؛ نتجاهل التكرار في كلا الـ dialects.
        if (!(err && (err.code === '23505' || String(err.message).includes('UNIQUE')))) throw err;
      }
      logger.info(`migration applied: ${file}`);
    }
  };

  if (db.isPostgres && pending.length) {
    // قفل على مستوى الخادم لمنع تشغيل migration من أكثر من instance في آنٍ واحد.
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await runPending();
    });
  } else {
    await runPending();
  }
}

module.exports = { ensureMigrated, MIGRATION_LOCK_KEY };