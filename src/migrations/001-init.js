const fs = require('fs');
const path = require('path');
const db = require('../db');

const ts = () => (db.isPostgres ? 'TIMESTAMPTZ' : 'TEXT');
const pk = () => (db.isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT');

async function tableExists(tx, name) {
  if (db.isPostgres) {
    const r = await tx.query('SELECT to_regclass($1) AS t', [name]);
    return !!r[0] && r[0].t !== null;
  }
  const r = await tx.query("SELECT name FROM sqlite_master WHERE type='table' AND name=$1", [name]);
  return r.length > 0;
}

async function tableColumns(tx, name) {
  if (db.isPostgres) {
    const r = await tx.query(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
      [name]
    );
    return new Set(r.map((x) => x.column_name));
  }
  const r = await tx.query(`PRAGMA table_info("${name}")`, []);
  return new Set(r.map((x) => x.name));
}

module.exports = {
  version: 1,
  name: 'init-schema',
  async up() {
    const T = ts();
    return db.transaction(async (tx) => {
      const legacy = await hasLegacyMessages(tx);
      if (legacy) {
        await upgradeLegacy(tx);
      }

      await ensureSchema(tx);

      const applied = (
        await tx.query('SELECT version FROM schema_migrations')
      ).map((r) => Number(r.version));
      if (!applied.includes(1)) {
        await tx.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
          [1, 'init-schema', new Date().toISOString()]
        );
      }
    });
  }
};

async function hasLegacyMessages(tx) {
  if (!(await tableExists(tx, 'messages'))) return false;
  const cols = await tableColumns(tx, 'messages');
  return cols.has('receiver_id') && !cols.has('conversation_id');
}

async function ensureSchema(tx) {
  const T = ts();

  await tx.query(`CREATE TABLE IF NOT EXISTS users (
    id ${pk()},
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#6C5CE7',
    avatar_url TEXT,
    created_at ${T} NOT NULL,
    last_seen_at ${T}
  )`);

  await tx.query(`CREATE TABLE IF NOT EXISTS conversations (
    id ${pk()},
    type TEXT NOT NULL CHECK (type IN ('dm', 'group')),
    dm_key TEXT UNIQUE,
    name TEXT,
    created_by INTEGER,
    last_message_id INTEGER,
    last_message_at ${T},
    created_at ${T} NOT NULL,
    updated_at ${T}
  )`);

  await tx.query(`CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    joined_at ${T} NOT NULL,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    muted_until ${T},
    archived_at ${T},
    PRIMARY KEY (conversation_id, user_id)
  )`);

  await tx.query(`CREATE TABLE IF NOT EXISTS messages (
    id ${pk()},
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    client_msg_id TEXT,
    reply_to_id INTEGER,
    created_at ${T} NOT NULL,
    edited_at ${T},
    deleted_at ${T},
    UNIQUE (conversation_id, client_msg_id)
  )`);

  await tx.query(`CREATE TABLE IF NOT EXISTS sessions (
    id ${pk()},
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at ${T} NOT NULL,
    expires_at ${T} NOT NULL,
    revoked_at ${T}
  )`);

  await index(tx, 'idx_messages_conv ON messages (conversation_id, id)');
  await index(tx, 'idx_messages_sender ON messages (sender_id, id)');
  await index(tx, 'idx_cm_user ON conversation_members (user_id, conversation_id)');
  await index(tx, 'idx_sessions_user ON sessions (user_id)');
  await index(tx, 'idx_sessions_expires ON sessions (expires_at)');
  await index(tx, 'idx_conversations_last ON conversations (last_message_at)');
}

async function index(tx, def) {
  await tx.query(`CREATE INDEX IF NOT EXISTS ${def}`);
}

