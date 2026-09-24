const { test } = require('node:test');
const assert = require('node:assert/strict');
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

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

async function upload(me, convId, payload) {
  return api('POST', `/api/conversations/${convId}/attachments`, {
    cookies: me.cookies,
    body: payload
  });
}

test('uploads suite', async (t) => {
  const s = await startServer();
  t.after(closeServer);

  const ali = await registerUser('up_ali');
  const sara = await registerUser('up_sara');
  const mono = await registerUser('up_mono');

  const dm = await openDm(ali, sara.user.id);
  assert.equal(dm.status, 201);
  const convId = dm.data.conversation.id;

  let uploadedUrl;

  await t.test('member uploads an image attachment', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(12, 7)]);
    const r = await upload(ali, convId, {
      name: 'screenshot.png',
      type: 'image/png',
      data: b64(png)
    });
    assert.equal(r.status, 201);
    assert.ok(r.data.attachment.url.startsWith('/uploads/'));
    assert.equal(r.data.attachment.name, 'screenshot.png');
    assert.equal(r.data.attachment.mime, 'image/png');
    assert.equal(r.data.attachment.size, png.length);
    uploadedUrl = r.data.attachment.url;
  });

  await t.test('served attachment requires auth and returns file', async () => {
    const anon = await fetch(s.base + uploadedUrl);
    assert.equal(anon.status, 401);

    const auth = await fetch(s.base + uploadedUrl, { headers: { Cookie: ali.cookies } });
    assert.equal(auth.status, 200);
    const ct = auth.headers.get('content-type') || '';
    assert.ok(ct.startsWith('image/png'));
    const disp = auth.headers.get('content-disposition') || '';
    assert.ok(!disp.includes('attachment'));
  });

  await t.test('downloadable file attachment is served with attachment disposition', async () => {
    const r = await upload(ali, convId, {
      name: 'note.txt',
      type: 'text/plain',
      data: b64(Buffer.from('مرحبا', 'utf8'))
    });
    assert.equal(r.status, 201);
    const auth = await fetch(s.base + r.data.attachment.url, { headers: { Cookie: ali.cookies } });
    assert.equal(auth.status, 200);
    assert.ok((auth.headers.get('content-disposition') || '').includes('attachment'));
  });

  await t.test('non-member cannot upload', async () => {
    const r = await upload(mono, convId, {
      name: 'x.png',
      type: 'image/png',
      data: b64(Buffer.from('abc'))
    });
    assert.equal(r.status, 404);
  });

  await t.test('unauthenticated upload is rejected', async () => {
    const r = await api('POST', `/api/conversations/${convId}/attachments`, {
      body: { name: 'x.png', type: 'image/png', data: b64(Buffer.from('abc')) }
    });
    assert.equal(r.status, 401);
  });

  await t.test('unsupported mime rejected', async () => {
    const r = await upload(ali, convId, {
      name: 'virus.exe',
      type: 'application/x-msdownload',
      data: b64(Buffer.from('MZ'))
    });
    assert.equal(r.status, 415);
  });

  await t.test('invalid or empty data rejected', async () => {
    const bad = await upload(ali, convId, {
      name: 'x.png',
      type: 'image/png',
      data: 'not!base64!!!'
    });
    assert.equal(bad.status, 400);

    const empty = await upload(ali, convId, {
      name: 'x.png',
      type: 'image/png',
      data: ''
    });
    assert.equal(empty.status, 400);
  });

  await t.test('oversized payload rejected', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    const r = await upload(ali, convId, {
      name: 'big.bin.zip',
      type: 'application/zip',
      data: b64(big)
    });
    assert.equal(r.status, 413);
  });

  await t.test('file name traversal is neutralized', async () => {
    const r = await upload(ali, convId, {
      name: '..\\..\\evil.png',
      type: 'image/png',
      data: b64(Buffer.from('abc'))
    });
    assert.equal(r.status, 201);
    assert.notEqual(r.data.attachment.name, '..\\..\\evil.png');
    assert.ok(!r.data.attachment.name.includes('\\'));
    assert.ok(!r.data.attachment.name.includes('/'));
  });

  await t.test('media message sent over socket reaches recipient with fields', async () => {
    const cAli = connectClient(s.base, ali.cookies);
    const cSara = connectClient(s.base, sara.cookies);
    await once(cAli, 'connect', 8000);
    await once(cSara, 'connect', 8000);

    const receivedPromise = once(cSara, 'message:new', 8000);
    const ack = await emitAck(cAli, 'message:send', {
      conversationId: convId,
      content: 'شاهد الصورة',
      clientMsgId: 'upimg-0001',
      kind: 'image',
      mediaUrl: uploadedUrl,
      mediaName: 'screenshot.png',
      mediaSize: 16,
      mediaMime: 'image/png'
    });
    assert.equal(ack.ok, true);
    assert.equal(ack.message.kind, 'image');
    assert.equal(ack.message.media_url, uploadedUrl);
    assert.equal(ack.message.media_name, 'screenshot.png');

    const msg = await receivedPromise;
    assert.equal(msg.kind, 'image');
    assert.equal(msg.media_url, uploadedUrl);
    assert.equal(msg.content, 'شاهد الصورة');

    cAli.disconnect();
    cSara.disconnect();
  });

  await t.test('socket media validation rejects tampered payloads', async () => {
    const cAli = connectClient(s.base, ali.cookies);
    await once(cAli, 'connect');

    const badKind = await emitAck(cAli, 'message:send', {
      conversationId: convId,
      content: 'x',
      clientMsgId: 'upimg-0002',
      kind: 'video',
      mediaUrl: uploadedUrl,
      mediaName: 'x.mp4'
    });
    assert.ok(!badKind.ok && badKind.error);

    const badUrl = await emitAck(cAli, 'message:send', {
      conversationId: convId,
      content: '',
      clientMsgId: 'upimg-0003',
      kind: 'image',
      mediaUrl: 'https://evil.example/x.png',
      mediaName: 'x.png',
      mediaSize: 10,
      mediaMime: 'image/png'
    });
    assert.ok(!badUrl.ok && badUrl.error);

    const badMime = await emitAck(cAli, 'message:send', {
      conversationId: convId,
      content: '',
      clientMsgId: 'upimg-0004',
      kind: 'file',
      mediaUrl: uploadedUrl,
      mediaName: 'x.exe',
      mediaSize: 10,
      mediaMime: 'application/x-msdownload'
    });
    assert.ok(!badMime.ok && badMime.error);

    cAli.disconnect();
  });

  await t.test('conversation list exposes last media preview', async () => {
    const list = await api('GET', '/api/conversations', { cookies: ali.cookies });
    const conv = list.data.conversations.find((c) => c.id === convId);
    assert.ok(conv);
    assert.equal(conv.lastMessage.kind, 'image');
    assert.equal(conv.lastMessage.mediaUrl, uploadedUrl);
  });
});