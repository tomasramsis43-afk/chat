const { ensureMigrated } = require('./src/migrate');
const { createServer } = require('./src/app');
const config = require('./src/config');
const db = require('./src/db');

async function main() {
  await ensureMigrated();

  const { server } = createServer();
  server.listen(config.port, () => {
    console.log(`[salem] running on :${config.port} (${config.nodeEnv})`);
  });

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`[salem] ${signal} — shutting down`);
    try {
      await db.close();
    } catch (err) {
      console.error('[salem] error while closing', err);
    } finally {
      process.exit(0);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    console.error('[salem] unhandledRejection', err);
  });
}

main().catch((err) => {
  console.error('[salem] فشل التشغيل:', err);
  process.exit(1);
});