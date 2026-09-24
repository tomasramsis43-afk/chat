const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { randomToken } = require('./utils');

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const STATE_TTL_MS = 5 * 60 * 1000;

const states = new Map();

function cleanupStates() {
  const now = Date.now();
  for (const [key, exp] of states) {
    if (exp <= now) states.delete(key);
  }
}

function createState() {
  cleanupStates();
  const state = randomToken(24);
  states.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeState(state) {
  if (!state) return false;
  const valid = states.has(state) && states.get(state) > Date.now();
  states.delete(state);
  return valid;
}

function authorizeUrl(redirectUri) {
  const state = createState();
  const p = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    nonce: randomToken(12)
  });
  return { state, url: `${AUTHORIZE_URL}?${p.toString()}` };
}

let jwksCache = null;

async function getCerts() {
  if (jwksCache) return jwksCache;
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('GOOGLE_CERTS_FAILED');
  const body = await res.json();
  const map = new Map();
  for (const key of body.keys || []) {
    if (key.kid && key.x5c && key.x5c[0]) {
      map.set(key.kid, certPem(key.x5c[0]));
    }
  }
  jwksCache = map;
  setTimeout(() => { jwksCache = null; }, 60 * 60 * 1000);
  return map;
}

function certPem(b64der) {
  const der = Buffer.from(b64der, 'base64');
  const pem = `-----BEGIN CERTIFICATE-----\n${der
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END CERTIFICATE-----`;
  return new crypto.X509Certificate(pem).publicKey;
}

async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error('GOOGLE_EXCHANGE_FAILED');
  return data;
}

async function verifyIdToken(idToken) {
  const header = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString('utf8'));
  const certs = await getCerts();
  const key = certs.get(header.kid);
  if (!key) throw new Error('GOOGLE_UNKNOWN_KEY');
  return jwt.verify(idToken, key, {
    algorithms: ['RS256'],
    issuer: ['accounts.google.com', 'https://accounts.google.com'],
    audience: config.google.clientId
  });
}

function usernameFromEmail(email) {
  let base = (email.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (base.length < 3) base = `user_${base}`;
  return base.slice(0, 20);
}

module.exports = {
  authorizeUrl,
  consumeState,
  exchangeCode,
  verifyIdToken,
  usernameFromEmail
};