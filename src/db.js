'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

let pg = null;
let sqlite = null;
const dialect = config.dbUrl ? 'postgres' : 'sqlite';

if (dialect === 'postgres') {
  const { Pool } = require('pg');
  const poolOpts = {
    connectionString: config.dbUrl,
    ssl: config.dbSsl,
    max: config.pg.max,
    idleTimeoutMillis: config.pg.idleTimeoutMillis,
    connectionTimeoutMillis: config.pg.connectionTimeoutMillis
  };
  if (config.pg.statementTimeoutMs > 0) poolOpts.statement_timeout = config.pg.statementTimeoutMs;
  pg = new Pool(poolOpts);
  // بدون هذا المُستمع، أي خطأ على اتصال خامل في الـ pool يقتل العملية.
  pg.on('error', (err) => {
    logger.error('postgres pool idle client error', { code: err && err.code, message: err && err.message });
  });
} else {
  // node:sqlite يُحمَّل فقط عند استخدام SQLite حتى يبقى PostgreSQL Production متوافقًا مع Node 20.
  const { DatabaseSync } = require('node:sqlite');
  const file =
    config.dbFile ||
    (config.isTest ? ':memory:' : path.join(__dirname, '..', 'data', 'chat.db'));
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA synchronous = NORMAL;');
}

function translate(sql, params) {
  if (dialect === 'postgres') return { sql, params };
  if (!sql.includes('$')) return { sql, params };
  const order = [];
  const translated = sql.replace(/\$(\d+)/g, (m, num) => {
    order.push(Number(num));
    return '?';
  });
  return { sql: translated, params: order.map((n) => params[n - 1]) };
}

function truncate(sql) {
  const s = String(sql || '');
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

async function query(sql, params = []) {
  const { sql: t, params: p } = translate(sql, params);
  if (dialect === 'postgres') {
    try {
      const r = await pg.query(t, p);
      return r.rows;
    } catch (err) {
      logger.debug('postgres query error', { sql: truncate(t), code: err && err.code, message: err && err.message });
      throw err;
    }
  }
  const stmt = sqlite.prepare(t);
  return stmt.all(...p);
}

async function transaction(fn) {
  if (dialect === 'postgres') {
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        async query(sql, params = []) {
          const r = await client.query(sql, params);
          return r.rows;
        },
        async run(sql, params = []) {
          const r = await client.query(sql, params);
          return { changes: r.rowCount || 0 };
        }
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  }
  sqlite.exec('BEGIN');
  try {
    const tx = {
      async query(s, params = []) {
        const { sql: t, params: p } = translate(s, params);
        const stmt = sqlite.prepare(t);
        return stmt.all(...p);
      },
      async run(s, params = []) {
        const { sql: t, params: p } = translate(s, params);
        const stmt = sqlite.prepare(t);
        const info = stmt.run(...p);
        return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
      }
    };
    const result = await fn(tx);
    sqlite.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

async function close() {
  try {
    if (dialect === 'postgres') {
      if (pg) await pg.end();
    } else if (sqlite) {
      sqlite.close();
      sqlite = null;
    }
  } catch (err) {
    logger.warn('db close error', { message: err && err.message });
  }
}

function setForeignKeys(enabled) {
  if (dialect === 'sqlite' && sqlite) {
    sqlite.exec(enabled ? 'PRAGMA foreign_keys = ON;' : 'PRAGMA foreign_keys = OFF;');
  }
}

function poolStatus() {
  if (dialect === 'postgres' && pg) {
    return { total: pg.totalCount, idle: pg.idleCount, waiting: pg.waitingCount };
  }
  if (dialect === 'sqlite') {
    return { total: 1, idle: 1, waiting: 0 };
  }
  return null;
}

module.exports = {
  dialect,
  isPostgres: dialect === 'postgres',
  query,
  transaction,
  setForeignKeys,
  poolStatus,
  close
};