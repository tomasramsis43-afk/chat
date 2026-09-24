'use strict';
const config = require('./config');

const LEVELS = { error: 0, warn: 1, info: 2, http: 3, debug: 4 };

const REDACT_RE =
  /(password|passwd|secret|token|authorization|cookie|set-cookie|refresh|jwt|id_token|idtoken|access_key|private_key|signature)/i;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error) && !Buffer.isBuffer(v);
}

function redactValue(value, key) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') {
    return REDACT_RE.test(String(key)) && value.length > 0 ? '[REDACTED]' : value;
  }
  if (Buffer.isBuffer(value)) return `Buffer(${value.length})`;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map((v) => redactValue(v, key));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[redactKeyName(k)] = redactValue(v, k);
    return out;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function redactKeyName(key) {
  return REDACT_RE.test(String(key)) ? 'redacted' : key;
}

function timestamp() {
  return new Date().toISOString();
}

function serialize(level, msg, fields) {
  const safe = redactValue(fields || {}, '');
  if (config.logging.json) {
    return JSON.stringify({ ts: timestamp(), level, msg, ...safe });
  }
  const extra = isPlainObject(safe) && Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
  return `[${timestamp()}] ${level.toUpperCase()} [salem] ${msg}${extra}`;
}

function emit(level, msg, fields) {
  const idx = LEVELS[level];
  const threshold = LEVELS[config.logging.level];
  if (idx === undefined || threshold === undefined || idx > threshold) return;
  const line = serialize(level, msg, fields);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  error: (msg, fields) => emit('error', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  http: (msg, fields) => emit('http', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
  serialize,
  LEVELS
};