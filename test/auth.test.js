const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer,
  closeServer,
  api,
  registerUser,
  loginUser,
  loginUserOk
} = require('./harness');

test('auth suite', async (t) => {
  await startServer();
  t.after(closeServer);

  await t.test('register creates user with httpOnly cookies', async () => {
    const { user, cookies } = await registerUser('ali_test');
    assert.equal(typeof user.id, 'number');
    assert.equal(user.username, 'ali_test');
    assert.ok(cookies.includes('salem_at='));
    assert.ok(cookies.includes('salem_rt='));

    const me = await api('GET', '/api/auth/me', { cookies });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, 'ali_test');
  });

  await t.test('register rejects duplicate username', async () => {
    const res = await api('POST', '/api/auth/register', {
      body: { username: 'ali_test', password: 'password123' }
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'USERNAME_TAKEN');
  });

  await t.test('register rejects weak username and password', async () => {
    const shortUser = await api('POST', '/api/auth/register', {
      body: { username: 'ab', password: 'password123' }
    });
    assert.equal(shortUser.status, 400);

    const shortPass = await api('POST', '/api/auth/register', {
      body: { username: 'sana_w', password: '123' }
    });
    assert.equal(shortPass.status, 400);
  });

  await t.test('register stores gender (male/female) and returns it', async () => {
    const male = await api('POST', '/api/auth/register', {
      body: { username: 'ahmad_g', password: 'password123', gender: 'male' }
    });
    assert.equal(male.status, 201);
    assert.equal(male.data.user.gender, 'male');

    const female = await api('POST', '/api/auth/register', {
      body: { username: 'mariam_g', password: 'password123', gender: 'female' }
    });
    assert.equal(female.status, 201);
    assert.equal(female.data.user.gender, 'female');

    const me = await api('GET', '/api/auth/me', { cookies: male.cookies });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.gender, 'male');

    const login = await loginUser('ahmad_g');
    assert.equal(login.status, 200);
    assert.equal(login.data.user.gender, 'male');
  });

  await t.test('register without gender stores null', async () => {
    const res = await api('POST', '/api/auth/register', {
      body: { username: 'nogene_u', password: 'password123' }
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.gender, null);

    const me = await api('GET', '/api/auth/me', { cookies: res.cookies });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.gender, null);
  });

  await t.test('register rejects invalid gender', async () => {
    const res = await api('POST', '/api/auth/register', {
      body: { username: 'bogus_g', password: 'password123', gender: 'other' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'BAD_GENDER');
  });

  await t.test('register is case-insensitive for username uniqueness', async () => {
    const res = await api('POST', '/api/auth/register', {
      body: { username: 'ALI_TEST', password: 'password123' }
    });
    assert.equal(res.status, 409);
  });

  await t.test('login succeeds with valid credentials', async () => {
    const res = await loginUser('ali_test');
    assert.equal(res.status, 200);
    assert.equal(res.data.user.username, 'ali_test');
    assert.ok(res.cookies.includes('salem_at='));
  });

  await t.test('login returns generic error for unknown user and wrong password', async () => {
    const unknown = await loginUser('nobody_xyz');
    assert.equal(unknown.status, 401);
    assert.equal(unknown.data.error.code, 'INVALID_CREDENTIALS');

    const wrongPass = await loginUser('ali_test', 'wrongpass1');
    assert.equal(wrongPass.status, 401);
    assert.equal(wrongPass.data.error.message, unknown.data.error.message);
  });

  await t.test('refresh rotates the token and rejects replay of old one', async () => {
    const { cookies: c0 } = await loginUserOk('ali_test');

    const ref1 = await api('POST', '/api/auth/refresh', { cookies: c0 });
    assert.equal(ref1.status, 200);
    const c1 = ref1.cookies;
    assert.ok(c1 && c1.length > 0);
    assert.notEqual(c1, c0);

    const meAfter = await api('GET', '/api/auth/me', { cookies: c1 });
    assert.equal(meAfter.status, 200);

    const replay = await api('POST', '/api/auth/refresh', { cookies: c0 });
    assert.equal(replay.status, 401);
  });

  await t.test('logout revokes session server-side', async () => {
    const { cookies } = await loginUserOk('ali_test');

    const out1 = await api('POST', '/api/auth/logout', { cookies });
    assert.equal(out1.status, 200);

    const replay = await api('POST', '/api/auth/refresh', { cookies });
    assert.equal(replay.status, 401);
  });

  await t.test('me requires authentication', async () => {
    const res = await api('GET', '/api/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'UNAUTHORIZED');
  });

  await t.test('refresh without cookie is rejected', async () => {
    const res = await api('POST', '/api/auth/refresh');
    assert.equal(res.status, 401);
  });

  await t.test('google start returns 400 when google is not configured', async () => {
    const res = await api('GET', '/api/auth/google/start');
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'GOOGLE_DISABLED');
  });

  await t.test('google callback redirects with error when disabled', async () => {
    const s = await startServer();
    const res = await fetch(`${s.base}/api/auth/google/callback?state=x&code=y`, {
      redirect: 'manual'
    });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.searchParams.get('auth'), 'google');
    assert.equal(loc.searchParams.get('status'), 'error');
    assert.equal(loc.searchParams.get('code'), 'GOOGLE_DISABLED');
  });
});