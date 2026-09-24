const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, closeServer } = require('./harness');

test('ops endpoints suite', async (t) => {
  const s = await startServer();
  t.after(closeServer);

  await t.test('healthz is public and reports ok', async () => {
    const res = await fetch(s.base + '/healthz');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });

  await t.test('ready verifies database connectivity', async () => {
    const res = await fetch(s.base + '/ready');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.db, true);
  });

  await t.test('metrics endpoint exposes prometheus text', async () => {
    const res = await fetch(s.base + '/metrics');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/plain/);
    const body = await res.text();
    for (const name of [
      'http_requests_total',
      'http_responses_total',
      'process_uptime_seconds',
      'db_pool_total_connections'
    ]) {
      assert.ok(body.includes(name), `expected metric ${name} in metrics output`);
    }
    assert.match(body, /http_responses_total\{status="200"\} [1-9]/);
  });

  await t.test('metrics are recorded per request', async () => {
    await fetch(s.base + '/api/auth/me');
    const res = await fetch(s.base + '/metrics');
    const body = await res.text();
    assert.match(body, /http_requests_total\{method="get"\}/);
  });
});