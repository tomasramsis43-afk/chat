const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer,
  closeServer,
  api,
  registerUser,
  loginUser,
  connectClient,
  once,
  emitAck,
  openDm,
  sleep
} = require('./harness');

async function makeAdmin(s, userId) {
  await s.db.query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
}

test('moderation suite', async (t) => {
  const s = await startServer();
  t.after(closeServer);

  const admin = await registerUser('mod_admin');
  await makeAdmin(s, admin.user.id);
  const alice = await registerUser('mod_alice');
  const bob = await registerUser('mod_bob');

  await t.test('non-admin gets 403 on admin endpoints', async () => {
    const r = await api('GET', '/api/admin/stats', { cookies: alice.cookies });
    assert.equal(r.status, 403);
    assert.equal(r.data.error.code, 'FORBIDDEN');
  });

  await t.test('admin can read stats', async () => {
    const r = await api('GET', '/api/admin/stats', { cookies: admin.cookies });
    assert.equal(r.status, 200);
    assert.ok(r.data.totalUsers >= 3);
    assert.equal(r.data.admins, 1);
  });

  await t.test('admin can list and search users', async () => {
    const r = await api('GET', '/api/admin/users?q=mod_ali', { cookies: admin.cookies });
    assert.equal(r.status, 200);
    assert.ok(r.data.users.some((u) => u.username === 'mod_alice'));
  });

  await t.test('ban blocks login and shows up in admin list', async () => {
    const ban = await api('POST', `/api/admin/users/${bob.user.id}/ban`, {
      cookies: admin.cookies,
      body: { reason: 'اختبار' }
    });
    assert.equal(ban.status, 200);

    const login = await loginUser('mod_bob', bob.password);
    assert.equal(login.status, 403);
    assert.equal(login.data.error.code, 'BANNED');

    const list = await api('GET', '/api/admin/users?q=mod_bob', { cookies: admin.cookies });
    const row = list.data.users.find((u) => u.username === 'mod_bob');
    assert.ok(row.banned_at);
    assert.equal(row.banned_reason, 'اختبار');
  });

  await t.test('an admin cannot be banned, and cannot ban themselves out', async () => {
    const r = await api('POST', `/api/admin/users/${admin.user.id}/ban`, {
      cookies: admin.cookies,
      body: {}
    });
    assert.equal(r.status, 400);
  });

  await t.test('unban restores login', async () => {
    const unban = await api('POST', `/api/admin/users/${bob.user.id}/unban`, {
      cookies: admin.cookies
    });
    assert.equal(unban.status, 200);
    const login = await loginUser('mod_bob', bob.password);
    assert.equal(login.status, 200);
    bob.cookies = login.cookies;
  });

  await t.test('promote and demote roles', async () => {
    const promote = await api('POST', `/api/admin/users/${bob.user.id}/promote`, {
      cookies: admin.cookies
    });
    assert.equal(promote.status, 200);
    let stats = await api('GET', '/api/admin/stats', { cookies: admin.cookies });
    assert.equal(stats.data.admins, 2);

    const bobIsAdmin = await api('GET', '/api/admin/stats', { cookies: bob.cookies });
    assert.equal(bobIsAdmin.status, 200);

    const demote = await api('POST', `/api/admin/users/${bob.user.id}/demote`, {
      cookies: admin.cookies
    });
    assert.equal(demote.status, 200);
    stats = await api('GET', '/api/admin/stats', { cookies: admin.cookies });
    assert.equal(stats.data.admins, 1);

    const bobNotAdmin = await api('GET', '/api/admin/stats', { cookies: bob.cookies });
    assert.equal(bobNotAdmin.status, 403);
  });

  await t.test('block prevents DM messages both ways and hides from search', async () => {
    const dm = await openDm(alice, bob.user.id);
    assert.equal(dm.status, 201);
    const convId = dm.data.conversation.id;

    const blk = await api('POST', `/api/users/${bob.user.id}/block`, { cookies: alice.cookies });
    assert.equal(blk.status, 200);

    const search = await api('GET', '/api/users?q=mod_bob', { cookies: alice.cookies });
    assert.equal(search.data.users.some((u) => u.id === bob.user.id), false);

    const aliceSock = connectClient(s.base, alice.cookies);
    await once(aliceSock, 'connect');
    const bobSock = connectClient(s.base, bob.cookies);
    await once(bobSock, 'connect');

    const sendFromAlice = await emitAck(aliceSock, 'message:send', {
      conversationId: convId,
      content: 'مرحبا'
    });
    assert.ok(sendFromAlice.error, 'blocker cannot send to blocked user');
    assert.equal(sendFromAlice.error.code, 'BLOCKED');

    const sendFromBob = await emitAck(bobSock, 'message:send', {
      conversationId: convId,
      content: 'أهلا'
    });
    assert.ok(sendFromBob.error, 'blocked user cannot send to blocker either');
    assert.equal(sendFromBob.error.code, 'BLOCKED');

    aliceSock.close();
    bobSock.close();

    const unblk = await api('DELETE', `/api/users/${bob.user.id}/block`, { cookies: alice.cookies });
    assert.equal(unblk.status, 200);
    const searchAgain = await api('GET', '/api/users?q=mod_bob', { cookies: alice.cookies });
    assert.equal(searchAgain.data.users.some((u) => u.id === bob.user.id), true);
  });

  await t.test('cannot block yourself', async () => {
    const r = await api('POST', `/api/users/${alice.user.id}/block`, { cookies: alice.cookies });
    assert.equal(r.status, 400);
  });

  await t.test('report flow: create, list, resolve, and audit log', async () => {
    const dm = await openDm(alice, bob.user.id);
    const convId = dm.data.conversation.id;

    const report = await api('POST', `/api/users/${bob.user.id}/report`, {
      cookies: alice.cookies,
      body: { reason: 'harassment', details: 'إزعاج متكرر', conversationId: convId }
    });
    assert.equal(report.status, 201);

    const badReason = await api('POST', `/api/users/${bob.user.id}/report`, {
      cookies: alice.cookies,
      body: { reason: 'not_a_real_reason' }
    });
    assert.equal(badReason.status, 400);

    const list = await api('GET', '/api/admin/reports?status=open', { cookies: admin.cookies });
    assert.equal(list.status, 200);
    const found = list.data.reports.find((r) => r.target.username === 'mod_bob');
    assert.ok(found);
    assert.equal(found.reporter.username, 'mod_alice');

    const resolve = await api('POST', `/api/admin/reports/${found.id}/resolve`, {
      cookies: admin.cookies,
      body: { status: 'resolved' }
    });
    assert.equal(resolve.status, 200);

    const resolved = await api('GET', '/api/admin/reports?status=resolved', { cookies: admin.cookies });
    assert.ok(resolved.data.reports.some((r) => r.id === found.id));

    const audit = await api('GET', '/api/admin/audit-log?limit=200', { cookies: admin.cookies });
    assert.ok(audit.data.entries.some((e) => e.action === 'resolve_report' && e.target_id === found.id));
  });

  await t.test('admin can list conversations and view messages, which is audited', async () => {
    const list = await api('GET', '/api/admin/conversations?limit=50', { cookies: admin.cookies });
    assert.equal(list.status, 200);
    const dm = list.data.conversations.find((c) =>
      c.members.some((m) => m.username === 'mod_alice') && c.members.some((m) => m.username === 'mod_bob')
    );
    assert.ok(dm);

    const msgs = await api('GET', `/api/admin/conversations/${dm.id}/messages`, { cookies: admin.cookies });
    assert.equal(msgs.status, 200);

    const audit = await api('GET', '/api/admin/audit-log?limit=200', { cookies: admin.cookies });
    assert.ok(
      audit.data.entries.some(
        (e) => e.action === 'view_conversation_messages' && e.target_id === dm.id
      )
    );
  });

  await t.test('banned socket connections are rejected', async () => {
    await api('POST', `/api/admin/users/${bob.user.id}/ban`, { cookies: admin.cookies, body: {} });
    const sock = connectClient(s.base, bob.cookies);
    await Promise.race([
      once(sock, 'connect_error').then((e) => assert.ok(e)),
      once(sock, 'connect').then(() => assert.fail('banned user should not connect')),
      sleep(3000).then(() => assert.fail('timed out waiting for connect_error'))
    ]);
    sock.close();
  });
});
