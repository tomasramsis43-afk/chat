const db = require('../db');

module.exports = {
  version: 2,
  name: 'google-auth',
  async up() {
    return await db.transaction(async (tx) => {
      const cols = async (table) => {
        if (db.isPostgres) {
          const r = await tx.query(
            'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
            [table]
          );
          return new Set(r.map((x) => x.column_name));
        }
        const r = await tx.query(`PRAGMA table_info("${table}")`, []);
        return new Set(r.map((x) => x.name));
      };

      const users = await cols('users');
      if (!users.has('email')) {
        await tx.query('ALTER TABLE users ADD COLUMN email TEXT');
      }
      if (!users.has('google_sub')) {
        await tx.query('ALTER TABLE users ADD COLUMN google_sub TEXT');
      }

      await tx.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (email)'
      );
      await tx.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_sub ON users (google_sub)'
      );
    });
  }
};