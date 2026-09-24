const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const config = require('./config');

let pg = null;
let sqlite = null;
const dialect = config.dbUrl ? 'postgres' : 'sqlite';

if (dialect === 'postgres') {
  pg = new Pool({
    connectionString: config.dbUrl,
    ssl: config.dbSsl !== false ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
} else {
  const file = config.dbFile ||
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

async function query(sql, params = []) {
  const { sql: t, params: p } = translate(sql, params);
  if (dialect === 'postgres') {
    const r = await pg.query(t, p);
    return r.rows;
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
  if (dialect === 'postgres') {
    await pg.end();
  } else {
    sqlite.close();
  }
}

module.exports = {
  dialect,
  isPostgres: dialect === 'postgres',
  query,
  transaction,
  close
};