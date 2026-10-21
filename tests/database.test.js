const test = require('node:test');
const assert = require('node:assert/strict');
const { postgresPlaceholders } = require('../database');

test('PostgreSQL query conversion preserves quoted question marks and normalizes SQLite syntax', () => {
  const sql = postgresPlaceholders(
    "SELECT id AS userId, COUNT(*) AS unreadCount, CAST(ROUND(price) AS INTEGER) AS estimatedTotalUsdCents FROM users WHERE email = ? COLLATE NOCASE AND note = '?' AND created_at >= date('now') ORDER BY rowid"
  );

  assert.match(sql, /id AS "userId"/);
  assert.match(sql, /COUNT\(\*\) AS "unreadCount"/);
  assert.match(sql, /CAST\(ROUND\(price\) AS INTEGER\) AS "estimatedTotalUsdCents"/);
  assert.match(sql, /email = \$1\s+AND note = '\?'/);
  assert.match(sql, /created_at >= CURRENT_DATE::TEXT/);
  assert.match(sql, /ORDER BY id$/);
});
