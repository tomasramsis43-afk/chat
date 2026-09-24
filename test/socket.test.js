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
  emitAck,
  sleep
} = require('./harness');

const openAck = (socket, payload, timeoutMs) =>
  emitAck(socket, 'message:send', payload, timeoutMs);

test('socket suite', async (t) => {
  const s = await startServer();
  t.after(closeServer);

  const ali = await registerUser('sock_ali');
  const sara = await registerUser('sock_sara');
  const mono = await registerUser('sock_mono');

  const dm = await openDm(ali, sara.user.id);
  const convId = dm.data.conversation.id;

  await t.test('socket requires authentication (no cookie rejected)', async () => {
    await new Promise((resolve, reject) => {
      const client = connectClient(s.base, '');
      client.on('connect_error', (err) => {
        client.close();
        resolve();
      });
      client.on('connect', () => {
        client.close();
        reject(new Error('connection must be rejected without a token'));
      });
      client.connect();
    });
  });

  await t.test('message:send delivers to recipient and acks sender', async () => {
    const aSocket = connectClient(s.base, ali.cookies);
    const bSocket = connectClient(s.base, sara.cookies);
    await Promise.all([once(aSocket, 'connect'), once(bSocket, 'connect')]);

    const received = once(bSocket, 'message:new');
    const sent = await openAck(aSocket, {
      conversationId: convId,
      content: 'مرحبا!',
      clientMsgId: randomUUID()
    });
    assert.ok(sent.ok);
    assert.equal(sent.message.content, 'مرحبا!');

    const delivered = await received;
    assert.equal(delivered.conversation_id, convId);
    assert.equal(delivered.sender_id, ali.user.id);
    assert.equal(delivered.content, 'مرحبا!');
    assert.equal(delivered.id, sent.message.id);

    aSocket.close();
    bSocket.close();
  });

  await t.test('duplicate clientMsgId is not inserted twice', async () => {
    const aSocket = connectClient(s.base, ali.cookies);
    const bSocket = connectClient(s.base, sara.cookies);
    await Promise.all([once(aSocket, 'connect'), once(bSocket, 'connect')]);

    const cid = randomUUID();
    let deliveries = 0;
    bSocket.on('message:new', (msg) => {
      if (msg.content === 'رسالة هتتكرر') deliveries++;
    });

    const r1 = await openAck(aSocket, {
      conversationId: convId,
      content: 'رسالة هتتكرر',
      clientMsgId: cid
    });
    assert.ok(r1.ok);
    await sleep(250);
    assert.equal(deliveries, 1);

    const r2 = await openAck(aSocket, {
      conversationId: convId,
      content: 'رسالة هتتكرر',
      clientMsgId: cid
    });
    assert.ok(r2.ok);
    assert.equal(r2.duplicate, true);
    assert.equal(r2.message.id, r1.message.id);
    await sleep(250);
    assert.equal(deliveries, 1);

    aSocket.close();
    bSocket.close();
  });

  await t.test('non-member cannot send to a conversation', async () => {
    const mSocket = connectClient(s.base, mono.cookies);
    await once(mSocket, 'connect');
    const r = await openAck(mSocket, {
      conversationId: convId,
      content: 'دخيل',
      clientMsgId: randomUUID()
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'FORBIDDEN');
    mSocket.close();
  });

  await t.test('conversation:read notifies the other party', async () => {
    const aSocket = connectClient(s.base, ali.cookies);
    const bSocket = connectClient(s.base, sara.cookies);
    await Promise.all([once(aSocket, 'connect'), once(bSocket, 'connect')]);

    const sent = await openAck(aSocket, {
      conversationId: convId,
      content: 'اقرا ديه',
      clientMsgId: randomUUID()
    });

    const readEvt = once(aSocket, 'conversation:read');
    const rr = await emitAck(bSocket, 'conversation:read', {
      conversationId: convId,
      lastReadId: sent.message.id
    });
    assert.ok(rr.ok);
    assert.equal(rr.lastReadId, sent.message.id);

    const evt = await readEvt;
    assert.equal(evt.conversationId, convId);
    assert.equal(evt.userId, sara.user.id);
    assert.equal(evt.lastReadId, sent.message.id);

    aSocket.close();
    bSocket.close();
  });

  await t.test('presence: user with multiple sockets stays online after one disconnects', async () => {
    const b1 = connectClient(s.base, sara.cookies);
    await once(b1, 'connect');
    const statusOnline = async () =>
      (await api('GET', `/api/users/${sara.user.id}`, { cookies: ali.cookies })).data.user.online;

    assert.equal(await statusOnline(), true);

    const b2 = connectClient(s.base, sara.cookies);
    await once(b2, 'connect');
    assert.equal(await statusOnline(), true);

    const disc2 = once(b2, 'disconnect');
    b2.close();
    await disc2;
    await sleep(400);
    assert.equal(await statusOnline(), true);

    const disc1 = once(b1, 'disconnect');
    b1.close();
    await disc1;
    await sleep(400);
    assert.equal(await statusOnline(), false);
  });

  await t.test('presence event delivers online user objects', async () => {
    const c = connectClient(s.base, ali.cookies);
    const evt = await once(c, 'presence');
    c.close();
    assert.ok(Array.isArray(evt));
    assert.ok(evt.length >= 1);
    assert.ok(
      evt.every((u) => u && Number.isInteger(u.id) && typeof u.username === 'string')
    );
  });

  await t.test('presence broadcast reaches already-connected clients with new user', async () => {
    const pBefore = connectClient(s.base, ali.cookies);
    await once(pBefore, 'connect');
    await sleep(400);

    const pEvt = once(pBefore, 'presence');
    const joiner = connectClient(s.base, sara.cookies);
    await once(joiner, 'connect');

    const evt = await Promise.race([
      pEvt,
      sleep(2000).then(() => null)
    ]);
    assert.ok(evt, 'already-connected client must receive a presence broadcast');
    assert.ok(
      evt.some((u) => Number(u.id) === sara.user.id),
      'broadcast must include the newly connected user'
    );
    pBefore.close();
    joiner.close();
    await sleep(300);
  });

  await t.test('message rate limit blocks bursts of spam', async () => {
    const x = await registerUser('sock_x');
    const y = await registerUser('sock_y');
    const ydm = await openDm(x, y.user.id);
    const cid0 = ydm.data.conversation.id;

    const a = connectClient(s.base, x.cookies);
    await once(a, 'connect');

    const results = [];
    for (let i = 0; i < 14; i++) {
      results.push(await openAck(a, {
        conversationId: cid0,
        content: `burst-${i}`,
        clientMsgId: randomUUID()
      }));
    }
    const limited = results.filter((r) => !r.ok && r.error && r.error.code === 'RATE_LIMITED');
    assert.ok(limited.length >= 1, 'expected at least one rate-limited message');
    assert.equal(results.filter((r) => r.ok).length, 10);
    a.close();
  });

  await t.test('invalid payloads are rejected', async () => {
    const a = connectClient(s.base, ali.cookies);
    await once(a, 'connect');

    const tooLong = 'x'.repeat(5000);
    const r1 = await openAck(a, { conversationId: convId, content: tooLong, clientMsgId: randomUUID() });
    assert.ok(!r1.ok);
    assert.equal(r1.error.code, 'BAD_REQUEST');

    const badConv = await openAck(a, { conversationId: 'nope', content: 'y', clientMsgId: randomUUID() });
    assert.ok(!badConv.ok);
    assert.equal(badConv.error.code, 'BAD_REQUEST');

    const empty = await openAck(a, { conversationId: convId, content: '   ', clientMsgId: randomUUID() });
    assert.ok(!empty.ok);
    a.close();
  });

  await t.test('typing event is delivered and throttled', async () => {
    const a = connectClient(s.base, ali.cookies);
    const b = connectClient(s.base, sara.cookies);
    await Promise.all([once(a, 'connect'), once(b, 'connect')]);

    const typ = once(b, 'typing');
    const r = await emitAck(a, 'typing', { conversationId: convId });
    assert.ok(r.ok);
    const evt = await typ;
    assert.equal(evt.conversationId, convId);
    assert.equal(evt.userId, ali.user.id);

    const r2 = await emitAck(a, 'typing', { conversationId: convId });
    assert.equal(r2.throttled, true);

    a.close();
    b.close();
  });

  await t.test('message send to nonexistent conversation fails cleanly', async () => {
    const a = connectClient(s.base, ali.cookies);
    await once(a, 'connect');
    const r = await openAck(a, { conversationId: 999999, content: 'w', clientMsgId: randomUUID() });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'FORBIDDEN');
    a.close();
  });
});