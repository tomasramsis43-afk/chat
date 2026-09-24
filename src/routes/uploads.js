const { Router } = require('express');
const db = require('../db');
const { ApiError, validateId } = require('../utils');
const { requireAuth, uploadLimiter } = require('../middleware');
const {
  isAllowedMime,
  sanitizeFileName,
  storeUpload
} = require('../uploads');

const router = Router();

async function assertMember(convId, userId) {
  const rows = await db.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [convId, userId]
  );
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'المحادثة غير موجودة');
}

const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/;

function parseBase64Payload(data) {
  if (typeof data !== 'string' || !data) {
    throw new ApiError(400, 'BAD_REQUEST', 'بيانات الملف مطلوبة');
  }
  const idx = data.indexOf('base64,');
  let b64 = idx >= 0 ? data.slice(idx + 7) : data;
  b64 = b64.replace(/\s+/g, '');
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new ApiError(400, 'BAD_REQUEST', 'بيانات الملف غير صالحة');
  }
  return Buffer.from(b64, 'base64');
}

router.post('/:id/attachments', requireAuth, uploadLimiter, async (req, res, next) => {
  try {
    const convId = validateId(req.params.id);
    await assertMember(convId, req.user.id);

    const mime = String(req.body.type || '');
    if (!isAllowedMime(mime)) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'نوع الملف غير مدعوم');
    }
    const name = sanitizeFileName(req.body.name);
    const buffer = parseBase64Payload(req.body.data);

    const filename = await storeUpload(buffer, mime);
    res.status(201).json({
      attachment: {
        url: `/uploads/${filename}`,
        name,
        size: buffer.length,
        mime
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;