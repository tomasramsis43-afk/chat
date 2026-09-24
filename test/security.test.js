const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { startServer, closeServer, api, registerUser } = require('./harness');

test('security suite', async (t) => {
  const s = await startServer();
  t.after(closeServer);

  const user = await registerUser('sec_user');

  await t.test('cross-origin POST is rejected (CSRF protection)', async () => {
    const res = await api('POST', '/api/auth/logout', {
      cookies: user.cookies,
      headers: { Origin: 'https://evil.example' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'FORBIDDEN');
  });

  await t.test('same-origin request is allowed', async () => {
    const res = await api('POST', '/api/auth/logout', {
      cookies: user.cookies,
      headers: { Origin: s.base, Referer: s.base + '/' }
    });
    assert.equal(res.status, 200);
    const res2 = await registerUser('sec_user2');
    assert.equal(res2.user.username, 'sec_user2');
  });

  await t.test('non-json content type is rejected (415)', async () => {
    const res = await api('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'text/plain' },
      body: { username: 'sec_user', password: 'password123' }
    });
    assert.equal(res.status, 415);
    assert.equal(res.data.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  await t.test('malformed json returns 400', async () => {
    const res = await fetch(s.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"username":'
    });
    assert.equal(res.status, 400);
  });

  await t.test('oversized body is rejected', async () => {
    const res = await api('POST', '/api/auth/login', {
      body: { username: 'x'.repeat(40000), password: 'y'.repeat(40000) }
    });
    assert.equal(res.status, 413);
  });

  await t.test('weak passwords are rejected', async () => {
    const res = await api('POST', '/api/auth/register', {
      body: { username: 'weakpass', password: 'short' }
    });
    assert.equal(res.status, 400);
  });

  await t.test('duplicate username returns 409', async () => {
    const res = await api('POST', '/api/auth/register', {
      body: { username: 'sec_user2', password: 'password123' }
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'USERNAME_TAKEN');
  });

  await t.test('sql injection in username is neutralized', async () => {
    const attempt = "x'; DROP TABLE users; --";
    const res = await api('POST', '/api/auth/register', {
      body: { username: attempt, password: 'password123' }
    });
    assert.ok(res.status !== 500, 'injection attempt must not cause 500');
    assert.ok([400, 409, 201].includes(res.status));

    const search = await api('GET', `/api/users?q=${encodeURIComponent("x' OR 1=1 --")}`, {
      cookies: user.cookies
    });
    assert.equal(search.status, 200);
  });

  await t.test('tampered access cookie is rejected', async () => {
    const tampered = user.cookies.replace(/salem_at=[^;]+/, 'salem_at=forged.jwt.token');
    const res = await api('GET', '/api/auth/me', { cookies: tampered });
    assert.equal(res.status, 401);
  });

  await t.test('cookies carry secure flags', async () => {
    const setCookie = Array.from((await api('POST', '/api/auth/login', {
      body: { username: 'sec_user', password: 'password123' }
    })).headers.getSetCookie());
    const at = setCookie.find((c) => c.startsWith('salem_at='));
    const rt = setCookie.find((c) => c.startsWith('salem_rt='));
    assert.ok(at);
    assert.ok(at.includes('HttpOnly'));
    assert.ok(at.includes('SameSite=Strict'));
    assert.ok(rt.includes('Path=/api/auth'));
  });

  await t.test('refresh without token returns 401', async () => {
    const res = await api('POST', '/api/auth/refresh');
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'NO_SESSION');
  });

  await t.test('unknown route returns structured 404', async () => {
    const res = await api('GET', '/api/does-not-exist', { cookies: user.cookies });
    assert.equal(res.status, 404);
    assert.equal(res.data.error.code, 'NOT_FOUND');
  });

  await t.test('log out revokes the refresh token (replay fails)', async () => {
    const before = await api('POST', '/api/auth/login', {
      body: { username: 'sec_user', password: 'password123' }
    });
    assert.equal(before.status, 200);

    await api('POST', '/api/auth/logout', { cookies: before.cookies });
    const replay = await api('POST', '/api/auth/refresh', {
      cookies: before.cookies + '; _=x'
    });
    assert.equal(replay.status, 401);

    const stillAuthed = await api('GET', '/api/auth/me', {
      cookies: before.cookies.replace(/salem_at=[^;]+/, '')
    });
    assert.notEqual(stillAuthed.status, 200);
  });

  await t.test('idempotent logout of a logged-out user is safe', async () => {
    const res = await api('POST', '/api/auth/logout', { cookies: user.cookies });
    assert.equal(res.status, 200);
  });
});

test('production config fails fast without secrets', async () => {
  const env = { ...process.env };
  delete env.JWT_SECRET;
  delete env.DATABASE_URL;
  delete env.APP_URL;
  env.NODE_ENV = 'production';
  env.PORT = '4000';
  const r = spawnSync(process.execPath, ['-e', 'require("./src/config"); console.log("SHOULD_NOT_RUN")'], {
    cwd: __dirname + '/..',
    env,
    encoding: 'utf8'
  });
  assert.notEqual(r.status, 0, 'config must exit(1) in production without secrets');
  assert.ok(!r.stdout.includes('SHOULD_NOT_RUN'));
  assert.ok(/أوقف التشغيل/.test(r.stderr));
});