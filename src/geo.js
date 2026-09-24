let lookup = null;

function loadLookup() {
  if (lookup) return lookup;
  try {
    lookup = require('geoip-lite');
  } catch {
    lookup = null;
  }
  return lookup;
}

function firstForwarded(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return String(fwd).split(',')[0].trim();
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xr = req.headers['x-real-ip'];
  if (typeof xr === 'string' && xr.trim()) return xr.trim();
  return null;
}

function clientIp(req) {
  if (!req) return '';
  const forwarded = firstForwarded(req);
  if (forwarded) return forwarded;
  if (req.ip) return String(req.ip).replace(/^::ffff:/, '');
  return '';
}

function isValidIp(ip) {
  const n = String(ip || '').replace(/^::ffff:/, '');
  if (!n || n === '::1') return false;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(n)) return false;
  return true;
}

function countryForIp(ip) {
  const geo = loadLookup();
  if (!geo || !isValidIp(ip)) return null;
  const norm = String(ip).replace(/^::ffff:/, '');
  try {
    const r = geo.lookup(norm);
    if (!r || !r.country) return null;
    const code = String(r.country).toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

function countryForReq(req) {
  return countryForIp(clientIp(req));
}

module.exports = { clientIp, countryForIp, countryForReq };