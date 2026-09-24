const fs = require('fs');
const path = require('path');
const config = require('./config');

const REVERSE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

const ROUND = 3;
const POSITIVE_TTL = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 15 * 60 * 1000;
const MAX_ENTRIES = 5000;

let memory = new Map();
let pending = new Map();
let saveTimer = null;
let fetchImpl = rawFetch;

function setFetcher(fn) {
  fetchImpl = typeof fn === 'function' ? fn : rawFetch;
}

function loadDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.geoCacheFile, 'utf8'));
    if (!Array.isArray(raw)) return;
    memory = new Map();
    for (const [key, code, expires] of raw) {
      if (typeof key === 'string' && expires > Date.now()) {
        memory.set(key, { code: code || null, expires });
      }
    }
  } catch {
    memory = new Map();
  }
}

loadDisk();

function keyFor(lat, lon) {
  const la = (Math.round(lat * 1000) / 1000).toFixed(ROUND);
  const lo = (Math.round(lon * 1000) / 1000).toFixed(ROUND);
  return `${la},${lo}`;
}

async function rawFetch(lat, lon) {
  const u = new URL(REVERSE_URL);
  u.searchParams.set('latitude', String(lat));
  u.searchParams.set('longitude', String(lon));
  u.searchParams.set('localityLanguage', 'ar');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(u.toString(), {
      signal: ac.signal,
      headers: { accept: 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const code = String(data.countryCode || '').toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : null;
  } finally {
    clearTimeout(timer);
  }
}

function evictOldest() {
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [key, entry] of memory) {
    if (entry.expires < oldestAt) {
      oldestAt = entry.expires;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) memory.delete(oldestKey);
}

function store(key, code, ttl) {
  const expires = Date.now() + (code ? ttl : NEGATIVE_TTL);
  if (memory.size >= MAX_ENTRIES) evictOldest();
  memory.set(key, { code, expires });
  schedulePersist();
}

function schedulePersist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 5000);
  if (saveTimer.unref) saveTimer.unref();
}

function flush() {
  const data = [];
  for (const [key, entry] of memory) data.push([key, entry.code, entry.expires]);
  try {
    fs.mkdirSync(path.dirname(config.geoCacheFile), { recursive: true });
    const tmp = config.geoCacheFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, config.geoCacheFile);
  } catch {}
}

function reset() {
  memory = new Map();
  pending = new Map();
}

function reloadFromDisk() {
  memory = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(config.geoCacheFile, 'utf8'));
    if (Array.isArray(raw)) {
      for (const [key, code, expires] of raw) {
        if (expires > Date.now()) memory.set(key, { code: code || null, expires });
      }
    }
  } catch {}
}

async function lookup(lat, lon) {
  const key = keyFor(lat, lon);
  const hit = memory.get(key);
  if (hit) {
    if (hit.expires > Date.now()) return hit.code;
    memory.delete(key);
  }
  if (pending.has(key)) return pending.get(key);

  const p = (async () => {
    try {
      const code = await fetchImpl(lat, lon);
      store(key, code, POSITIVE_TTL);
      return code;
    } catch {
      store(key, null, NEGATIVE_TTL);
      return null;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, p);
  return p;
}

if (typeof process !== 'undefined') {
  const shutdown = () => flush();
  process.once('beforeExit', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { lookup, rawFetch, setFetcher, flush, reset, reloadFromDisk, keyFor };