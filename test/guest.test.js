const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  startServer,
  closeServer,
  api,
  registerUser,
  openDm,
  connectClient,
  once,
  emitAck
} = require('./harness');

test('guest suite', async (t) => {
  const s = await startServer();
  t.after(closeServer);

  const host = await registerUser('guest_host');

  await t.test('guest enters with name and gender, no password', async () => {
    const res = await api('POST', '/api/auth/guest', {
      body: { username: 'guest_1', gender: 'male' }
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.username, 'guest_1');
    assert.equal(res.data.user.gender, 'male');
    assert.equal(res.data.user.guest, true);
    assert.ok(res.cookies.includes('salem_at='));
    assert.ok(res.cookies.includes('salem_rt='));

    const me = await api('GET', '/api/auth/me', { cookies: res.cookies });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, 'guest_1');
  });

  await t.test('guest name is unique while active', async () => {
    const dup = await api('POST', '/api/auth/guest', {
      body: { username: 'guest_1', gender: 'female' }
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error.code, 'USERNAME_TAKEN');
  });

  await t.test('guest has no usable password', async () => {
    const login = await api('POST', '/api/auth/login', {
      body: { username: 'guest_1', password: 'password123' }
    });
    assert.equal(login.status, 401);
  });

  await t.test('logout frees the name, keeps messages, hides the user', async () => {
    const guest = await api('POST', '/api/auth/guest', {
      body: { username: 'guest_del', gender: 'female' }
    });
    assert.equal(guest.status, 201);
    const guestId = guest.data.user.id;

    const dm = await openDm(host, guestId);
    const convId = dm.data.conversation.id;

    const gs = connectClient(s.base, guest.cookies);
    await once(gs, 'connect');
    const sent = await emitAck(gs, 'message:send', {
      conversationId: convId,
      content: 'رسالة من زائر',
      clientMsgId: randomUUID()
    });
    assert.ok(sent.ok);
    gs.close();

    const out = await api('POST', '/api/auth/logout', { cookies: guest.cookies });
    assert.equal(out.status, 200);

    // 1) محذوف من البحث والقائمة و get بي 404
    const search = await api('GET', '/api/users?q=guest_del', { cookies: host.cookies });
    assert.equal(search.status, 200);
    assert.equal(search.data.users.length, 0);

    const byId = await api('GET', `/api/users/${guestId}`, { cookies: host.cookies });
    assert.equal(byId.status, 404);

    // 2) الصف اتبقى لكن بـ soft-delete
    const row = await s.db.query(
      'SELECT username, username_lower, is_guest, deleted_at FROM users WHERE id = $1',
      [guestId]
    );
    assert.equal(row[0].username, 'مستخدم محذوف');
    assert.equal(row[0].username_lower, `deleted-${guestId}`);
    assert.ok(row[0].is_guest);
    assert.ok(row[0].deleted_at);

    // 3) الاسم رجع متاح — زائر جديد يستخدمه
    const reuse = await api('POST', '/api/auth/guest', {
      body: { username: 'guest_del', gender: 'male' }
    });
    assert.equal(reuse.status, 201);
    assert.notEqual(reuse.data.user.id, guestId);

    // 4) الـ DM ورسالة الزائر لسه موجودين عند الطرف التاني
    const convs = await api('GET', '/api/conversations', { cookies: host.cookies });
    assert.equal(convs.status, 200);
    const conv = convs.data.conversations.find((c) => c.id === convId);
    assert.ok(conv, 'DM must still exist for the host');
    assert.equal(conv.other.username, 'مستخدم محذوف');

    const msgs = await api('GET', `/api/conversations/${convId}/messages`, { cookies: host.cookies });
    assert.equal(msgs.status, 200);
    const kept = msgs.data.messages.find((m) => m.content === 'رسالة من زائر');
    assert.ok(kept, 'guest message must remain after logout');

    // 5) الجلسة اتسحبت — refresh قديم مرفوض
    const replay = await api('POST', '/api/auth/refresh', { cookies: guest.cookies });
    assert.equal(replay.status, 401);
  });
});