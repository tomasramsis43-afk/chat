const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer,
  closeServer,
  api,
  registerUser,
  connectClient,
  once,
  emitAck,
  openDm
} = require('./harness');

test('reactions suite', async (t) => {
  const s = await startServer();
  t.after(closeServer);

  const ali = await registerUser('rx_ali');
  const sara = await registerUser('rx_sara');
  const dm = await openDm(ali, sara.user.id);
  const convId = dm.data.conversation.id;

  const aliSock = connectClient(s.base, ali.cookies);
  await once(aliSock, 'connect');
  const saraSock = connectClient(s.base, sara.cookies);
  await once(saraSock, 'connect');
  t.after(() => {
    aliSock.close();
    saraSock.close();
  });

  const sent = await emitAck(aliSock, 'message:send', { conversationId: convId, content: 'صباح الخير' });
  assert.equal(sent.ok, true);
  const messageId = sent.message.id;

  await t.test('unsupported emoji is rejected', async () => {
    const r = await emitAck(saraSock, 'reaction:toggle', { messageId, emoji: '🐙' });
    assert.ok(r.error);
    assert.equal(r.error.code, 'BAD_REQUEST');
  });

  await t.test('toggling a reaction adds then removes it, and notifies the other member', async () => {
    const waitAdd = once(aliSock, 'reaction:update');
    const add = await emitAck(saraSock, 'reaction:toggle', { messageId, emoji: '❤️' });
    assert.equal(add.ok, true);
    assert.equal(add.added, true);
    const addEvent = await waitAdd;
    assert.equal(addEvent.messageId, messageId);
    assert.equal(addEvent.conversationId, convId);
    assert.equal(addEvent.emoji, '❤️');
    assert.equal(addEvent.userId, sara.user.id);
    assert.equal(addEvent.added, true);

    const waitRemove = once(aliSock, 'reaction:update');
    const remove = await emitAck(saraSock, 'reaction:toggle', { messageId, emoji: '❤️' });
    assert.equal(remove.added, false);
    const removeEvent = await waitRemove;
    assert.equal(removeEvent.added, false);
  });

  await t.test('non-member cannot react', async () => {
    const mallory = await registerUser('rx_mallory');
    const msock = connectClient(s.base, mallory.cookies);
    await once(msock, 'connect');
    const r = await emitAck(msock, 'reaction:toggle', { messageId, emoji: '👍' });
    assert.ok(r.error);
    msock.close();
  });

  await t.test('history endpoint includes reaction summary with mine flag', async () => {
    await emitAck(saraSock, 'reaction:toggle', { messageId, emoji: '🔥' });
    await emitAck(aliSock, 'reaction:toggle', { messageId, emoji: '🔥' });

    const historyForAli = await api('GET', `/api/conversations/${convId}/messages`, { cookies: ali.cookies });
    const msg = historyForAli.data.messages.find((m) => m.id === messageId);
    const fire = msg.reactions.find((r) => r.emoji === '🔥');
    assert.equal(fire.count, 2);
    assert.equal(fire.mine, true);

    const historyForSara = await api('GET', `/api/conversations/${convId}/messages`, { cookies: sara.cookies });
    const msgForSara = historyForSara.data.messages.find((m) => m.id === messageId);
    const fireForSara = msgForSara.reactions.find((r) => r.emoji === '🔥');
    assert.equal(fireForSara.count, 2);
    assert.equal(fireForSara.mine, true);
  });
});
