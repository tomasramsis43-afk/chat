process.env.PORT = '0';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChatServer } = require('../server');

test('boots via createChatServer and shuts down gracefully', async () => {
  const handle = await createChatServer();
  const port = handle.server.address().port;
  assert.ok(port > 0);

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);

  await handle.shutdown();
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) }),
    /fetch failed|ECONNREFUSED/
  );
});