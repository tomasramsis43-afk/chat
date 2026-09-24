const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serialize, LEVELS } = require('../src/logger');

test('logger exposes standard levels', () => {
  assert.deepEqual(LEVELS, { error: 0, warn: 1, info: 2, http: 3, debug: 4 });
  assert.equal(typeof serialize, 'function');
});

test('serialize renders human-readable lines by default', () => {
  const line = serialize('info', 'server started', { port: 3000 });
  assert.match(line, /^\[.+\] INFO \[salem\] server started \{"port":3000\}$/);
});

test('serialize redacts secret values and key names', () => {
  const line = serialize('error', 'auth failed', {
    password: 'supersecret',
    authorization: 'Bearer abc.xyz',
    token: 'rt.secret.token',
    username: 'ali'
  });
  assert.ok(!line.includes('supersecret'));
  assert.ok(!line.includes('Bearer abc.xyz'));
  assert.ok(!line.includes('rt.secret.token'));
  assert.ok(line.includes('[REDACTED]'));
  assert.ok(line.includes('"redacted":"[REDACTED]"'));
  assert.ok(line.includes('"username":"ali"'));
});

test('serialize flattens errors into safe metadata', () => {
  const err = new Error('boom');
  const line = serialize('error', 'unhandled', { err });
  assert.ok(line.includes('boom'));
  assert.ok(line.includes('StackTrace') || line.includes('err'));
});

test('serialize keeps plain values and buffers summarized', () => {
  const line = serialize('debug', 'payload', { buf: Buffer.from('xyz') });
  assert.ok(line.includes('Buffer(3)'));
});