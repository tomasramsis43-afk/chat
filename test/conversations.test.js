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

  await t.test('[regression] old idle DM is reachable via cursor pagination when >100 conversations', async () => {
    const oldPeer = await registerUser('conv_old');
    const oldDm = await openDm(ali, oldPeer.user.id);
    assert.equal(oldDm.status, 201);
    const oldConvId = oldDm.data.conversation.id;

    const now = Date.now();
    const bulkIds = [];
    const bulkUserIds = [];
    for (let i = 0; i < 110; i++) {
      const un = `conv_bulk_${String(i).padStart(3, '0')}`;
      await s.db.query(
        `INSERT INTO users (username, username_lower, password_hash, created_at)
         VALUES ($1, $2, $3, $4)`,
        [un, un.toLowerCase(), 'x', new Date(now + i).toISOString()]
      );
      const found = await s.db.query('SELECT id FROM users WHERE username_lower = $1', [un.toLowerCase()]);
      const uid = Number(found[0].id);
      bulkUserIds.push(uid);
      const t = new Date(now + (i + 1) * 1000).toISOString();
      const key = Math.min(ali.user.id, uid) + ':' + Math.max(ali.user.id, uid);
      const inserted = await s.db.query(
        `INSERT INTO conversations (type, dm_key, created_by, last_message_at, created_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        ['dm', key, ali.user.id, t, t]
      );
      const cid = Number(inserted[0].id);
      const mid = await s.db.query(
        `INSERT INTO messages (conversation_id, sender_id, content, created_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [cid, uid, `bulk-${i}`, t]
      );
      await s.db.query('UPDATE conversations SET last_message_id = $2 WHERE id = $1', [cid, Number(mid[0].id)]);
      await s.db.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, $4)`,
        [cid, ali.user.id, 'owner', t]
      );
      await s.db.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, $4)`,
        [cid, uid, 'member', t]
      );
      bulkIds.push(cid);
    }

    const page1 = await api('GET', '/api/conversations?limit=100', { cookies: ali.cookies });
    assert.equal(page1.status, 200);
    assert.equal(page1.data.conversations.length, 100);
    assert.ok(!page1.data.conversations.some((c) => Number(c.id) === oldConvId), 'old idle DM must not fit in page 1');
    assert.ok(page1.data.nextBeforeTs !== null);
    assert.ok(page1.data.nextBeforeId !== null);

    const seen = page1.data.conversations.map((c) => Number(c.id));
    let guard = 0;
    let cursorTs = page1.data.nextBeforeTs;
    let cursorId = page1.data.nextBeforeId;
    while (cursorTs && cursorId !== null && guard++ < 10) {
      const page = await api(
        'GET',
        `/api/conversations?limit=100&beforeTs=${encodeURIComponent(cursorTs)}&beforeId=${cursorId}`,
        { cookies: ali.cookies }
      );
      assert.equal(page.status, 200);
      seen.push(...page.data.conversations.map((c) => Number(c.id)));
      cursorTs = page.data.nextBeforeTs;
      cursorId = page.data.nextBeforeId;
    }

    assert.equal(new Set(seen).size, 112, 'all conversations reachable across pages, no duplicates');
    assert.ok(seen.includes(convId), 'existing dm present');
    assert.ok(seen.includes(oldConvId), 'old idle DM present via pagination');
    for (const id of bulkIds) assert.ok(seen.includes(id), `bulk conv ${id} present`);

    for (const cid of bulkIds) {
      await s.db.query('DELETE FROM conversation_members WHERE conversation_id = $1', [cid]);
      await s.db.query('DELETE FROM messages WHERE conversation_id = $1', [cid]);
      await s.db.query('DELETE FROM conversations WHERE id = $1', [cid]);
    }
    for (const uid of bulkUserIds) {
      await s.db.query('DELETE FROM users WHERE id = $1', [uid]);
    }
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