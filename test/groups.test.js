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

test('groups suite', async (t) => {
  const s = await startServer();
  t.after(closeServer);

  const ali = await registerUser('grp_ali');
  const sara = await registerUser('grp_sara');
  const mono = await registerUser('grp_mono');

  let groupId;

  await t.test('create group with members', async () => {
    const r = await api('POST', '/api/conversations/group', {
      cookies: ali.cookies,
      body: { name: 'فريق سالم', memberIds: [sara.user.id, mono.user.id] }
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.conversation.type, 'group');
    assert.equal(r.data.conversation.name, 'فريق سالم');
    assert.equal(r.data.conversation.memberCount, 3);
    assert.equal(r.data.conversation.role, 'owner');
    groupId = r.data.conversation.id;
  });

  await t.test('create group rejects bad input', async () => {
    const noName = await api('POST', '/api/conversations/group', {
      cookies: ali.cookies,
      body: { memberIds: [sara.user.id] }
    });
    assert.equal(noName.status, 400);

    const dup = await api('POST', '/api/conversations/group', {
      cookies: ali.cookies,
      body: { name: 'م', memberIds: [sara.user.id] }
    });
    assert.equal(dup.status, 400);

    const badMember = await api('POST', '/api/conversations/group', {
      cookies: ali.cookies,
      body: { name: 'مجموعة', memberIds: [999999] }
    });
    assert.equal(badMember.status, 404);
  });

  await t.test('members endpoint requires membership and lists members', async () => {
    const list = await api('GET', `/api/conversations/${groupId}/members`, {
      cookies: ali.cookies
    });
    assert.equal(list.status, 200);
    assert.equal(list.data.members.length, 3);
    assert.ok(list.data.members.some((m) => m.role === 'owner'));

    const outsider = await api('GET', `/api/conversations/${groupId}/members`, {
      cookies: (await registerUser('grp_out')).cookies
    });
    assert.equal(outsider.status, 404);
  });

  await t.test('non-manager cannot add members', async () => {
    const r = await api('POST', `/api/conversations/${groupId}/members`, {
      cookies: sara.cookies,
      body: { userId: (await registerUser('grp_x')).user.id }
    });
    assert.equal(r.status, 403);
  });

  await t.test('owner adds a member', async () => {
    const newUser = await registerUser('grp_new');
    const r = await api('POST', `/api/conversations/${groupId}/members`, {
      cookies: ali.cookies,
      body: { userId: newUser.user.id }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.members.length, 4);
  });

  await t.test('group message reaches all members via socket', async () => {
    const cAli = connectClient(s.base, ali.cookies);
    const cSara = connectClient(s.base, sara.cookies);
    cAli.on('connect', () => cAli.emit('typing', { conversationId: groupId }));
    await once(cAli, 'connect', 8000);
    await once(cSara, 'connect', 8000);

    const receivedPromise = once(cSara, 'message:new', 8000);
    const ack = await emitAck(cAli, 'message:send', {
      conversationId: groupId,
      content: 'رسالة جماعية',
      clientMsgId: 'groupmsg-001'
    });
    assert.equal(ack.ok, true);
    const msg = await receivedPromise;
    assert.equal(msg.content, 'رسالة جماعية');
    assert.equal(msg.sender_id, ali.user.id);

    cAli.disconnect();
    cSara.disconnect();
  });

  await t.test('non-member cannot read group messages', async () => {
    const outsider = await registerUser('grp_z');
    const r = await api('GET', `/api/conversations/${groupId}/messages?limit=10`, {
      cookies: outsider.cookies
    });
    assert.equal(r.status, 404);
  });

  await t.test('rename group by manager', async () => {
    const r = await api('PATCH', `/api/conversations/${groupId}`, {
      cookies: ali.cookies,
      body: { name: 'اسم جديد' }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.conversation.name, 'اسم جديد');
  });

  await t.test('rename rejected for non-manager', async () => {
    const r = await api('PATCH', `/api/conversations/${groupId}`, {
      cookies: sara.cookies,
      body: { name: 'ممنوع' }
    });
    assert.equal(r.status, 403);
  });

  await t.test('transfer ownership promotes target and demotes owner', async () => {
    const r = await api('POST', `/api/conversations/${groupId}/transfer`, {
      cookies: ali.cookies,
      body: { userId: sara.user.id }
    });
    assert.equal(r.status, 200);
    assert.ok(r.data.members.find((m) => m.id === sara.user.id).role === 'owner');
    assert.ok(r.data.members.find((m) => m.id === ali.user.id).role === 'admin');
  });

  await t.test('member can leave; owner cannot leave', async () => {
    const mono2 = await registerUser('grp_leave');
    await api('POST', `/api/conversations/${groupId}/members`, {
      cookies: sara.cookies,
      body: { userId: mono2.user.id }
    });

    const r = await api('DELETE', `/api/conversations/${groupId}/members/${mono2.user.id}`, {
      cookies: mono2.cookies
    });
    assert.equal(r.status, 200);

    const ownerLeave = await api('DELETE', `/api/conversations/${groupId}/members/${sara.user.id}`, {
      cookies: sara.cookies
    });
    assert.equal(ownerLeave.status, 400);
  });

  await t.test('owner deletes group and members are detached', async () => {
    const r = await api('DELETE', `/api/conversations/${groupId}`, {
      cookies: sara.cookies
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.deleted, true);

    const list = await api('GET', '/api/conversations', { cookies: mono.cookies });
    assert.equal(list.data.conversations.length, 0);
  });

  await t.test('dm flow still works after group changes', async () => {
    const dm = await openDm(ali, mono.user.id);
    assert.equal(dm.status, 201);
    assert.equal(dm.data.conversation.type, 'dm');
  });
});