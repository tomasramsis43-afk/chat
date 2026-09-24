'use strict';
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { ApiError, validateMessageContent } = require('./utils');
const { getStorage, LocalStorageProvider } = require('./storage');

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
};

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif'
]);

const FILENAME_RE = /^[0-9a-f]{32}\.[a-z0-9]{1,8}$/;

function setOf() {
  return ALLOWED_TYPES;
}

function isAllowedMime(mime) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, mime);
}

function isImageMime(mime) {
  return IMAGE_TYPES.has(mime);
}

function sanitizeFileName(raw) {
  if (typeof raw !== 'string') return 'ملف';
  const base = raw.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
  return base || 'ملف';
}

function extForMime(mime) {
  return ALLOWED_TYPES[mime] || 'bin';
}

// تُرجع المفتاح داخل التخزين (id) وليس مسارًا مطلقًا — يدعم Local و S3 معًا.
function resolveUpload(filename) {
  if (typeof filename !== 'string' || !FILENAME_RE.test(filename)) return null;
  return filename;
}

async function storeUpload(buffer, mime) {
  if (!isAllowedMime(mime)) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'نوع الملف غير مدعوم');
  if (!buffer || buffer.length < 1) throw new ApiError(400, 'BAD_REQUEST', 'الملف فارغ');
  if (buffer.length > config.limits.uploadMaxBytes) {
    throw new ApiError(413, 'TOO_LARGE', 'الملف أكبر من الحد المسموح (5MB)');
  }
  const filename = crypto.randomBytes(16).toString('hex') + '.' + extForMime(mime);
  const storage = getStorage();
  await storage.put(filename, buffer, mime);
  return filename;
}

async function serveUpload(req, res, next) {
  const key = resolveUpload(req.params.file);
  if (!key) {
    return next(new ApiError(404, 'NOT_FOUND', 'الملف غير موجود'));
  }
  const storage = getStorage();
  try {
    const stat = await storage.stat(key);
    if (!stat.exists) {
      return next(new ApiError(404, 'NOT_FOUND', 'الملف غير موجود'));
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    const mime = mimeFromPath(key);
    if (isImageMime(mime)) {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', String(stat.size));
      if (storage instanceof LocalStorageProvider) {
        res.sendFile(path.join(storage.dir, key));
      } else {
        const r = await storage.request('GET', key);
        r.body.pipe(res);
      }
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment');
      if (storage instanceof LocalStorageProvider) {
        res.sendFile(path.join(storage.dir, key));
      } else {
        const r = await storage.request('GET', key);
        r.body.pipe(res);
      }
    }
  } catch (err) {
    next(err);
  }
}

function mimeFromPath(filename) {
  const ext = String(filename).split('.').pop().toLowerCase();
  for (const [mime, e] of Object.entries(ALLOWED_TYPES)) {
    if (e === ext) return mime;
  }
  return 'application/octet-stream';
}

function validateMediaPayload(data) {
  const kind = data.kind === undefined || data.kind === null ? 'text' : String(data.kind);
  if (kind !== 'text' && kind !== 'image' && kind !== 'file') {
    throw new ApiError(400, 'BAD_REQUEST', 'نوع الرسالة غير صالح');
  }
  if (kind === 'text') {
    const content = validateMessageContent(data.content);
    return {
      kind: 'text',
      content,
      mediaUrl: null,
      mediaName: null,
      mediaSize: null,
      mediaMime: null
    };
  }
  const raw = typeof data.content === 'string' ? data.content : '';
  const content = raw.trim() ? validateMessageContent(raw) : '';
  const mediaUrl = data.mediaUrl === undefined ? null : data.mediaUrl;
  const mediaName = sanitizeFileName(data.mediaName);
  const mediaSize = Number(data.mediaSize);
  const mediaMime = data.mediaMime === undefined ? null : String(data.mediaMime);
  if (typeof mediaUrl !== 'string' || !/^\/uploads\/[0-9a-f]{32}\.[a-z0-9]{1,8}$/.test(mediaUrl)) {
    throw new ApiError(400, 'BAD_REQUEST', 'رابط المرفق غير صالح');
  }
  if (!mediaName || mediaName.length > 200) {
    throw new ApiError(400, 'BAD_REQUEST', 'اسم الملف غير صالح');
  }
  if (!Number.isInteger(mediaSize) || mediaSize < 1 || mediaSize > config.limits.uploadMaxBytes) {
    throw new ApiError(400, 'BAD_REQUEST', 'حجم الملف غير صالح');
  }
  if (!mediaMime || !isAllowedMime(mediaMime)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'نوع الملف غير مدعوم');
  }
  return { kind, content, mediaUrl, mediaName, mediaSize, mediaMime };
}

module.exports = {
  ALLOWED_TYPES,
  IMAGE_TYPES,
  isAllowedMime,
  isImageMime,
  sanitizeFileName,
  extForMime,
  resolveUpload,
  storeUpload,
  serveUpload,
  mimeFromPath,
  validateMediaPayload,
  FILENAME_RE
};