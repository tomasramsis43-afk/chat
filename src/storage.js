'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { Readable } = require('stream');
const config = require('./config');

class StorageError extends Error {}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function safeKey(key) {
  if (
    typeof key !== 'string' ||
    !key.length ||
    key.length > 255 ||
    key.includes('..') ||
    key.includes('\\') ||
    key.startsWith('/') ||
    key.includes('\u0000')
  ) {
    throw new StorageError('invalid storage key');
  }
  return key;
}

function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function collapseWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(String(params[k]))}`)
    .join('&');
}

// AWS Signature Version 4 request signer (zero-dependency).
function signV4(opts) {
  const method = String(opts.method || 'GET').toUpperCase();
  const host = String(opts.host || '');
  const reqPath = String(opts.path || '/');
  const query = opts.query || {};
  const headers = { ...(opts.headers || {}) };
  const payload = Buffer.isBuffer(opts.payload) ? opts.payload : Buffer.from(String(opts.payload || ''), 'utf8');
  const region = String(opts.region || 'us-east-1');
  const service = String(opts.service || 's3');
  const accessKeyId = String(opts.accessKeyId || '');
  const secretAccessKey = String(opts.secretAccessKey || '');
  const date = opts.date instanceof Date ? opts.date : new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const normalized = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = collapseWhitespace(v);
  }
  if (!normalized['x-amz-date']) normalized['x-amz-date'] = amzDate;
  if (!normalized['host'] && host) normalized['host'] = host;

  const payloadHash = payload.length ? sha256hex(payload) : EMPTY_SHA256;

  const headerNames = Object.keys(normalized).sort();
  const canonicalHeaders = headerNames.map((n) => `${n}:${normalized[n]}`).join('\n') + '\n';
  const signedHeaders = headerNames.join(';');

  const canonicalRequest = [
    method,
    reqPath,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return {
    amzDate,
    payloadHash,
    canonicalHeaders,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    scope,
    signature,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

class LocalStorageProvider {
  constructor(dir) {
    this.dir = path.resolve(dir || config.storage.localDir || config.uploadDir);
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  resolve(key) {
    return path.join(this.dir, safeKey(key));
  }

  async put(key, buffer, mime) {
    safeKey(key);
    await this.init();
    const abs = this.resolve(key);
    const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    await fsp.writeFile(tmp, buffer, { flag: 'wx' });
    await fsp.rename(tmp, abs);
    return { size: buffer.length };
  }

  async get(key) {
    return fsp.readFile(this.resolve(key));
  }

  async stat(key) {
    try {
      const st = await fsp.stat(this.resolve(key));
      return { exists: true, size: st.size };
    } catch {
      return { exists: false, size: 0 };
    }
  }

  async exists(key) {
    return (await this.stat(key)).exists;
  }

  readStream(key) {
    return fs.createReadStream(this.resolve(key));
  }

  async remove(key) {
    await fsp.unlink(this.resolve(key)).catch(() => {});
  }
}

class S3StorageProvider {
  constructor(opts) {
    this.endpoint = String(opts.endpoint || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(this.endpoint)) this.endpoint = 'https://' + this.endpoint;
    this.region = String(opts.region || 'us-east-1');
    this.bucket = String(opts.bucket || '');
    this.accessKeyId = String(opts.accessKeyId || '');
    this.secretAccessKey = String(opts.secretAccessKey || '');
    this.forcePathStyle = opts.forcePathStyle !== false;
    if (!this.accessKeyId || !this.secretAccessKey || !this.bucket) {
      throw new StorageError('S3 provider requires endpoint, bucket and access keys');
    }
  }

  async init() {}

  requestUrlAndPath(key) {
    safeKey(key);
    if (this.forcePathStyle) {
      const url = `${this.endpoint}/${uriEncode(this.bucket)}/${uriEncode(key)}`;
      return { url, path: `/${uriEncode(this.bucket)}/${uriEncode(key)}` };
    }
    const hostPart = this.endpoint.replace(/^https?:\/\//, '');
    const scheme = this.endpoint.startsWith('http://') ? 'http://' : 'https://';
    const url = `${scheme}${this.bucket}.${hostPart}/${uriEncode(key)}`;
    return { url, path: `/${uriEncode(key)}` };
  }

  async request(method, key, opts) {
    const { url, path } = this.requestUrlAndPath(key);
    const urlObj = new URL(url);
    const host = urlObj.host;
    const payload = opts && opts.payload ? Buffer.from(opts.payload) : Buffer.alloc(0);
    const extra = { ...(opts && opts.headers ? opts.headers : {}) };
    extra['x-amz-content-sha256'] = payload.length ? sha256hex(payload) : EMPTY_SHA256;
    const signed = signV4({
      method,
      host,
      path,
      query: {},
      headers: extra,
      payload,
      region: this.region,
      service: 's3',
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey
    });
    const reqHeaders = { ...extra, host, authorization: signed.authorization };
    const res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: method === 'PUT' || method === 'POST' ? payload : undefined,
      signal: AbortSignal.timeout(30000)
    });
    if (res.status >= 400) {
      const body = await res.text().catch(() => '');
      throw new StorageError(`s3 ${method} ${key} failed: ${res.status} ${body.slice(0, 500)}`);
    }
    return res;
  }

  async put(key, buffer, mime) {
    const headers = { 'content-length': String(buffer.length) };
    if (mime) headers['content-type'] = mime;
    const res = await this.request('PUT', key, { payload: buffer, headers });
    return { size: buffer.length, etag: res.headers.get('etag') || null };
  }

  async get(key) {
    const res = await this.request('GET', key);
    return Buffer.from(await res.arrayBuffer());
  }

  async stat(key) {
    try {
      const res = await this.request('HEAD', key);
      return {
        exists: true,
        size: Number(res.headers.get('content-length') || 0),
        contentType: res.headers.get('content-type') || null
      };
    } catch (err) {
      if (err instanceof StorageError && /(404|403|NoSuchKey)/.test(err.message)) {
        return { exists: false, size: 0, contentType: null };
      }
      throw err;
    }
  }

  async exists(key) {
    return (await this.stat(key)).exists;
  }

  async readStream(key) {
    const res = await this.request('GET', key);
    return Readable.fromWeb(res.body);
  }

  async remove(key) {
    await this.request('DELETE', key).catch(() => {});
  }
}

let storage = null;

function createStorage(options) {
  const cfg = options || config.storage;
  if (cfg.provider === 's3') {
    return new S3StorageProvider({
      endpoint: cfg.s3.endpoint,
      region: cfg.s3.region,
      bucket: cfg.s3.bucket,
      accessKeyId: cfg.s3.accessKeyId,
      secretAccessKey: cfg.s3.secretAccessKey,
      forcePathStyle: cfg.s3.forcePathStyle
    });
  }
  return new LocalStorageProvider(cfg.localDir || config.uploadDir);
}

function getStorage() {
  if (!storage) storage = createStorage();
  return storage;
}

async function initStorage() {
  const s = getStorage();
  await s.init();
}

module.exports = {
  StorageError,
  LocalStorageProvider,
  S3StorageProvider,
  signV4,
  uriEncode,
  sha256hex,
  EMPTY_SHA256,
  createStorage,
  getStorage,
  initStorage
};