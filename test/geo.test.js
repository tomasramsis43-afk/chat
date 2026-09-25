process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/geo');
const { startServer, closeServer, api } = require('./harness');

before(async () => {
  await startServer();
});

after(async () => {
  await closeServer();
});

test('countryForIp resolves known countries', () => {
  assert.equal(geo.countryForIp('41.64.0.12'), 'EG');
  assert.equal(geo.countryForIp('51.36.10.1'), 'SA');
  assert.equal(geo.countryForIp('8.8.8.8'), 'US');
  assert.equal(geo.countryForIp('127.0.0.1'), null);
  assert.equal(geo.countryForIp('192.168.1.1'), null);
  assert.equal(geo.countryForIp(''), null);
});

test('register stores country and timezone from forwarded ip + body timezone', async () => {
  const res = await api('POST', '/api/auth/register', {
    headers: { 'x-forwarded-for': '41.64.0.12' },
    body: { username: `geo_eg_${Date.now()}`, password: 'password123', timezone: 'Africa/Cairo' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.country, 'EG');
  assert.equal(res.data.user.tz_ip, 'Africa/Cairo');
  assert.equal(res.data.user.tz_local, 'Africa/Cairo');

  const me = await api('GET', '/api/auth/me', { cookies: res.cookies });
  assert.equal(me.data.user.country, 'EG');
  assert.equal(me.data.user.tz_ip, 'Africa/Cairo');
  assert.equal(me.data.user.tz_local, 'Africa/Cairo');
});

test('register without identifiable ip leaves country null', async () => {
  const res = await api('POST', '/api/auth/register', {
    headers: { 'x-forwarded-for': '127.0.0.1' },
    body: { username: `geo_noip_${Date.now()}`, password: 'password123' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.country, null);
  assert.equal(res.data.user.tz_ip, null);
  assert.equal(res.data.user.tz_local, null);
});

test('vpn scenario keeps mismatch between ip tz and browser tz', async () => {
  const res = await api('POST', '/api/auth/register', {
    headers: { 'x-forwarded-for': '51.36.10.1' },
    body: { username: `geo_vpn_${Date.now()}`, password: 'password123', timezone: 'Africa/Cairo' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.country, 'SA');
  assert.equal(res.data.user.tz_ip, 'Asia/Riyadh');
  assert.equal(res.data.user.tz_local, 'Africa/Cairo');
  assert.notEqual(res.data.user.tz_ip, res.data.user.tz_local);
});

test('users list includes country and search shows it', async () => {
  const fwd = '51.36.10.1';
  const aBody = { headers: { 'x-forwarded-for': fwd }, body: { username: `geo_a_${Date.now()}`, password: 'password123' } };
  const bBody = { headers: { 'x-forwarded-for': '41.64.0.12' }, body: { username: `geo_b_${Date.now()}`, password: 'password123' } };
  const a = await api('POST', '/api/auth/register', aBody);
  assert.equal(a.status, 201);
  const b = await api('POST', '/api/auth/register', bBody);
  assert.equal(b.status, 201);

  const list = await api('GET', '/api/users', { cookies: a.cookies });
  assert.equal(list.status, 200);
  const bIn = list.data.users.find((u) => u.id === b.data.user.id);
  assert.ok(bIn, 'searched user present');
  assert.equal(bIn.country, 'EG');

  const search = await api('GET', `/api/users?q=${encodeURIComponent(b.data.user.username.slice(0, 8))}&limit=8`, {
    cookies: a.cookies
  });
  const hit = (search.data.users || []).find((u) => u.id === b.data.user.id);
  assert.ok(hit, 'search hit found');
  assert.equal(hit.country, 'EG');
});

test('login refreshes country to most recent location', async () => {
  const name = `geo_l_${Date.now()}`;
  const reg = await api('POST', '/api/auth/register', {
    headers: { 'x-forwarded-for': '8.8.8.8' },
    body: { username: name, password: 'password123', timezone: 'America/New_York' }
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.country, 'US');
  assert.equal(reg.data.user.tz_local, 'America/New_York');

  const login = await api('POST', '/api/auth/login', {
    headers: { 'x-forwarded-for': '51.36.10.1' },
    body: { username: name, password: 'password123', timezone: 'Asia/Riyadh' }
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.country, 'SA');
  assert.equal(login.data.user.tz_ip, 'Asia/Riyadh');
  assert.equal(login.data.user.tz_local, 'Asia/Riyadh');

  const me = await api('GET', '/api/auth/me', { cookies: login.cookies });
  assert.equal(me.data.user.country, 'SA');
  assert.equal(me.data.user.tz_ip, 'Asia/Riyadh');
  assert.equal(me.data.user.tz_local, 'Asia/Riyadh');
});

