const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer,
  closeServer,
  api,
  registerUser,
  openDm
} = require('./harness');

test('pin & mute suite', async (t) => {
  const s = await startServer();
  t.after(closeServer);

  const ali = await registerUser('pm_ali');
  const sara = await registerUser('pm_sara');
  const mono = await registerUser('pm_mono');

  const dm = await openDm(ali, sara.user.id);
  assert.equal(dm.status, 201);
  const convId = dm.data.conversation.id;

  async function listFor(user) {
    const r = await api('GET', '/api/conversations', { cookies: user.cookies });
    assert.equal(r.status, 200);
    return r.data.conversations.find((c) => c.id === convId);
  }

  await t.test('pin and unpin persist per user', async () => {
    const pin = await api('POST', `/api/conversations/${convId}/pin`, {
      cookies: ali.cookies,
      body: { pinned: true }
    });
    assert.equal(pin.status, 200);
    assert.equal(pin.data.pinned, true);

    let conv = await listFor(ali);
    assert.equal(conv.pinned, true);
    const saraView = await listFor(sara);
    assert.equal(saraView.pinned, false);

    const unpin = await api('POST', `/api/conversations/${convId}/pin`, {
      cookies: ali.cookies,
      body: { pinned: false }
    });
    assert.equal(unpin.data.pinned, false);
    conv = await listFor(ali);
    assert.equal(conv.pinned, false);
  });

  await t.test('mute with future until persists', async () => {
    const until = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    const r = await api('POST', `/api/conversations/${convId}/mute`, {
      cookies: ali.cookies,
      body: { until }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.muted, true);
    assert.equal(r.data.mutedUntil, until);

    const conv = await listFor(ali);
    assert.equal(conv.muted, true);
    assert.equal(conv.mutedUntil, until);
    assert.equal((await listFor(sara)).muted, false);
  });

  await t.test('unmute clears muted_until', async () => {
    const r = await api('POST', `/api/conversations/${convId}/mute`, {
      cookies: ali.cookies,
      body: { until: null }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.muted, false);
    assert.equal(r.data.mutedUntil, null);

    const conv = await listFor(ali);
    assert.equal(conv.muted, false);
  });

  await t.test('invalid mute until is rejected', async () => {
    const bad = await api('POST', `/api/conversations/${convId}/mute`, {
      cookies: ali.cookies,
      body: { until: 'not-a-date' }
    });
    assert.equal(bad.status, 400);

    const past = await api('POST', `/api/conversations/${convId}/mute`, {
      cookies: ali.cookies,
      body: { until: new Date(Date.now() - 1000).toISOString() }
    });
    assert.equal(past.status, 400);
  });

  await t.test('expired mute is reported as unmuted in list', async () => {
    await s.db.query(
      'UPDATE conversation_members SET muted_until = $1 WHERE conversation_id = $2 AND user_id = $3',
      [new Date(Date.now() - 60 * 1000).toISOString(), convId, ali.user.id]
    );
    const conv = await listFor(ali);
    assert.equal(conv.muted, false);
    await s.db.query(
      'UPDATE conversation_members SET muted_until = NULL WHERE conversation_id = $1 AND user_id = $2',
      [convId, ali.user.id]
    );
  });

  await t.test('non-member and anonymous cannot toggle', async () => {
    const outsider = await api('POST', `/api/conversations/${convId}/pin`, {
      cookies: mono.cookies,
      body: { pinned: true }
    });
    assert.equal(outsider.status, 404);

    const anon = await api('POST', `/api/conversations/${convId}/pin`, {
      body: { pinned: true }
    });
    assert.equal(anon.status, 401);
  });
});