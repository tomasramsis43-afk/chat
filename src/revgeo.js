const REVERSE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

async function lookup(lat, lon) {
  try {
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
  } catch {
    return null;
  }
}

module.exports = { lookup };