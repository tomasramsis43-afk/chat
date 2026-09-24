const { test } = require('node:test');
const assert = require('node:assert/strict');
const revgeo = require('../src/revgeo');
const config = require('../src/config');

test('revgeo caching', async () => {
  revgeo.reset();
  let calls = 0;
  revgeo.setFetcher(async (lat, lon) => {
    calls++;
    if (lat === 0 && lon === 0) throw new Error('network down');
    return 'EG';
  });

  assert.equal(await revgeo.lookup(30.0444, 31.2357), 'EG');
  assert.equal(calls, 1);
  assert.equal(await revgeo.lookup(30.0444, 31.2357), 'EG');
  assert.equal(calls, 1);

  assert.equal(await revgeo.lookup(30.04439, 31.23572), 'EG');
  assert.equal(calls, 1);

  assert.equal(await revgeo.lookup(24.68, 46.68), 'EG');
  assert.equal(calls, 2);

  assert.equal(await revgeo.lookup(0, 0), null);
  assert.equal(calls, 3);
  assert.equal(await revgeo.lookup(0, 0), null);
  assert.equal(calls, 3);

  revgeo.flush();
  revgeo.reset();
  assert.equal(await revgeo.lookup(30.0444, 31.2357), 'EG');
  assert.equal(calls, 4);
  revgeo.reloadFromDisk();
  assert.equal(await revgeo.lookup(30.0444, 31.2357), 'EG');
  assert.equal(calls, 4);

  try {
    require('fs').unlinkSync(config.geoCacheFile);
  } catch {}
});

test('concurrent same-point lookups are deduplicated', async () => {
  revgeo.reset();
  let calls = 0;
  let release = null;
  const gate = new Promise((r) => (release = r));
  revgeo.setFetcher(async () => {
    calls++;
    await gate;
    return 'SA';
  });

  const p1 = revgeo.lookup(24.68, 46.68);
  await new Promise((r) => setTimeout(r, 20));
  const p2 = revgeo.lookup(24.68, 46.68);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, 'SA');
  assert.equal(b, 'SA');
  assert.equal(calls, 1);

  revgeo.reset();
});