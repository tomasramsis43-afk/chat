const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer,
  closeServer,
  api,
  registerUser,
  openDm,
  sleep
} = require('./harness');

test('conversations suite', async (t) => {
  const s = await startServer();
  t.after(closeServer);

  const ali = await registerUser('conv_ali');
  const sara = await registerUser('conv_sara');
  const mono = await registerUser('conv_mono');

  let convId;

  await t.test('opening a dm creates conversation and is idempotent', async () => {
    const r1 = await openDm(ali, sara.user.id);
    assert.equal(r1.status, 201);
    assert.equal(r1.data.conversation.type, 'dm');
    assert.equal(r1.data.conversation.other.id, sara.user.id);
    convId = r1.data.conversation.id;

    const r2 = await openDm(ali, sara.user.id);
    assert.equal(r2.status, 200);
    assert.equal(r2.data.conversation.id, convId);
  });

  await t.test('cannot open a dm with yourself or a missing user', async () => {
    const self = await openDm(ali, ali.user.id);
    assert.equal(self.status, 400);

    const missing = await openDm(ali, 999999);
    assert.equal(missing.status, 404);
  });

  await t.test('conversation list is empty initially then reflects last message', async () => {
    const list1 = await api('GET', '/api/conversations', { cookies: ali.cookies });
    assert.equal(list1.status, 200);
    assert.equal(list1.data.conversations.length, 1);
    assert.equal(list1.data.conversations[0].id, convId);
    assert.equal(list1.data.conversations[0].unread, 0);
  });

  await t.test('messages endpoint requires membership (IDOR protection)', async () => {
    const outsider = await api('GET', `/api/conversations/${convId}/messages`, {
      cookies: mono.cookies
    });
    assert.equal(outsider.status, 404);

    const also = await api('POST', `/api/conversations/${convId}/read`, {
      cookies: mono.cookies,
      body: { lastReadId: 5 }
    });
    assert.equal(also.status, 404);
  });

  await t.test('pagination returns newest page first and walks back by cursor', async () => {
    for (let i = 0; i < 120; i++) {
      await s.db.query(
        `INSERT INTO messages (conversation_id, sender_id, content, created_at)
         VALUES ($1, $2, $3, $4)`,
        [convId, i % 2 === 0 ? ali.user.id : sara.user.id, `msg-${i}`, new Date().toISOString()]
      );
    }
    await s.db.query(
      'UPDATE conversations SET last_message_id = (SELECT MAX(id) FROM messages WHERE conversation_id = $1), last_message_at = (SELECT MAX(created_at) FROM messages WHERE conversation_id = $1) WHERE id = $1',
      [convId]
    );

    const seen = [];
    let before;
    const page1 = await api('GET', `/api/conversations/${convId}/messages?limit=50`, {
      cookies: ali.cookies
    });
    assert.equal(page1.status, 200);
    assert.equal(page1.data.messages.length, 50);
    assert.ok(page1.data.nextBefore !== null);
    seen.push(...page1.data.messages.map((m) => m.id));
    before = page1.data.nextBefore;

    const page2 = await api('GET', `/api/conversations/${convId}/messages?limit=50&before=${before}`, {
      cookies: ali.cookies
    });
    assert.equal(page2.status, 200);
    assert.equal(page2.data.messages.length, 50);
    assert.ok(page2.data.nextBefore !== null);
    seen.push(...page2.data.messages.map((m) => m.id));

    const page3 = await api('GET', `/api/conversations/${convId}/messages?limit=50&before=${page2.data.nextBefore}`, {
      cookies: ali.cookies
    });
    assert.equal(page3.status, 200);
    assert.equal(page3.data.messages.length, 20);
    assert.equal(page3.data.nextBefore, null);
    seen.push(...page3.data.messages.map((m) => m.id));

    assert.equal(seen.length, 120);
    assert.equal(new Set(seen).size, 120);
    const expectedIds = Array.from({ length: 120 }, (_, i) => i + 1);
    assert.deepEqual([...new Set(seen)].sort((a, b) => a - b), expectedIds);

    for (const m of page1.data.messages) {
      assert.match(m.content, /^msg-0?/);
      assert.equal(typeof m.content, 'string');
      assert.ok(m.created_at);
    }
  });

  await t.test('after cursor fetches newer messages (gap fill)', async () => {
    await s.db.query(
      `INSERT INTO messages (conversation_id, sender_id, content, created_at)
       VALUES ($1, $2, $3, $4)`,
      [convId, ali.user.id, 'AfterCursorMsg', new Date().toISOString()]
    );
    const latest = await api('GET', `/api/conversations/${convId}/messages?limit=3`, {
      cookies: ali.cookies
    });
    const newestId = latest.data.messages[latest.data.messages.length - 1].id;

    const gap = await api('GET', `/api/conversations/${convId}/messages?after=${
      newestId - 4}&limit=10`, { cookies: ali.cookies });
    assert.equal(gap.status, 200);
    assert.ok(gap.data.messages.length >= 4);
    assert.equal(gap.data.messages[gap.data.messages.length - 1].id, newestId);
  });

  await t.test('read endpoint updates unread counts for the other member', async () => {
    const sentBySara = await api('GET', `/api/conversations/${convId}/messages?limit=100`, {
      cookies: sara.cookies
    });
    const saraMsgs = sentBySara.data.messages.filter((m) => m.sender_id === sara.user.id);
    assert.ok(saraMsgs.length > 0);
    const lastOfSara = saraMsgs[saraMsgs.length - 1].id;

    const unreadBefore = await api('GET', '/api/conversations', { cookies: ali.cookies });
    const convo = unreadBefore.data.conversations.find((c) => c.id === convId);
    assert.ok(convo.unread > 0);

    const read = await api('POST', `/api/conversations/${convId}/read`, {
      cookies: ali.cookies,
      body: { lastReadId: lastOfSara }
    });
    assert.equal(read.status, 200);
    assert.equal(read.data.lastReadId, lastOfSara);

    const unreadAfter = await api('GET', '/api/conversations', { cookies: ali.cookies });
    const convo2 = unreadAfter.data.conversations.find((c) => c.id === convId);
    assert.equal(convo2.unread, 0);
  });

  await t.test('messages are stored raw (no server-side mutation / XSS-safe contract)', async () => {
    const raw = '<img src=x onerror=alert(1)>';
    await s.db.query(
      `INSERT INTO messages (conversation_id, sender_id, content, created_at)
       VALUES ($1, $2, $3, $4)`,
      [convId, sara.user.id, raw, new Date().toISOString()]
    );
    const res = await api('GET', `/api/conversations/${convId}/messages?limit=5`, {
      cookies: ali.cookies
    });
    const msg = res.data.messages.find((m) => m.content === raw);
    assert.ok(msg, 'raw message content must be returned unchanged');
  });

  await t.test('users search works and excludes self', async () => {
    const all = await api('GET', '/api/users', { cookies: ali.cookies });
    assert.equal(all.status, 200);
    const names = all.data.users.map((u) => u.username);
    assert.ok(names.includes('conv_sara'));
    assert.ok(!names.includes('conv_ali'));

    const search = await api('GET', '/api/users?q=SARA', { cookies: ali.cookies });
    assert.equal(search.status, 200);
    assert.equal(search.data.users.length, 1);
    assert.equal(search.data.users[0].username, 'conv_sara');
  });

  await t.test('invalid inputs rejected', async () => {
    const bad = await api('GET', `/api/conversations/${convId}/messages?limit=9999`, {
      cookies: ali.cookies
    });
    assert.equal(bad.status, 200);
    assert.equal(bad.data.messages.length, 100);

    const notNum = await api('GET', '/api/conversations/abc/messages', {
      cookies: ali.cookies
    });
    assert.equal(notNum.status, 400);

    const readBad = await api('POST', `/api/conversations/${convId}/read`, {
      cookies: ali.cookies,
      body: { lastReadId: -5 }
    });
    assert.equal(readBad.status, 400);
  });

  await t.test('auth required everywhere', async () => {
    const r1 = await api('GET', '/api/conversations');
    assert.equal(r1.status, 401);
    const r2 = await api('GET', '/api/users');
    assert.equal(r2.status, 401);
  });
});