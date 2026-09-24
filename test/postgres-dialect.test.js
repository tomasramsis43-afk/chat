const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');

test('login country/tz UPDATE casts all CASE/COALESCE params for Postgres', () => {
  const start = authSource.indexOf('if (country || tzIp) {');
  const end = authSource.indexOf('WHERE id = $1', start);
  const sql = authSource.slice(start, end);
  assert.match(sql, /CAST\(\$2 AS TEXT\) IS NOT NULL/);
  assert.match(sql, /country_source <> CAST\(\$3 AS TEXT\)/);
  assert.match(sql, /COALESCE\(CAST\(\$4 AS TEXT\), tz_ip\)/);
  assert.match(sql, /THEN CAST\(\$5 AS TEXT\) ELSE country_source/);
  assert.doesNotMatch(sql, /THEN \$2(?! AS TEXT)/);
  assert.doesNotMatch(sql, /COALESCE\(\$4(?![,)]* AS TEXT)/);
});

test('google user UPDATE casts all CASE/COALESCE params for Postgres', () => {
  const start = authSource.indexOf('email = COALESCE(email,');
  const end = authSource.indexOf('if (country || tzIp) {');
  const sql = authSource.slice(start, end);
  assert.match(sql, /COALESCE\(email, CAST\(\$2 AS TEXT\)\)/);
  assert.match(sql, /COALESCE\(google_sub, CAST\(\$3 AS TEXT\)\)/);
  assert.match(sql, /COALESCE\(avatar_url, CAST\(\$4 AS TEXT\)\)/);
  assert.match(sql, /CAST\(\$5 AS TEXT\) IS NOT NULL/);
  assert.match(sql, /COALESCE\(tz_ip, CAST\(\$6 AS TEXT\)\)/);
  assert.match(sql, /COALESCE\(tz_local, CAST\(\$7 AS TEXT\)\)/);
});