'use strict';
// ترقية مستخدم موجود لـ admin بدون الحاجة يسجّل من جديد.
// الاستخدام: node scripts/promote-admin.js <username>
// لازم DATABASE_URL (أو DB_FILE) يكونوا مضبوطين زي ما السيرفر شغال بيهم.
const db = require('../src/db');

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('الاستخدام: node scripts/promote-admin.js <username>');
    process.exit(1);
  }
  const rows = await db.query('SELECT id, username, role FROM users WHERE username_lower = $1', [
    username.toLowerCase()
  ]);
  if (!rows.length) {
    console.error(`مفيش مستخدم بالاسم: ${username}`);
    process.exit(1);
  }
  if (rows[0].role === 'admin') {
    console.log(`${rows[0].username} أدمن بالفعل.`);
    process.exit(0);
  }
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [rows[0].id]);
  console.log(`تمت ترقية ${rows[0].username} إلى admin.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