async function upgradeLegacy(tx) {
  const T = ts();
  const now = new Date().toISOString();

  const legacyUsers = await tx.query('SELECT * FROM users');
  await tx.query(`DROP TABLE IF EXISTS users_new`);
  await tx.query(`CREATE TABLE users_new (
    id ${pk()},
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#6C5CE7',
    avatar_url TEXT,
    created_at ${T} NOT NULL,
    last_seen_at ${T}
  )`);

  for (const u of legacyUsers) {
    const ucols = await tableColumns(tx, 'users');
    await tx.query(
      `INSERT INTO users_new (id, username, username_lower, password_hash, avatar_color, avatar_url, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        u.id,
        u.username,
        String(u.username).toLowerCase(),
        u.password || u.password_hash,
        u.avatar_color || '#6C5CE7',
        ucols.has('avatar_url') ? u.avatar_url : null,
        u.created_at || now,
        ucols.has('last_seen') ? u.last_seen : null
      ]
    );
  }

  await tx.query(`DROP TABLE IF EXISTS conversations_new`);
  await tx.query(`CREATE TABLE conversations_new (
    id ${pk()},
    type TEXT NOT NULL CHECK (type IN ('dm', 'group')),
    dm_key TEXT UNIQUE,
    name TEXT,
    created_by INTEGER,
    last_message_id INTEGER,
    last_message_at ${T},
    created_at ${T} NOT NULL,
    updated_at ${T}
  )`);

  await tx.query(`DROP TABLE IF EXISTS conversation_members_new`);
  await tx.query(`CREATE TABLE conversation_members_new (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    joined_at ${T} NOT NULL,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    muted_until ${T},
    archived_at ${T},
    PRIMARY KEY (conversation_id, user_id)
  )`);

  await tx.query(`DROP TABLE IF EXISTS messages_new`);
  await tx.query(`CREATE TABLE messages_new (
    id ${pk()},
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    client_msg_id TEXT,
    reply_to_id INTEGER,
    created_at ${T} NOT NULL,
    edited_at ${T},
    deleted_at ${T},
    UNIQUE (conversation_id, client_msg_id)
  )`);

  const legacyMessages = await tx.query('SELECT * FROM messages');
  const convByKey = new Map();
  const readMax = new Map();
  let convMax = 0;

  for (const m of legacyMessages) {
    const a = Number(m.sender_id);
    const b = Number(m.receiver_id);
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!convByKey.has(key)) {
      const r = await tx.query(
        `INSERT INTO conversations_new (type, dm_key, created_by, created_at)
         VALUES ('dm', $1, $2, $3) RETURNING id`,
        [key, a, now]
      );
      const convId = Number(r[0].id);
      convByKey.set(key, convId);
      await tx.query(
        `INSERT INTO conversation_members_new (conversation_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', $3)`,
        [convId, a, now]
      );
      await tx.query(
        `INSERT INTO conversation_members_new (conversation_id, user_id, role, joined_at)
         VALUES ($1, $2, 'member', $3)`,
        [convId, b, now]
      );
    }
    const convId = convByKey.get(key);
    const isRead = Number(m.is_read || 0) === 1;
    await tx.query(
      `INSERT INTO messages_new (id, conversation_id, sender_id, content, kind, created_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        Number(m.id),
        convId,
        a,
        m.content || '',
        m.kind || 'text',
        m.created_at || now,
        Number(m.is_deleted || 0) === 1 ? m.created_at || now : null
      ]
    );
    if (isRead) {
      readMax.set(b, Math.max(readMax.get(b) || 0, Number(m.id)));
    }
    if (Number(m.id) > convMax) convMax = Number(m.id);
  }

  for (const [userId, lastId] of readMax) {
    await tx.query(
      `UPDATE conversation_members_new SET last_read_message_id = $1
       WHERE user_id = $2 AND last_read_message_id < $1`,
      [lastId, userId]
    );
  }

  if (convMax > 0) {
    const lastRows = await tx.query(
      `SELECT m.conversation_id, MAX(m.id) AS max_id
       FROM messages_new m GROUP BY m.conversation_id`
    );
    for (const row of lastRows) {
      const meta = await tx.query(
        `SELECT created_at FROM messages_new WHERE id = $1`,
        [Number(row.max_id)]
      );
      await tx.query(
        `UPDATE conversations_new SET last_message_id = $1, last_message_at = $2 WHERE id = $3`,
        [Number(row.max_id), meta[0].created_at, Number(row.conversation_id)]
      );
    }
  }

  await tx.query('DROP TABLE IF EXISTS room_messages');
  await tx.query('DROP TABLE IF EXISTS room_members');
  await tx.query('DROP TABLE IF EXISTS rooms');
  await tx.query('DROP TABLE IF EXISTS messages');
  await tx.query('DROP TABLE IF EXISTS conversations');
  await tx.query('DROP TABLE IF EXISTS conversation_members');
  await tx.query('DROP TABLE IF EXISTS users');

  await tx.query('ALTER TABLE users_new RENAME TO users');
  await tx.query('ALTER TABLE conversations_new RENAME TO conversations');
  await tx.query('ALTER TABLE conversation_members_new RENAME TO conversation_members');
  await tx.query('ALTER TABLE messages_new RENAME TO messages');
}