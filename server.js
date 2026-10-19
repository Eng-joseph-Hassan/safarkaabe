const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { DatabaseSync } = require('node:sqlite');

const root = __dirname;
const dataDir = path.resolve(process.env.SAFAR_KAABE_DATA_DIR || path.join(root, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'safar-kaabe.sqlite'));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const sessionMaxAge = 60 * 60 * 24 * 7;
const passwordLength = 64;
const passwordResetCodeTtlMs = 10 * 60 * 1000;
const passwordResetRateWindowMs = 15 * 60 * 1000;
const passwordResetRequestLimit = 5;
const passwordResetAttemptsLimit = 5;
const passwordResetSender = process.env.SMTP_FROM || 'engjoseph250@gmail.com';
const passwordResetRateLimits = new Map();
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS agencies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('BASIC', 'PROFESSIONAL', 'ENTERPRISE')),
    markup_pct REAL NOT NULL CHECK (markup_pct BETWEEN 0 AND 100),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    is_approved INTEGER NOT NULL DEFAULT 1 CHECK (is_approved IN (0, 1)),
    logo_mime TEXT,
    logo_data TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    phone TEXT,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'AGENCY', 'CLIENT')),
    agency_id TEXT REFERENCES agencies(id),
    avatar_mime TEXT,
    avatar_data TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agency_clients (
    id TEXT PRIMARY KEY,
    agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    pnr TEXT NOT NULL,
    agency_id TEXT NOT NULL REFERENCES agencies(id),
    customer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    traveler_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    offer_title TEXT NOT NULL,
    category TEXT NOT NULL,
    payment_provider TEXT NOT NULL,
    state TEXT NOT NULL,
    financials_json TEXT NOT NULL,
    travel_date TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS catalog_products (
    id TEXT PRIMARY KEY,
    agency_id TEXT NOT NULL REFERENCES agencies(id),
    title TEXT NOT NULL,
    title_so TEXT NOT NULL,
    category TEXT NOT NULL,
    destination TEXT NOT NULL,
    route_badge TEXT NOT NULL,
    specs TEXT NOT NULL,
    supplier_name TEXT NOT NULL,
    supplier_ref TEXT NOT NULL UNIQUE,
    base_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL,
    supplier_commission_pct REAL NOT NULL,
    available INTEGER NOT NULL DEFAULT 1 CHECK (available >= 0),
    travel_date TEXT,
    baggage TEXT NOT NULL DEFAULT '',
    is_published INTEGER NOT NULL DEFAULT 1 CHECK (is_published IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_reset_otps (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    agency_id TEXT REFERENCES agencies(id) ON DELETE CASCADE,
    customer_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    last_message_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS agency_clients_tenant_idx ON agency_clients(agency_id);
  CREATE INDEX IF NOT EXISTS conversations_agency_idx ON conversations(agency_id, last_message_at);
  CREATE INDEX IF NOT EXISTS conversations_customer_idx ON conversations(customer_id, last_message_at);
  CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(conversation_id, created_at);
`);

const agencyColumns = new Set(db.prepare('PRAGMA table_info(agencies)').all().map(column => column.name));
if (!agencyColumns.has('is_approved')) {
  db.exec('ALTER TABLE agencies ADD COLUMN is_approved INTEGER NOT NULL DEFAULT 1 CHECK (is_approved IN (0, 1))');
}
for (const [column, definition] of [['logo_mime', 'TEXT'], ['logo_data', 'TEXT']]) {
  if (!agencyColumns.has(column)) db.exec(`ALTER TABLE agencies ADD COLUMN ${column} ${definition}`);
}
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
for (const [column, definition] of [['avatar_mime', 'TEXT'], ['avatar_data', 'TEXT']]) {
  if (!userColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
}
const catalogColumns = new Set(db.prepare('PRAGMA table_info(catalog_products)').all().map(column => column.name));
for (const [column, definition] of [
  ['available', 'INTEGER NOT NULL DEFAULT 1 CHECK (available >= 0)'],
  ['travel_date', 'TEXT'],
  ['baggage', "TEXT NOT NULL DEFAULT ''"],
  ['is_published', 'INTEGER NOT NULL DEFAULT 1 CHECK (is_published IN (0, 1))']
]) {
  if (!catalogColumns.has(column)) db.exec(`ALTER TABLE catalog_products ADD COLUMN ${column} ${definition}`);
}
const bookingColumns = new Set(db.prepare('PRAGMA table_info(bookings)').all().map(column => column.name));
if (!bookingColumns.has('travel_date')) db.exec('ALTER TABLE bookings ADD COLUMN travel_date TEXT');

const nowIso = () => new Date().toISOString();
const randomCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

function runInTransaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const demoAgencyIds = [
  'ag_east_africa', 'ag_sky_team', 'ag_best_fly', 'ag_airsom', 'ag_daruuro',
  'ag_transom', 'ag_damal', 'ag_asal', 'ag_safe', 'ag_mashad', 'ag_halla',
  'ag_taaj', 'ag_air_som_2'
];
const demoAgencyPlaceholders = demoAgencyIds.map(() => '?').join(', ');
const protectedDemoAgencyIds = new Set(
  db.prepare(`SELECT DISTINCT agency_id FROM users WHERE agency_id IN (${demoAgencyPlaceholders})`)
    .all(...demoAgencyIds)
    .map(row => row.agency_id)
);
const removableDemoAgencyIds = demoAgencyIds.filter(id => !protectedDemoAgencyIds.has(id));
if (removableDemoAgencyIds.length) {
  const placeholders = removableDemoAgencyIds.map(() => '?').join(', ');
  runInTransaction(() => {
    db.prepare(`DELETE FROM bookings WHERE agency_id IN (${placeholders})`).run(...removableDemoAgencyIds);
    db.prepare(`DELETE FROM conversations WHERE agency_id IN (${placeholders})`).run(...removableDemoAgencyIds);
    db.prepare(`DELETE FROM agency_clients WHERE agency_id IN (${placeholders})`).run(...removableDemoAgencyIds);
    db.prepare(`
      DELETE FROM catalog_products
      WHERE agency_id IN (${placeholders}) OR id IN ('off_flt_01', 'off_flt_02', 'off_car_01')
    `).run(...removableDemoAgencyIds);
    db.prepare(`DELETE FROM agencies WHERE id IN (${placeholders})`).run(...removableDemoAgencyIds);
  });
}
db.prepare("DELETE FROM catalog_products WHERE id IN ('off_flt_01', 'off_flt_02', 'off_car_01')").run();

const mimeType = filePath => mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
const safeEqual = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const publicUser = user => ({
  id: user.id,
  email: user.email,
  name: user.name,
  phone: user.phone || '',
  role: user.role,
  agencyId: user.agency_id || null,
  avatarMime: user.avatar_mime || null,
  avatarData: user.avatar_data || null
});

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function readJson(request, maxBytes = 16_384) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Request must contain valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const separator = part.indexOf('=');
    return separator < 0 ? [part.trim(), ''] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }));
}

function audit(actorId, action, target) {
  db.prepare('INSERT INTO audit_logs (actor_id, action, target, created_at) VALUES (?, ?, ?, ?)').run(actorId || null, action, target, nowIso());
}

function createSession(user, response) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + sessionMaxAge;
  db.prepare('INSERT INTO sessions (id_hash, user_id, csrf_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), user.id, crypto.createHash('sha256').update(csrf).digest('hex'), expires, nowIso());
  response.setHeader('Set-Cookie', [
    `sk_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionMaxAge}${secureCookie}`,
    `sk_csrf=${csrf}; Path=/; SameSite=Strict; Max-Age=${sessionMaxAge}${secureCookie}`
  ]);
}

function getSession(request) {
  const token = parseCookies(request).sk_session;
  if (!token) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const record = db.prepare(`
    SELECT sessions.id_hash, sessions.csrf_hash, users.*
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id_hash = ? AND sessions.expires_at > ?
  `).get(hash, Math.floor(Date.now() / 1000));
  if (!record) return null;
  if (record.role === 'AGENCY' &&
      !db.prepare("SELECT id FROM agencies WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1").get(record.agency_id)) {
    return null;
  }
  return { user: record, session: record };
}

function authorizeMutation(request, response, session) {
  const origin = request.headers.origin;
  const expectedOrigin = `http://${request.headers.host}`;
  const expectedSecureOrigin = `https://${request.headers.host}`;
  if (origin && origin !== expectedOrigin && origin !== expectedSecureOrigin) {
    sendJson(response, 403, { error: 'Cross-origin requests are not allowed.' });
    return false;
  }
  const cookies = parseCookies(request);
  const token = request.headers['x-csrf-token'];
  const suppliedHash = typeof token === 'string' ? crypto.createHash('sha256').update(token).digest('hex') : '';
  if (!session || !safeEqual(cookies.sk_csrf || '', token || '') || !safeEqual(session.session.csrf_hash, suppliedHash)) {
    sendJson(response, 403, { error: 'Your session security token expired. Sign in again.' });
    return false;
  }
  return true;
}

function requireRole(response, user, roles) {
  if (!user) {
    sendJson(response, 401, { error: 'Sign in to continue.' });
    return false;
  }
  if (!roles.includes(user.role)) {
    sendJson(response, 403, { error: 'Your account does not have permission to perform this action.' });
    return false;
  }
  return true;
}

function requireString(value, field, maxLength = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw Object.assign(new Error(`${field} is required and must be no longer than ${maxLength} characters.`), { statusCode: 400 });
  }
  return value.trim();
}

function normalizeEmail(value) {
  const email = requireString(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Enter a valid email address.'), { statusCode: 400 });
  return email;
}

function isValidIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function getAccessibleConversation(id, user) {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conversation) return null;
  if (user.role === 'SUPER_ADMIN') return conversation;
  if (user.role === 'AGENCY' && conversation.agency_id === user.agency_id) return conversation;
  if (user.role === 'CLIENT' && conversation.customer_id === user.id) return conversation;
  return null;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) {
    throw Object.assign(new Error('Password must be at least 12 characters long.'), { statusCode: 400 });
  }
  return value;
}

