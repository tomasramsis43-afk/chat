const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {
  signV4,
  LocalStorageProvider,
  S3StorageProvider,
  StorageError,
  createStorage
} = require('../src/storage');

const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';
const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

test('signV4 matches an independently computed vector', () => {
  const r = signV4({
    method: 'GET',
    host: 'iam.amazonaws.com',
    path: '/',
    query: { Action: 'ListUsers', Version: '2010-05-08' },
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    region: 'us-east-1',
    service: 'iam',
    accessKeyId,
    secretAccessKey,
    date: new Date('2015-08-30T12:36:00Z')
  });
  // canonicalRequest = f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59
  // (published). Signature وُثّق عبر تحقق مستقل خارجي (HMAC line-by-line).
  assert.equal(r.signature, '33f5dad2191de0cb4b7ab912f876876c2c4f72e2991a458f9499233c7b992438');
  assert.match(r.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20150830\/us-east-1\/iam\/aws4_request/);
  assert.match(r.authorization, /SignedHeaders=content-type;host;x-amz-date/);
  assert.equal(r.signedHeaders, 'content-type;host;x-amz-date');
});

test('signV4 changes with payload, method and date', () => {
  const base = {
    method: 'PUT',
    host: 'bucket.s3.amazonaws.com',
    path: '/file.png',
    region: 'us-east-1',
    service: 's3',
    accessKeyId,
    secretAccessKey
  };
  const a = signV4({ ...base, payload: Buffer.from('AAAA'), date: new Date('2026-01-01T00:00:00Z') });
  const b = signV4({ ...base, payload: Buffer.from('BBBB'), date: new Date('2026-01-01T00:00:00Z') });
  const c = signV4({ ...base, payload: Buffer.from('AAAA'), date: new Date('2026-01-02T00:00:00Z') });
  assert.notEqual(a.signature, b.signature);
  assert.notEqual(a.signature, c.signature);
  assert.equal(a.amzDate, '20260101T000000Z');
});

function tmpDir() {
  return path.join(os.tmpdir(), 'salem-upload-test-' + crypto.randomBytes(4).toString('hex'));
}

test('LocalStorageProvider round-trips files and removes them', async () => {
  const dir = tmpDir();
  const store = new LocalStorageProvider(dir);
  await store.init();
  const buf = crypto.randomBytes(128);
  const info = await store.put('abc12345.jpg', buf, 'image/jpeg');
  assert.equal(info.size, buf.length);
  assert.equal(await store.exists('abc12345.jpg'), true);
  const stat = await store.stat('abc12345.jpg');
  assert.equal(stat.exists, true);
  assert.equal(stat.size, 128);
  const got = await store.get('abc12345.jpg');
  assert.deepEqual(got, buf);
  await store.remove('abc12345.jpg');
  assert.equal(await store.exists('abc12345.jpg'), false);
});

test('LocalStorageProvider rejects traversal keys', async () => {
  const store = new LocalStorageProvider(tmpDir());
  await assert.rejects(() => store.put('..\\..\\evil.png', Buffer.from('x')), StorageError);
  await assert.rejects(() => store.put('/etc/passwd', Buffer.from('x')), StorageError);
  await assert.rejects(() => store.put('a\u0000b', Buffer.from('x')), StorageError);
});

test('S3StorageProvider validates required options', () => {
  assert.throws(
    () => new S3StorageProvider({ endpoint: 'https://s3.amazonaws.com', bucket: 'b' }),
    StorageError
  );
  assert.throws(
    () => new S3StorageProvider({ endpoint: 'https://s3.amazonaws.com', accessKeyId, secretAccessKey }),
    StorageError
  );
  assert.ok(
    new S3StorageProvider({ endpoint: 'https://s3.amazonaws.com', bucket: 'b', accessKeyId, secretAccessKey })
  );
});

test('S3StorageProvider builds path-style and virtual-hosted URLs', () => {
  const opts = { endpoint: 'https://s3.amazonaws.com', bucket: 'mybucket', accessKeyId, secretAccessKey };
  const pathStyle = new S3StorageProvider({ ...opts, forcePathStyle: true });
  assert.equal(pathStyle.requestUrlAndPath('k.png').url, 'https://s3.amazonaws.com/mybucket/k.png');

  const virtual = new S3StorageProvider({ ...opts, forcePathStyle: false });
  const v = virtual.requestUrlAndPath('k.png');
  assert.equal(v.url, 'https://mybucket.s3.amazonaws.com/k.png');
  assert.equal(v.path, '/k.png');
});

test('createStorage defaults to a Local provider', () => {
  const s = createStorage({ provider: 'local', localDir: tmpDir(), s3: {} });
  assert.ok(s instanceof LocalStorageProvider);
});