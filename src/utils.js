const crypto = require('crypto');
const config = require('./config');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(s)) {
    const iso = s.includes('T') ? s : s.replace(' ', 'T');
    return iso.endsWith('Z') ? iso : new Date(iso + 'Z').toISOString();
  }
  return s;
}

function toInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const USERNAME_RE = /^[a-zA-Z0-9_\u0600-\u06FF\u0660-\u0669]{3,24}$/;

function validateUsername(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'BAD_REQUEST', 'الاسم غير صالح');
  const name = value.trim();
  if (!USERNAME_RE.test(name)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'الاسم يجب أن يكون 3-24 حرفًا (حروف/أرقام/شرطة سفلية فقط)'
    );
  }
  return name;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new ApiError(400, 'BAD_REQUEST', 'كلمة المرور يجب أن تكون 8-128 حرفًا');
  }
  return value;
}

function validateMessageContent(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'BAD_REQUEST', 'رسالة غير صالحة');
  const text = value.trim();
  if (!text || text.length > config.limits.msgMaxLength) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `الرسالة يجب أن تكون 1-${config.limits.msgMaxLength} حرفًا`
    );
  }
  return text;
}

function validateId(value) {
  const n = toInt(value);
  if (!n || n < 1 || n > 2147483647) throw new ApiError(400, 'BAD_REQUEST', 'معرّف غير صالح');
  return n;
}

function validateNonnegInt(value) {
  const n = toInt(value);
  if (n === null) throw new ApiError(400, 'BAD_REQUEST', 'قيمة غير صالحة');
  return n;
}

function validateClientMsgId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length < 8 || value.length > 64) {
    throw new ApiError(400, 'BAD_REQUEST', 'معرّف رسالة غير صالح');
  }
  return value;
}

function clampInt(value, min, max, def) {
  const n = toInt(value);
  if (n === null) return def;
  return Math.min(max, Math.max(min, n));
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (m) => '\\' + m);
}

function dmKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function isUniqueViolation(err) {
  return (
    (err && err.code === '23505') ||
    (err && err.message && String(err.message).includes('UNIQUE'))
  );
}

function safeUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    avatar_color: row.avatar_color,
    avatar_url: row.avatar_url || null,
    country: row.country || null,
    tz_ip: row.tz_ip || null,
    tz_local: row.tz_local || null,
    created_at: toIso(row.created_at)
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    conversation_id: Number(row.conversation_id),
    sender_id: Number(row.sender_id),
    content: row.deleted_at ? null : row.content,
    kind: row.kind || 'text',
    media_url: row.media_url || null,
    media_name: row.media_name || null,
    media_size: row.media_size === null || row.media_size === undefined ? null : Number(row.media_size),
    media_mime: row.media_mime || null,
    reply_to_id: row.reply_to_id === null || row.reply_to_id === undefined ? null : Number(row.reply_to_id),
    created_at: toIso(row.created_at),
    edited_at: toIso(row.edited_at),
    deleted_at: toIso(row.deleted_at),
    deleted: !!row.deleted_at
  };
}

module.exports = {
  ApiError,
  parseCookies,
  randomToken,
  sha256Hex,
  toIso,
  toInt,
  validateUsername,
  validatePassword,
  validateMessageContent,
  validateId,
  validateNonnegInt,
  validateClientMsgId,
  clampInt,
  escapeLike,
  dmKey,
  isUniqueViolation,
  safeUser,
  mapMessage
};