function validateImageData(data, mime) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime) ||
      typeof data !== 'string' || data.length > 350_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw Object.assign(new Error('Choose a PNG, JPEG, or WebP image no larger than 256 KB.'), { statusCode: 400 });
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.length > 262_144) {
    throw Object.assign(new Error('The image must be no larger than 256 KB.'), { statusCode: 400 });
  }
  const isPng = mime === 'image/png' && bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  const isJpeg = mime === 'image/jpeg' && bytes.length >= 4 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  const isWebp = mime === 'image/webp' && bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!isPng && !isJpeg && !isWebp) {
    throw Object.assign(new Error('The selected file is not a valid PNG, JPEG, or WebP image.'), { statusCode: 400 });
  }
  return data;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, passwordLength, (error, derivedKey) => {
      if (error) reject(error);
      else resolve({ salt, hash: derivedKey.toString('hex') });
    });
  });
}

function passwordResetTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('SMTP_PORT must be a valid TCP port.'), { statusCode: 500 });
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: { user, pass }
  });
}

function allowPasswordResetRequest(key) {
  const now = Date.now();
  const entry = passwordResetRateLimits.get(key);
  if (!entry || entry.expiresAt <= now) {
    passwordResetRateLimits.set(key, { count: 1, expiresAt: now + passwordResetRateWindowMs });
    return true;
  }
  if (entry.count >= passwordResetRequestLimit) return false;
  entry.count += 1;
  return true;
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  const method = request.method || 'GET';
  const session = getSession(request);
  const user = session?.user || null;
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.origin;
    const expectedOrigin = `http://${request.headers.host}`;
    const expectedSecureOrigin = `https://${request.headers.host}`;
    if (origin && origin !== expectedOrigin && origin !== expectedSecureOrigin) {
      sendJson(response, 403, { error: 'Cross-origin requests are not allowed.' });
      return;
    }
  }

  if (method === 'GET' && pathname === '/api/setup/status') {
    const configured = Boolean(db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1").get());
    sendJson(response, 200, { configured });
    return;
  }

  if (method === 'POST' && pathname === '/api/setup/admin') {
    const body = await readJson(request);
    const name = requireString(body.name, 'Name');
    const email = normalizeEmail(body.email);
    const password = validatePassword(body.password);
    if (db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1").get()) {
      sendJson(response, 409, { error: 'Super Admin setup has already been completed. Sign in instead.' });
      return;
    }
    const credentials = await hashPassword(password);
    const admin = { id: crypto.randomUUID(), email, name, phone: '', role: 'SUPER_ADMIN', agency_id: null };
    runInTransaction(() => {
      if (db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1").get()) throw Object.assign(new Error('Super Admin setup has already been completed.'), { statusCode: 409 });
      db.prepare('INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(admin.id, admin.email, admin.name, '', credentials.salt, credentials.hash, admin.role, nowIso());
      audit(admin.id, 'INITIAL_SUPER_ADMIN_CREATED', admin.email);
    });
    createSession(admin, response);
    sendJson(response, 201, { user: publicUser(admin) });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/password-reset/request') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const ip = request.socket.remoteAddress || 'unknown';
    if (!allowPasswordResetRequest(`ip:${ip}`) || !allowPasswordResetRequest(`email:${email}`)) {
      sendJson(response, 429, { error: 'Too many reset requests. Wait 15 minutes and try again.' }, { 'Retry-After': '900' });
      return;
    }
    let transport;
    try {
      transport = passwordResetTransport();
    } catch (error) {
      console.error('Password reset SMTP configuration is invalid.', error);
      sendJson(response, 503, { error: 'Password reset email is unavailable. Contact the system administrator.' });
      return;
    }
    if (!transport) {
      sendJson(response, 503, { error: 'Password reset email is not configured. Ask the system administrator to configure SMTP.' });
      return;
    }
    const account = db.prepare('SELECT id, email FROM users WHERE email = ? COLLATE NOCASE').get(email);
    if (account) {
      const code = String(crypto.randomInt(100000, 1000000));
      const credentials = await hashPassword(code);
      const createdAt = Date.now();
      db.prepare(`
        INSERT INTO password_reset_otps (email, user_id, password_salt, password_hash, expires_at, attempts, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id,
          password_salt = excluded.password_salt, password_hash = excluded.password_hash,
          expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at
      `).run(email, account.id, credentials.salt, credentials.hash, createdAt + passwordResetCodeTtlMs, createdAt);
      try {
        await transport.sendMail({
          from: passwordResetSender,
          to: account.email,
          subject: 'Your SAFAR KAABE password reset code',
          text: `Your SAFAR KAABE password reset code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
          html: `<p>Your SAFAR KAABE password reset code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not request this, ignore this email.</p>`
        });
      } catch (error) {
        db.prepare('DELETE FROM password_reset_otps WHERE email = ?').run(email);
        console.error('Unable to deliver password reset email.', error);
        sendJson(response, 503, { error: 'The reset email could not be delivered. Try again later or contact support.' });
        return;
      }
    }
    sendJson(response, 200, { message: 'If an account uses that email, a verification code has been sent.' });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/password-reset/complete') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const code = typeof body.code === 'string' && /^\d{6}$/.test(body.code) ? body.code : '';
    const newPassword = validatePassword(body.newPassword);
    const reset = db.prepare('SELECT * FROM password_reset_otps WHERE email = ? COLLATE NOCASE').get(email);
    if (!reset || !code || reset.expires_at <= Date.now() || reset.attempts >= passwordResetAttemptsLimit) {
      if (reset && (reset.expires_at <= Date.now() || reset.attempts >= passwordResetAttemptsLimit)) {
        db.prepare('DELETE FROM password_reset_otps WHERE email = ?').run(email);
      }
      sendJson(response, 400, { error: 'The reset code is invalid or expired. Request a new code.' });
      return;
    }
    const supplied = await hashPassword(code, reset.password_salt);
    if (!safeEqual(supplied.hash, reset.password_hash)) {
      const attempts = reset.attempts + 1;
      db.prepare('UPDATE password_reset_otps SET attempts = ? WHERE email = ?').run(attempts, email);
      if (attempts >= passwordResetAttemptsLimit) db.prepare('DELETE FROM password_reset_otps WHERE email = ?').run(email);
      sendJson(response, 400, { error: 'The reset code is invalid or expired. Request a new code.' });
      return;
    }
    const credentials = await hashPassword(newPassword);
    runInTransaction(() => {
      db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
        .run(credentials.salt, credentials.hash, reset.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);
      db.prepare('DELETE FROM password_reset_otps WHERE email = ?').run(email);
      audit(reset.user_id, 'ACCOUNT_PASSWORD_RESET', email);
    });
    sendJson(response, 200, { message: 'Password reset successfully. Sign in on your devices with your new password.' });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/register') {
    const body = await readJson(request);
    const name = requireString(body.name, 'Name');
    const email = normalizeEmail(body.email);
    const phone = requireString(body.phone, 'Phone', 40);
    const password = validatePassword(body.password);
    const credentials = await hashPassword(password);
    const customer = { id: crypto.randomUUID(), email, name, phone, role: 'CLIENT', agency_id: null };
    try {
      db.prepare('INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(customer.id, email, name, phone, credentials.salt, credentials.hash, customer.role, nowIso());
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        sendJson(response, 409, { error: 'An account with that email already exists. Sign in instead.' });
        return;
      }
      throw error;
    }
    audit(customer.id, 'CUSTOMER_ACCOUNT_REGISTERED', email);
    createSession(customer, response);
    sendJson(response, 201, { user: publicUser(customer) });
    return;
  }

  if (method === 'PATCH' && pathname === '/api/auth/profile') {
    if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
    if (!authorizeMutation(request, response, session)) return;
    const body = await readJson(request);
    const name = requireString(body.name, 'Name');
    const phone = requireString(body.phone, 'Phone', 40);
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone, user.id);
    audit(user.id, 'ACCOUNT_PROFILE_UPDATED', user.email);
    sendJson(response, 200, { user: publicUser({ ...user, name, phone }) });
    return;
  }

  if (method === 'PUT' && pathname === '/api/auth/avatar') {
    if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
    if (!authorizeMutation(request, response, session)) return;
    const body = await readJson(request, 400_000);
    const mime = requireString(body.mime, 'Image type', 32);
    const imageData = body.data === null ? null : validateImageData(body.data, mime);
    db.prepare('UPDATE users SET avatar_mime = ?, avatar_data = ? WHERE id = ?')
      .run(imageData ? mime : null, imageData, user.id);
    audit(user.id, imageData ? 'ACCOUNT_AVATAR_UPDATED' : 'ACCOUNT_AVATAR_REMOVED', user.email);
    sendJson(response, 200, {
      user: publicUser({ ...user, avatar_mime: imageData ? mime : null, avatar_data: imageData })
    });
    return;
  }

  if (method === 'PUT' && pathname === '/api/agency/logo') {
    if (!requireRole(response, user, ['AGENCY'])) return;
    if (!authorizeMutation(request, response, session)) return;
    const body = await readJson(request, 400_000);
    const mime = requireString(body.mime, 'Image type', 32);
    const imageData = body.data === null ? null : validateImageData(body.data, mime);
    db.prepare('UPDATE agencies SET logo_mime = ?, logo_data = ? WHERE id = ?')
      .run(imageData ? mime : null, imageData, user.agency_id);
    audit(user.id, imageData ? 'AGENCY_LOGO_UPDATED' : 'AGENCY_LOGO_REMOVED', user.agency_id);
    sendJson(response, 200, {
      agency: { id: user.agency_id, logoMime: imageData ? mime : null, logoData: imageData }
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/password') {
    if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
    if (!authorizeMutation(request, response, session)) return;
    const body = await readJson(request);
    const currentPassword = requireString(body.currentPassword, 'Current password', 256);
    const newPassword = validatePassword(body.newPassword);
    const currentCredentials = await hashPassword(currentPassword, user.password_salt);
    if (!safeEqual(currentCredentials.hash, user.password_hash)) {
      sendJson(response, 401, { error: 'Current password is incorrect.' });
      return;
    }
    if (safeEqual(currentCredentials.hash, (await hashPassword(newPassword, user.password_salt)).hash)) {
      sendJson(response, 400, { error: 'Choose a new password that is different from your current password.' });
      return;
    }
    const credentials = await hashPassword(newPassword);
    runInTransaction(() => {
      db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
        .run(credentials.salt, credentials.hash, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?')
        .run(user.id, session.session.id_hash);
      audit(user.id, 'ACCOUNT_PASSWORD_CHANGED', user.email);
    });
    sendJson(response, 200, { ok: true, message: 'Password updated. Other signed-in sessions were revoked.' });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = requireString(body.password, 'Password', 256);
    const account = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
    const credentials = account
      ? await hashPassword(password, account.password_salt)
      : await hashPassword(password, 'safar-kaabe-unknown-account');
    if (!account || !safeEqual(credentials.hash, account.password_hash)) {
      sendJson(response, 401, { error: 'Email or password is incorrect.' });
      return;
    }
    if (account.role === 'AGENCY' &&
        !db.prepare("SELECT id FROM agencies WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1").get(account.agency_id)) {
      sendJson(response, 403, { error: 'This agency account is pending approval or suspended. Contact SAFAR KAABE support.' });
      return;
    }
    createSession(account, response);
    audit(account.id, 'AUTHENTICATED', account.email);
    sendJson(response, 200, { user: publicUser(account) });
    return;
  }

  if (method === 'GET' && pathname === '/api/auth/session') {
    sendJson(response, 200, { user: user ? publicUser(user) : null });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    if (!session) {
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': ['sk_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', 'sk_csrf=; Path=/; SameSite=Strict; Max-Age=0'] });
      return;
    }
    if (!authorizeMutation(request, response, session)) return;
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(session.session.id_hash);
    response.setHeader('Set-Cookie', ['sk_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', 'sk_csrf=; Path=/; SameSite=Strict; Max-Age=0']);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (!user) {
      sendJson(response, 401, { error: 'Sign in to continue.' });
      return;
    }

    if (method === 'GET' && pathname === '/api/portal/summary') {
      if (user.role === 'SUPER_ADMIN') {
        const agencies = db.prepare(`
          SELECT agencies.id, agencies.name, agencies.tier, agencies.markup_pct AS markupPct,
                 CASE WHEN agencies.is_approved = 0 THEN 'PENDING' ELSE agencies.status END AS status,
                 agencies.logo_mime AS logoMime, agencies.logo_data AS logoData, agencies.created_at AS createdAt,
                 (SELECT COUNT(*) FROM users WHERE users.agency_id = agencies.id AND users.role = 'AGENCY') AS staffCount,
                 (SELECT COUNT(*) FROM agency_clients WHERE agency_clients.agency_id = agencies.id) AS clientCount
          FROM agencies ORDER BY agencies.name
        `).all();
        const customers = db.prepare("SELECT id, name, email, phone, avatar_mime AS avatarMime, avatar_data AS avatarData, created_at AS createdAt FROM users WHERE role = 'CLIENT' ORDER BY created_at DESC").all();
        const agencyStaff = db.prepare(`
          SELECT users.id, users.name, users.email, users.role, users.avatar_mime AS avatarMime,
                 users.avatar_data AS avatarData, users.agency_id AS agencyId,
                 agencies.name AS agencyName, users.created_at AS createdAt
          FROM users JOIN agencies ON agencies.id = users.agency_id
          WHERE users.role = 'AGENCY' ORDER BY users.created_at DESC
        `).all();
        const auditLogs = db.prepare(`
          SELECT audit_logs.action, audit_logs.target, audit_logs.created_at AS time, users.email AS actor
          FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_id
          ORDER BY audit_logs.id DESC LIMIT 100
        `).all();
        sendJson(response, 200, { user: publicUser(user), agencies, customers, agencyStaff, auditLogs });
        return;
      }
      if (user.role === 'AGENCY') {
        const agency = db.prepare('SELECT id, name, tier, markup_pct AS markupPct, status, logo_mime AS logoMime, logo_data AS logoData FROM agencies WHERE id = ?').get(user.agency_id);
        if (!agency) {
          sendJson(response, 403, { error: 'Your agency account is no longer active.' });
          return;
        }
        const staff = db.prepare("SELECT id, name, email, role, avatar_mime AS avatarMime, avatar_data AS avatarData, created_at AS createdAt FROM users WHERE agency_id = ? AND role = 'AGENCY' ORDER BY created_at").all(user.agency_id);
        const clients = db.prepare('SELECT id, name, phone, email, created_at AS createdAt FROM agency_clients WHERE agency_id = ? ORDER BY created_at DESC').all(user.agency_id);
        sendJson(response, 200, { user: publicUser(user), agency, staff, clients });
        return;
      }
      sendJson(response, 200, { user: publicUser(user), customer: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
      return;
    }

    if (method === 'GET' && pathname === '/api/conversations') {
      const conversations = user.role === 'SUPER_ADMIN'
        ? db.prepare(`
          SELECT c.id, c.agency_id AS agencyId, c.customer_id AS customerId, c.subject,
                 c.created_at AS createdAt, c.last_message_at AS lastMessageAt,
                 a.name AS agencyName, a.logo_mime AS agencyLogoMime, a.logo_data AS agencyLogoData,
                 u.name AS customerName, u.avatar_mime AS customerAvatarMime, u.avatar_data AS customerAvatarData,
                 (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS lastMessage,
                 (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND read_at IS NULL) AS unreadCount
          FROM conversations c LEFT JOIN agencies a ON a.id = c.agency_id
          LEFT JOIN users u ON u.id = c.customer_id ORDER BY c.last_message_at DESC
        `).all(user.id)
        : user.role === 'AGENCY'
          ? db.prepare(`
            SELECT c.id, c.agency_id AS agencyId, c.customer_id AS customerId, c.subject,
                   c.created_at AS createdAt, c.last_message_at AS lastMessageAt,
                   a.name AS agencyName, a.logo_mime AS agencyLogoMime, a.logo_data AS agencyLogoData,
                   u.name AS customerName, u.avatar_mime AS customerAvatarMime, u.avatar_data AS customerAvatarData,
                   (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS lastMessage,
                   (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND read_at IS NULL) AS unreadCount
            FROM conversations c LEFT JOIN agencies a ON a.id = c.agency_id
            LEFT JOIN users u ON u.id = c.customer_id
            WHERE c.agency_id = ? ORDER BY c.last_message_at DESC
          `).all(user.id, user.agency_id)
          : db.prepare(`
            SELECT c.id, c.agency_id AS agencyId, c.customer_id AS customerId, c.subject,
                   c.created_at AS createdAt, c.last_message_at AS lastMessageAt,
                   a.name AS agencyName, a.logo_mime AS agencyLogoMime, a.logo_data AS agencyLogoData,
                   u.name AS customerName, u.avatar_mime AS customerAvatarMime, u.avatar_data AS customerAvatarData,
                   (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS lastMessage,
                   (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND read_at IS NULL) AS unreadCount
            FROM conversations c LEFT JOIN agencies a ON a.id = c.agency_id
            LEFT JOIN users u ON u.id = c.customer_id
            WHERE c.customer_id = ? ORDER BY c.last_message_at DESC
          `).all(user.id, user.id);
      sendJson(response, 200, { conversations });
      return;
    }

    if (method === 'GET' && pathname === '/api/agencies/active') {
      const agencies = db.prepare("SELECT id, name FROM agencies WHERE status = 'ACTIVE' AND is_approved = 1 ORDER BY name").all();
      sendJson(response, 200, { agencies });
      return;
    }

    const agencyStatusMatch = pathname.match(/^\/api\/agencies\/([0-9a-f-]+)\/status$/i);
    if (agencyStatusMatch && method === 'PATCH') {
      if (!requireRole(response, user, ['SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      if (!['APPROVE', 'SUSPEND', 'ACTIVATE'].includes(body.action)) {
        sendJson(response, 400, { error: 'Choose approve, suspend, or activate.' });
        return;
      }
      const agency = db.prepare('SELECT id, name, status, is_approved FROM agencies WHERE id = ?').get(agencyStatusMatch[1]);
      if (!agency) {
        sendJson(response, 404, { error: 'Agency not found.' });
        return;
      }
      let status;
      let isApproved = agency.is_approved;
      if (body.action === 'APPROVE' && agency.is_approved === 0) {
        status = 'ACTIVE';
        isApproved = 1;
      } else if (body.action === 'SUSPEND' && agency.is_approved === 1 && agency.status === 'ACTIVE') {
        status = 'SUSPENDED';
      } else if (body.action === 'ACTIVATE' && agency.is_approved === 1 && agency.status === 'SUSPENDED') {
        status = 'ACTIVE';
      } else {
        sendJson(response, 409, { error: 'That agency status action is not valid for its current state.' });
        return;
      }
      runInTransaction(() => {
        db.prepare('UPDATE agencies SET status = ?, is_approved = ? WHERE id = ?').run(status, isApproved, agency.id);
        if (status === 'SUSPENDED') {
          db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE agency_id = ? AND role = ?)').run(agency.id, 'AGENCY');
        }
        audit(user.id, `AGENCY_${body.action}`, `${agency.name} (${agency.id})`);
      });
      sendJson(response, 200, { agency: { id: agency.id, name: agency.name, status } });
      return;
    }

    if (method === 'POST' && pathname === '/api/conversations') {
      if (!requireRole(response, user, ['CLIENT', 'AGENCY'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const subject = requireString(body.subject, 'Subject', 160);
      const message = requireString(body.message, 'Message', 5000);
      const support = body.support === true;
      let agencyId = null;
      let customerId = null;
      if (user.role === 'CLIENT') {
        customerId = user.id;
        if (!support) {
          agencyId = requireString(body.agencyId, 'Agency', 80);
          if (!db.prepare("SELECT id FROM agencies WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1").get(agencyId)) {
            sendJson(response, 404, { error: 'The selected travel agency is not available.' });
            return;
          }
        }
      } else {
        agencyId = user.agency_id;
        if (!db.prepare("SELECT id FROM agencies WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1").get(agencyId)) {
          sendJson(response, 403, { error: 'Your agency cannot open a support conversation while inactive.' });
          return;
        }
      }
      const conversationId = crypto.randomUUID();
      const createdAt = nowIso();
      runInTransaction(() => {
        db.prepare(`
          INSERT INTO conversations (id, agency_id, customer_id, subject, created_by, created_at, last_message_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(conversationId, agencyId, customerId, subject, user.id, createdAt, createdAt);
        db.prepare(`
          INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), conversationId, user.id, message, createdAt);
      });
      audit(user.id, 'CONVERSATION_CREATED', `${subject} (${conversationId})`);
      sendJson(response, 201, {
        conversation: {
          id: conversationId,
          agencyId,
          customerId,
          subject,
          createdAt,
          lastMessageAt: createdAt,
          lastMessage: message,
          unreadCount: 0
        }
      });
      return;
    }

    const conversationMessagesMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages$/i);
    if (conversationMessagesMatch && method === 'GET') {
      const conversation = getAccessibleConversation(conversationMessagesMatch[1], user);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      const messages = db.prepare(`
        SELECT messages.id, messages.sender_id AS senderId, users.name AS senderName,
               users.role AS senderRole,
               CASE WHEN users.role = 'AGENCY' THEN sender_agency.logo_mime ELSE users.avatar_mime END AS senderImageMime,
               CASE WHEN users.role = 'AGENCY' THEN sender_agency.logo_data ELSE users.avatar_data END AS senderImageData,
               messages.body, messages.created_at AS createdAt, messages.read_at AS readAt
        FROM messages JOIN users ON users.id = messages.sender_id
        LEFT JOIN agencies sender_agency ON sender_agency.id = users.agency_id
        WHERE messages.conversation_id = ? ORDER BY messages.created_at ASC, messages.rowid ASC LIMIT 200
      `).all(conversation.id);
      sendJson(response, 200, { messages });
      return;
    }

    const conversationReadMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/read$/i);
    if (conversationReadMatch && method === 'POST') {
      if (!authorizeMutation(request, response, session)) return;
      const conversation = getAccessibleConversation(conversationReadMatch[1], user);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      db.prepare('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL')
        .run(nowIso(), conversation.id, user.id);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (conversationMessagesMatch && method === 'POST') {
      if (!authorizeMutation(request, response, session)) return;
      const conversation = getAccessibleConversation(conversationMessagesMatch[1], user);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      const body = await readJson(request);
      const message = requireString(body.message, 'Message', 5000);
      const messageId = crypto.randomUUID();
      const createdAt = nowIso();
      runInTransaction(() => {
        db.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(messageId, conversation.id, user.id, message, createdAt);
        db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(createdAt, conversation.id);
      });
      audit(user.id, 'CONVERSATION_MESSAGE_SENT', `${conversation.subject} (${conversation.id})`);
      sendJson(response, 201, {
        message: { id: messageId, senderId: user.id, senderName: user.name, senderRole: user.role, body: message, createdAt, readAt: null }
      });
      return;
    }

    if (pathname === '/api/catalog' && method === 'GET') {
      const selectCatalog = `
          SELECT id, category, title AS titleEn, title_so AS titleSo, destination, route_badge AS routeBadge,
                 specs, supplier_name AS supplierName, supplier_ref AS supplierRef, agency_id AS agencyId,
                 base_cents AS baseUsdCents, tax_cents AS taxUsdCents, supplier_commission_pct AS supplierCommPct,
                 available, travel_date AS travelDate, baggage, is_published AS published
          FROM catalog_products`;
      const products = user.role === 'AGENCY'
        ? db.prepare(`${selectCatalog} WHERE agency_id = ? ORDER BY title`).all(user.agency_id)
        : user.role === 'CLIENT'
          ? db.prepare(`${selectCatalog}
            WHERE is_published = 1 AND available > 0
              AND agency_id IN (SELECT id FROM agencies WHERE status = 'ACTIVE' AND is_approved = 1)
              AND (travel_date IS NULL OR travel_date >= date('now'))
            ORDER BY title`).all()
          : db.prepare(`${selectCatalog} ORDER BY title`).all();
      sendJson(response, 200, { catalog: products });
      return;
    }

    if (pathname === '/api/catalog' && method === 'POST') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const title = requireString(body.title, 'Product name');
      const destination = requireString(body.destination, 'Destination', 12).toUpperCase();
      const agencyId = user.role === 'AGENCY' ? user.agency_id : requireString(body.agencyId, 'Agency');
      const category = requireString(body.category, 'Category', 20);
      const price = Number(body.price);
      const available = Number(body.available ?? 1);
      const travelDate = body.travelDate === '' || body.travelDate == null ? null : requireString(body.travelDate, 'Travel date', 10);
      const baggage = typeof body.baggage === 'string' ? body.baggage.trim() : '';
      const specs = typeof body.specs === 'string' && body.specs.trim() ? body.specs.trim().slice(0, 500) : 'Agency managed inventory';
      const published = body.published === undefined || body.published === true ? 1 : body.published === false ? 0 : -1;
      const dateIsValid = !travelDate || isValidIsoDate(travelDate);
      const agency = db.prepare('SELECT id, name FROM agencies WHERE id = ? AND status = ?').get(agencyId, 'ACTIVE');
      if (!agency || !['HOTEL', 'CAR', 'TOUR', 'TRANSFER', 'FLIGHT', 'PACKAGE'].includes(category) ||
          !Number.isFinite(price) || price <= 0 || price > 1000000 ||
          !Number.isSafeInteger(available) || available < 0 || available > 100000 ||
          (body.baggage !== undefined && typeof body.baggage !== 'string') ||
          (body.specs !== undefined && typeof body.specs !== 'string') ||
          baggage.length > 120 || !dateIsValid || published < 0) {
        sendJson(response, 400, { error: 'Choose an active agency and enter valid listing details, price, availability and travel date.' });
        return;
      }
      const id = crypto.randomUUID();
      const supplierRef = `SUP-${randomCode()}-${destination}`;
      const product = {
        id,
        agencyId,
        category,
        titleEn: title,
        titleSo: title,
        destination,
        routeBadge: `${destination} • DIRECT`,
        specs,
        supplierName: agency.name,
        supplierRef,
        baseUsdCents: Math.round(price * 100),
        taxUsdCents: Math.round(price * 12),
        supplierCommPct: 10,
        available,
        travelDate,
        baggage,
        published: Boolean(published)
      };
      db.prepare(`
        INSERT INTO catalog_products (id, agency_id, title, title_so, category, destination, route_badge, specs, supplier_name, supplier_ref, base_cents, tax_cents, supplier_commission_pct, available, travel_date, baggage, is_published)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(product.id, product.agencyId, product.titleEn, product.titleSo, product.category, product.destination, product.routeBadge, product.specs, product.supplierName, product.supplierRef, product.baseUsdCents, product.taxUsdCents, product.supplierCommPct, product.available, product.travelDate, product.baggage, published);
      audit(user.id, published ? 'AGENCY_PRODUCT_PUBLISHED' : 'AGENCY_PRODUCT_DRAFTED', `${title} (${supplierRef})`);
      sendJson(response, 201, { product });
      return;
    }

    const catalogMatch = pathname.match(/^\/api\/catalog\/([0-9a-f-]+)$/i);
    if (catalogMatch && ['PATCH', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const existing = db.prepare('SELECT * FROM catalog_products WHERE id = ?').get(catalogMatch[1]);
      if (!existing || (user.role === 'AGENCY' && existing.agency_id !== user.agency_id)) {
        sendJson(response, 404, { error: 'Inventory listing not found.' });
        return;
      }
      if (method === 'DELETE') {
        db.prepare('DELETE FROM catalog_products WHERE id = ?').run(existing.id);
        audit(user.id, 'AGENCY_PRODUCT_REMOVED', `${existing.title} (${existing.supplier_ref})`);
        sendJson(response, 200, { ok: true });
        return;
      }

      const body = await readJson(request);
      const title = body.title === undefined ? existing.title : requireString(body.title, 'Product name');
      const destination = body.destination === undefined ? existing.destination : requireString(body.destination, 'Destination', 12).toUpperCase();
      const category = body.category === undefined ? existing.category : requireString(body.category, 'Category', 20);
      const price = body.price === undefined ? existing.base_cents / 100 : Number(body.price);
      const available = body.available === undefined ? existing.available : Number(body.available);
      const travelDate = body.travelDate === undefined ? existing.travel_date : body.travelDate === '' || body.travelDate === null ? null : requireString(body.travelDate, 'Travel date', 10);
      const baggage = body.baggage === undefined ? existing.baggage : typeof body.baggage === 'string' ? body.baggage.trim() : '';
      const specs = body.specs === undefined ? existing.specs : typeof body.specs === 'string' && body.specs.trim() ? body.specs.trim().slice(0, 500) : 'Agency managed inventory';
      const published = body.published === undefined ? existing.is_published : body.published === true ? 1 : body.published === false ? 0 : -1;
      const dateIsValid = !travelDate || isValidIsoDate(travelDate);
      if (!['HOTEL', 'CAR', 'TOUR', 'TRANSFER', 'FLIGHT', 'PACKAGE'].includes(category) ||
          !Number.isFinite(price) || price <= 0 || price > 1000000 ||
          !Number.isSafeInteger(available) || available < 0 || available > 100000 ||
          (body.baggage !== undefined && typeof body.baggage !== 'string') ||
          (body.specs !== undefined && typeof body.specs !== 'string') ||
          baggage.length > 120 || !dateIsValid || published < 0) {
        sendJson(response, 400, { error: 'Enter valid listing details, price, availability and travel date.' });
        return;
      }
      const routeBadge = category === 'FLIGHT' ? `${existing.route_badge.split(' ')[0]} ── ✈ ── ${destination}` : `${destination} • DIRECT`;
      db.prepare(`
        UPDATE catalog_products
        SET title = ?, title_so = ?, category = ?, destination = ?, route_badge = ?, specs = ?,
            base_cents = ?, tax_cents = ?, available = ?, travel_date = ?, baggage = ?, is_published = ?
        WHERE id = ?
      `).run(title, title, category, destination, routeBadge, specs, Math.round(price * 100), Math.round(price * 12), available, travelDate, baggage, published, existing.id);
      audit(user.id, published ? 'AGENCY_PRODUCT_UPDATED' : 'AGENCY_PRODUCT_UNPUBLISHED', `${title} (${existing.supplier_ref})`);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === '/api/bookings' && method === 'GET') {
      const query = user.role === 'SUPER_ADMIN'
        ? db.prepare(`SELECT id, reference AS ref, pnr, agency_id AS agencyId, customer_id AS customerId, traveler_name AS travelerName, phone, offer_title AS offerTitle, category, payment_provider AS paymentProvider, state, financials_json, travel_date AS travelDate, created_at AS createdAtUtc FROM bookings ORDER BY created_at DESC`)
        : user.role === 'AGENCY'
          ? db.prepare(`SELECT id, reference AS ref, pnr, agency_id AS agencyId, customer_id AS customerId, traveler_name AS travelerName, phone, offer_title AS offerTitle, category, payment_provider AS paymentProvider, state, financials_json, travel_date AS travelDate, created_at AS createdAtUtc FROM bookings WHERE agency_id = ? ORDER BY created_at DESC`)
          : db.prepare(`SELECT id, reference AS ref, pnr, agency_id AS agencyId, customer_id AS customerId, traveler_name AS travelerName, phone, offer_title AS offerTitle, category, payment_provider AS paymentProvider, state, financials_json, travel_date AS travelDate, created_at AS createdAtUtc FROM bookings WHERE customer_id = ? ORDER BY created_at DESC`);
      const records = user.role === 'SUPER_ADMIN' ? query.all() : query.all(user.role === 'AGENCY' ? user.agency_id : user.id);
      sendJson(response, 200, { bookings: records.map(({ financials_json, ...booking }) => ({ ...booking, financials: JSON.parse(financials_json) })) });
      return;
    }

    if (pathname === '/api/bookings' && method === 'POST') {
      if (!requireRole(response, user, ['CLIENT', 'AGENCY'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const offerId = requireString(body.offerId, 'Travel offer', 80);
      const offer = db.prepare(`
        SELECT catalog_products.*, agencies.markup_pct AS agency_markup_pct
        FROM catalog_products JOIN agencies ON agencies.id = catalog_products.agency_id
        WHERE catalog_products.id = ? AND agencies.status = 'ACTIVE' AND agencies.is_approved = 1
          AND catalog_products.is_published = 1
          AND catalog_products.available > 0 AND (catalog_products.travel_date IS NULL OR catalog_products.travel_date >= date('now'))
      `).get(offerId);
      if (!offer || (user.role === 'AGENCY' && offer.agency_id !== user.agency_id)) {
        sendJson(response, 404, { error: 'The selected travel offer is not available to this account.' });
        return;
      }
      const paymentMethod = requireString(body.paymentMethod, 'Payment method', 30);
      const travelDate = body.travelDate === undefined || body.travelDate === '' ? offer.travel_date : requireString(body.travelDate, 'Travel date', 10);
      if ((travelDate && (!isValidIsoDate(travelDate) || travelDate < new Date().toISOString().slice(0, 10))) ||
          (offer.travel_date && travelDate !== offer.travel_date)) {
        sendJson(response, 400, { error: 'Choose a valid travel date available for this listing.' });
        return;
      }
      if (!['EVC_PLUS', 'ZAAD', 'CARD'].includes(paymentMethod)) {
        sendJson(response, 400, { error: 'Choose a supported demo payment method.' });
        return;
      }
      const baseCents = offer.base_cents;
      const taxCents = offer.tax_cents;
      const supplierCommissionCents = Math.round(baseCents * offer.supplier_commission_pct / 100);
      const agencyCommissionCents = Math.round(baseCents * offer.agency_markup_pct / 100);
      const safarKaabeFeeCents = 1200;
      const subtotalCents = baseCents + taxCents + agencyCommissionCents + safarKaabeFeeCents;
      const paymentFeeCents = Math.round(subtotalCents * (paymentMethod === 'CARD' ? 2.9 : 1) / 100);
      const financials = {
        supplierBaseCents: baseCents,
        supplierTaxesCents: taxCents,
        supplierCommissionCents,
        agencyCommissionCents,
        safarKaabeFeeCents,
        paymentFeeCents,
        customerGrandTotalCents: subtotalCents + paymentFeeCents,
        netPayableToSupplierCents: baseCents + taxCents - supplierCommissionCents,
        recognizedPlatformRevenueCents: safarKaabeFeeCents + supplierCommissionCents,
        agencyMarkupPct: offer.agency_markup_pct
      };
      const booking = {
        id: crypto.randomUUID(),
        reference: `SK-${randomCode()}`,
        pnr: `PNR-SK-${randomCode()}`,
        agencyId: offer.agency_id,
        customerId: user.role === 'CLIENT' ? user.id : null,
        travelerName: requireString(body.travelerName, 'Traveler name'),
        phone: requireString(body.phone, 'Phone', 40),
        offerTitle: offer.title,
        category: offer.category,
        paymentProvider: `${paymentMethod}_SANDBOX`,
        state: 'TICKETED_DELIVERED',
        travelDate,
        financials
      };
      const createdAtUtc = nowIso();
      const inventoryUpdate = db.prepare('UPDATE catalog_products SET available = available - 1 WHERE id = ? AND is_published = 1 AND available > 0');
      let inventoryAvailable = true;
      runInTransaction(() => {
        if (inventoryUpdate.run(offer.id).changes !== 1) {
          inventoryAvailable = false;
          return;
        }
        db.prepare(`
          INSERT INTO bookings (id, reference, pnr, agency_id, customer_id, traveler_name, phone, offer_title, category, payment_provider, state, financials_json, travel_date, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(booking.id, booking.reference, booking.pnr, booking.agencyId, booking.customerId, booking.travelerName, booking.phone, booking.offerTitle, booking.category, booking.paymentProvider, booking.state, JSON.stringify(booking.financials), booking.travelDate, createdAtUtc);
      });
      if (!inventoryAvailable) {
        sendJson(response, 409, { error: 'This listing has just sold out. Refresh inventory and select another option.' });
        return;
      }
      audit(user.id, 'BOOKING_ISSUED', `${booking.reference} (${booking.agencyId})`);
      sendJson(response, 201, { booking: { ...booking, createdAtUtc } });
      return;
    }

    if (method === 'POST' && pathname === '/api/agencies') {
      if (!requireRole(response, user, ['SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const name = requireString(body.name, 'Agency name');
      const tier = requireString(body.tier, 'Plan');
      const markup = Number(body.markupPct);
      const ownerName = requireString(body.ownerName, 'Agency owner name');
      const ownerEmail = normalizeEmail(body.ownerEmail);
      const ownerPassword = validatePassword(body.ownerPassword);
      if (!['BASIC', 'PROFESSIONAL', 'ENTERPRISE'].includes(tier) || !Number.isFinite(markup) || markup < 0 || markup > 100) {
        sendJson(response, 400, { error: 'Choose a valid plan and markup from 0 to 100%.' });
        return;
      }
      const credentials = await hashPassword(ownerPassword);
      const id = crypto.randomUUID();
      const ownerId = crypto.randomUUID();
      try {
        runInTransaction(() => {
          db.prepare('INSERT INTO agencies (id, name, tier, markup_pct, status, is_approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, name, tier, markup, 'SUSPENDED', 0, nowIso());
          db.prepare('INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, agency_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(ownerId, ownerEmail, ownerName, '', credentials.salt, credentials.hash, 'AGENCY', id, nowIso());
          audit(user.id, 'AGENCY_REGISTERED', `${name} (${ownerEmail})`);
        });
      } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed')) {
          sendJson(response, 409, { error: 'An account with the agency owner email already exists.' });
          return;
        }
        throw error;
      }
      sendJson(response, 201, { agency: { id, name, tier, markupPct: markup, status: 'PENDING' }, owner: { id: ownerId, name: ownerName, email: ownerEmail, role: 'AGENCY' } });
      return;
    }

    if (pathname === '/api/agency/clients' && method === 'GET') {
      if (!requireRole(response, user, ['AGENCY', 'SUPER_ADMIN'])) return;
      const agencyId = user.role === 'AGENCY' ? user.agency_id : url.searchParams.get('agencyId');
      if (!agencyId || !db.prepare('SELECT id FROM agencies WHERE id = ?').get(agencyId)) {
        sendJson(response, 400, { error: 'Choose a valid agency.' });
        return;
      }
      const clients = db.prepare('SELECT id, name, phone, email, created_at AS createdAt FROM agency_clients WHERE agency_id = ? ORDER BY created_at DESC').all(agencyId);
      sendJson(response, 200, { clients });
      return;
    }

    if (pathname === '/api/agency/staff' && method === 'POST') {
      if (!requireRole(response, user, ['AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const agencyId = user.role === 'AGENCY' ? user.agency_id : requireString(body.agencyId, 'Agency');
      if (!db.prepare('SELECT id FROM agencies WHERE id = ?').get(agencyId)) {
        sendJson(response, 404, { error: 'Agency not found.' });
        return;
      }
      const name = requireString(body.name, 'Staff name');
      const email = normalizeEmail(body.email);
      const password = validatePassword(body.password);
      const credentials = await hashPassword(password);
      const id = crypto.randomUUID();
      try {
        db.prepare('INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, agency_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, email, name, '', credentials.salt, credentials.hash, 'AGENCY', agencyId, nowIso());
      } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed')) {
          sendJson(response, 409, { error: 'An account with that email already exists.' });
          return;
        }
        throw error;
      }
      audit(user.id, 'AGENCY_STAFF_CREATED', `${name} (${email}, ${agencyId})`);
      sendJson(response, 201, { staff: { id, name, email, role: 'AGENCY', createdAt: nowIso() } });
      return;
    }

    const staffMatch = pathname.match(/^\/api\/agency\/staff\/([0-9a-f-]+)$/i);
    if (staffMatch && method === 'DELETE') {
      if (!requireRole(response, user, ['AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const staff = db.prepare("SELECT id, agency_id, name, email FROM users WHERE id = ? AND role = 'AGENCY'").get(staffMatch[1]);
      if (!staff || (user.role === 'AGENCY' && user.agency_id !== staff.agency_id) || staff.id === user.id) {
        sendJson(response, 404, { error: 'Staff account not found.' });
        return;
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(staff.id);
      audit(user.id, 'AGENCY_STAFF_DELETED', `${staff.email} (${staff.agency_id})`);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === '/api/agency/clients' && method === 'POST') {
      if (!requireRole(response, user, ['AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const agencyId = user.role === 'AGENCY' ? user.agency_id : requireString(body.agencyId, 'Agency');
      if (!db.prepare('SELECT id FROM agencies WHERE id = ?').get(agencyId)) {
        sendJson(response, 404, { error: 'Agency not found.' });
        return;
      }
      const name = requireString(body.name, 'Client name');
      const phone = requireString(body.phone, 'Phone', 40);
      const email = body.email ? normalizeEmail(body.email) : null;
      const client = { id: crypto.randomUUID(), name, phone, email, createdAt: nowIso() };
      db.prepare('INSERT INTO agency_clients (id, agency_id, name, phone, email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(client.id, agencyId, client.name, client.phone, client.email, client.createdAt);
      audit(user.id, 'AGENCY_CLIENT_CREATED', `${name} (${agencyId})`);
      sendJson(response, 201, { client });
      return;
    }

    const clientMatch = pathname.match(/^\/api\/agency\/clients\/([0-9a-f-]+)$/i);
    if (clientMatch && method === 'DELETE') {
      if (!requireRole(response, user, ['AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const client = db.prepare('SELECT id, agency_id, name FROM agency_clients WHERE id = ?').get(clientMatch[1]);
      if (!client || (user.role === 'AGENCY' && user.agency_id !== client.agency_id)) {
        sendJson(response, 404, { error: 'Client not found.' });
        return;
      }
      db.prepare('DELETE FROM agency_clients WHERE id = ?').run(client.id);
      audit(user.id, 'AGENCY_CLIENT_DELETED', `${client.name} (${client.agency_id})`);
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: 'API route not found.' });
    return;
  }

  let requestedPath;
  try {
    requestedPath = pathname === '/' ? 'the style.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    response.writeHead(400).end('Invalid path');
    return;
  }
  const filePath = path.resolve(root, requestedPath);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (requestedPath.toLowerCase().split(/[\\/]/, 1)[0] === 'data') {
    response.writeHead(404).end('Not found');
    return;
  }
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeType(filePath),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ['the style.html', 'sw.js'].includes(path.basename(filePath)) ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const loginAttempts = new Map();
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (request.method === 'POST' && request.url?.startsWith('/api/auth/login')) {
    const ip = request.socket.remoteAddress || 'unknown';
    const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
    if (attempt.until > Date.now() && attempt.count >= 10) {
      sendJson(response, 429, { error: 'Too many sign-in attempts. Try again in a few minutes.' }, { 'Retry-After': String(Math.ceil((attempt.until - Date.now()) / 1000)) });
      return;
    }
    if (attempt.until < Date.now()) loginAttempts.set(ip, { count: 0, until: Date.now() + 5 * 60 * 1000 });
  }
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const before = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'SUPER_ADMIN'").get().count;
      await handleApi(request, response, url);
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const ip = request.socket.remoteAddress || 'unknown';
        const attempt = loginAttempts.get(ip);
        if (response.statusCode >= 400) {
          attempt.count += 1;
          if (attempt.count >= 10) attempt.until = Date.now() + 5 * 60 * 1000;
          loginAttempts.set(ip, attempt);
        } else loginAttempts.delete(ip);
      }
      const after = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'SUPER_ADMIN'").get().count;
      if (before === 0 && after > 0) console.log('Initial Super Admin account created.');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
      return;
    }
    await handleApi(request, response, url);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    if (error.statusCode >= 500 || !error.statusCode) console.error('Request failed:', error);
    sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'The server could not complete your request.' });
  }
});

server.listen(port, host, () => {
  console.log(`SAFAR KAABE is running at http://localhost:${port}`);
  console.log(`Database: ${path.join(dataDir, 'safar-kaabe.sqlite')}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`On this Wi-Fi network: http://${address.address}:${port}`);
    }
  }
  console.log('Create the first Super Admin account in the app to get started.');
  console.log('Press Ctrl+C to stop the server.');
});