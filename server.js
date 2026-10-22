const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const webPush = require('web-push');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const sharp = require('sharp');
const ticketCanvas = require('@napi-rs/canvas');
Object.assign(globalThis, {
  DOMMatrix: globalThis.DOMMatrix || ticketCanvas.DOMMatrix,
  ImageData: globalThis.ImageData || ticketCanvas.ImageData,
  Path2D: globalThis.Path2D || ticketCanvas.Path2D
});
const ticketLayoutVersion = 4;
const { createDatabase } = require('./database');

const root = __dirname;
const defaultDataDirectory = process.env.VERCEL
  ? path.join(os.tmpdir(), 'safar-kaabe-data')
  : path.join(root, 'data');
const dataDir = path.resolve(process.env.SAFAR_KAABE_DATA_DIR || defaultDataDirectory);
const db = createDatabase({ dataDir });
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const sessionMaxAge = 60 * 60 * 24 * 7;
const passwordLength = 64;
const passwordResetCodeTtlMs = 10 * 60 * 1000;
const passwordResetRateWindowMs = 15 * 60 * 1000;
const passwordResetRequestLimit = 5;
const passwordResetAttemptsLimit = 5;
const maxChatAttachmentBytes = 2_000_000;
const maxChatRequestBytes = 2_800_000;
const maxCatalogImageBytes = 262_144;
const maxCatalogImageRequestBytes = 380_000;
const passwordResetSender = process.env.SMTP_FROM || 'engjoseph250@gmail.com';
const catalogEventSubscribers = new Set();
const catalogRealtimeSupported = !process.env.VERCEL && !process.env.VERCEL_ENV;
const notificationEventSubscribers = new Map();
const webPushConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (webPushConfigured) {
  webPush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}
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

const schema = `
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
    presence_status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (presence_status IN ('AVAILABLE', 'BUSY', 'AWAY')),
    last_seen_at TEXT,
    typing_conversation_id TEXT,
    typing_until TEXT,
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
    traveler_email TEXT,
    phone TEXT NOT NULL,
    offer_title TEXT NOT NULL,
    category TEXT NOT NULL,
    payment_provider TEXT NOT NULL,
    state TEXT NOT NULL,
    financials_json TEXT NOT NULL,
    seat_count INTEGER NOT NULL DEFAULT 1 CHECK (seat_count > 0),
    travel_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS waafi_payments (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    reference_id TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'FAILED')),
    hpp_url TEXT NOT NULL,
    order_id TEXT,
    transaction_id TEXT,
    updated_at TEXT NOT NULL,
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
    image_mime TEXT,
    image_data TEXT,
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
  CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
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
  CREATE TABLE IF NOT EXISTS conversation_hidden (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hidden_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'TEXT' CHECK (message_type IN ('TEXT', 'IMAGE', 'AUDIO')),
    attachment_mime TEXT,
    attachment_data TEXT,
    attachment_name TEXT,
    duration_ms INTEGER,
    edited_at TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE TABLE IF NOT EXISTS payment_receipt_messages (
    payment_reference TEXT PRIMARY KEY REFERENCES waafi_payments(reference_id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agency_id TEXT REFERENCES agencies(id) ON DELETE CASCADE,
    booking_id TEXT REFERENCES bookings(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    href TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications(recipient_user_id, read_at, created_at);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    subscription_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sound_enabled INTEGER NOT NULL DEFAULT 1,
    desktop_push_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS booking_documents (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    traveler_id TEXT,
    agency_id TEXT,
    document_type TEXT NOT NULL CHECK (document_type IN ('BOOKING_CONFIRMATION', 'AIRLINE_ETICKET')),
    status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'READY', 'FAILED')),
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/pdf',
    storage_provider TEXT NOT NULL DEFAULT 'DATABASE',
    pdf_storage_path TEXT,
    jpg_storage_path TEXT,
    document_reference TEXT,
    document_version INTEGER NOT NULL DEFAULT 1,
    layout_version INTEGER NOT NULL DEFAULT 1,
    source_hash TEXT,
    pdf_data TEXT,
    jpg_data TEXT,
    jpg_file_name TEXT,
    document_hash TEXT,
    verification_token_hash TEXT NOT NULL,
    error_message TEXT,
    email_delivery_status TEXT,
    email_sent_at TEXT,
    issued_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (booking_id, document_type)
  );
  CREATE INDEX IF NOT EXISTS booking_documents_booking_idx ON booking_documents(booking_id, status);
  CREATE TABLE IF NOT EXISTS booking_document_versions (
    document_id TEXT NOT NULL REFERENCES booking_documents(id) ON DELETE CASCADE,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    document_reference TEXT NOT NULL,
    document_version INTEGER NOT NULL,
    verification_token_hash TEXT NOT NULL,
    document_hash TEXT,
    status TEXT NOT NULL DEFAULT 'SUPERSEDED',
    issued_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (document_id, document_version)
  );
  CREATE TABLE IF NOT EXISTS booking_document_deliveries (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES booking_documents(id) ON DELETE CASCADE,
    recipient_email TEXT NOT NULL,
    document_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (document_id, recipient_email)
  );
  CREATE INDEX IF NOT EXISTS booking_document_deliveries_document_idx ON booking_document_deliveries(document_id, status);
  CREATE TABLE IF NOT EXISTS chat_statuses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 500),
    attachment_mime TEXT,
    attachment_data TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    CHECK (body <> '' OR attachment_data IS NOT NULL)
  );
  CREATE TABLE IF NOT EXISTS chat_status_replies (
    id TEXT PRIMARY KEY,
    status_id TEXT NOT NULL REFERENCES chat_statuses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_status_reactions (
    status_id TEXT NOT NULL REFERENCES chat_statuses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL CHECK (emoji IN ('😍', '😂', '😮', '❤️')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (status_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS chat_communities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_community_members (
    community_id TEXT NOT NULL REFERENCES chat_communities(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (community_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS chat_community_messages (
    id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES chat_communities(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    created_at TEXT NOT NULL,
    edited_at TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_calls (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    call_type TEXT NOT NULL CHECK (call_type IN ('AUDIO', 'VIDEO')),
    status TEXT NOT NULL DEFAULT 'RINGING' CHECK (status IN ('RINGING', 'ACCEPTED', 'REJECTED', 'ENDED', 'MISSED')),
    created_at TEXT NOT NULL,
    accepted_at TEXT,
    ended_at TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_call_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL REFERENCES chat_calls(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    signal_type TEXT NOT NULL CHECK (signal_type IN ('OFFER', 'ANSWER', 'ICE')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS auth_rate_limits_expiry_idx ON auth_rate_limits(expires_at);
  CREATE INDEX IF NOT EXISTS agency_clients_tenant_idx ON agency_clients(agency_id);
  CREATE INDEX IF NOT EXISTS conversations_agency_idx ON conversations(agency_id, last_message_at);
  CREATE INDEX IF NOT EXISTS conversations_customer_idx ON conversations(customer_id, last_message_at);
  CREATE INDEX IF NOT EXISTS conversation_hidden_user_idx ON conversation_hidden(user_id, conversation_id);
  CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS chat_statuses_expiry_idx ON chat_statuses(expires_at, created_at);
  CREATE INDEX IF NOT EXISTS chat_status_replies_idx ON chat_status_replies(status_id, created_at);
  CREATE INDEX IF NOT EXISTS chat_community_members_user_idx ON chat_community_members(user_id, joined_at);
  CREATE INDEX IF NOT EXISTS chat_community_messages_idx ON chat_community_messages(community_id, created_at);
  CREATE INDEX IF NOT EXISTS chat_calls_callee_status_idx ON chat_calls(callee_id, status, created_at);
  CREATE INDEX IF NOT EXISTS chat_calls_caller_status_idx ON chat_calls(caller_id, status, created_at);
  CREATE INDEX IF NOT EXISTS chat_call_signals_call_idx ON chat_call_signals(call_id, id);
`;

const nowIso = () => new Date().toISOString();
const randomCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

function getWaafiConfig() {
  const merchantUid = process.env.WAAFI_MERCHANT_UID || '';
  const storeId = process.env.WAAFI_STORE_ID || '';
  const hppKey = process.env.WAAFI_HPP_KEY || '';
  if (!/^\w{7,15}$/.test(merchantUid) || !/^\d{1,50}$/.test(storeId) || !/^[A-Za-z0-9]{20,40}$/.test(hppKey)) return null;
  const sandbox = String(process.env.WAAFI_ENV || 'sandbox').toLowerCase() !== 'production';
  const testEndpoint = process.env.NODE_ENV === 'test' ? process.env.WAAFI_TEST_ENDPOINT || '' : '';
  const endpointOverrideIsLocal = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^?#]*)?$/.test(testEndpoint);
  return {
    merchantUid,
    storeId: Number(storeId),
    hppKey,
    endpoint: endpointOverrideIsLocal ? testEndpoint : sandbox ? 'https://sandbox.waafipay.com/asm' : 'https://api.waafipay.net/asm',
    sandbox
  };
}

async function waafiRequest(serviceName, serviceParams) {
  const config = getWaafiConfig();
  if (!config) throw Object.assign(new Error('WaafiPay is not configured. Add WAAFI_MERCHANT_UID, WAAFI_STORE_ID and WAAFI_HPP_KEY to the server environment.'), { statusCode: 503 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        schemaVersion: '1.0',
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
        channelName: 'WEB',
        serviceName,
        serviceParams: { merchantUid: config.merchantUid, storeId: config.storeId, hppKey: config.hppKey, ...serviceParams }
      })
    });
    if (!response.ok) throw Object.assign(new Error('WaafiPay could not be reached. Please try again.'), { statusCode: 502 });
    const payload = await response.json();
    return { payload, config };
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error(error.name === 'AbortError' ? 'WaafiPay took too long to respond. Please try again.' : 'WaafiPay could not start this payment. Please try again.'), { statusCode: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshWaafiPayment(referenceId) {
  const payment = await db.prepare(`SELECT waafi_payments.id AS id, booking_id AS bookingId, reference_id AS referenceId,
    amount_cents AS amountCents, currency, status, transaction_id AS transactionId,
    bookings.customer_id AS customerId, bookings.agency_id AS agencyId, bookings.reference AS bookingReference,
    bookings.offer_title AS offerTitle, bookings.seat_count AS seatCount, bookings.travel_date AS travelDate
    FROM waafi_payments JOIN bookings ON bookings.id = waafi_payments.booking_id
    WHERE waafi_payments.reference_id = ?`).get(referenceId);
  if (!payment) return null;
  const { payload } = await waafiRequest('HPP_GETTRANINFO', { referenceId: payment.referenceId });
  const params = payload.params || {};
  const matchesReference = String(params.referenceId || params.reference_id || '') === payment.referenceId;
  const actualAmount = Math.round(Number(params.tranAmount ?? params.amount) * 100);
  const approved = String(params.status || params.tranStatusDesc || '').toUpperCase() === 'APPROVED' ||
    String(params.tranStatusId || '') === '3';
  const isApproved = String(payload.responseCode) === '2001' && matchesReference && approved &&
    actualAmount === payment.amountCents && String(params.currency || '').toUpperCase() === payment.currency;
  const finalDeclined = ['DECLINED', 'FAILED', 'CANCELLED'].includes(String(params.status || params.tranStatusDesc || '').toUpperCase());
  const status = isApproved ? 'APPROVED' : finalDeclined ? 'DECLINED' : 'PENDING';
  const updatedAt = nowIso();
  const transactionId = params.transactionId ? String(params.transactionId) : payment.transactionId;
  await runInTransaction(async () => {
    await db.prepare(`UPDATE waafi_payments SET status = ?, order_id = COALESCE(?, order_id),
      transaction_id = COALESCE(?, transaction_id), updated_at = ? WHERE id = ?`)
      .run(status, params.orderId ? String(params.orderId) : null, transactionId, updatedAt, payment.id);
    if (status !== 'APPROVED' || !payment.customerId) return;

    await db.prepare("UPDATE bookings SET state = 'PAYMENT_RECEIVED', updated_at = ? WHERE id = ? AND state = 'PAYMENT_PENDING'")
      .run(updatedAt, payment.bookingId);
    const subject = `Booking ${payment.bookingReference} payment receipt`;
    let conversation = await db.prepare(`SELECT id FROM conversations
      WHERE agency_id = ? AND customer_id = ? AND subject = ?`).get(payment.agencyId, payment.customerId, subject);
    if (!conversation) {
      conversation = { id: crypto.randomUUID() };
      await db.prepare(`INSERT INTO conversations
        (id, agency_id, customer_id, subject, created_by, created_at, last_message_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(conversation.id, payment.agencyId, payment.customerId, subject, payment.customerId, updatedAt, updatedAt);
    }

    const messageId = crypto.randomUUID();
    const receipt = [
      'WaafiPay payment confirmed by the provider.',
      `Receipt: ${payment.referenceId}`,
      transactionId ? `Transaction: ${transactionId}` : null,
      `Booking: ${payment.bookingReference}`,
      `Trip: ${payment.offerTitle}`,
      `Seats: ${payment.seatCount}`,
      payment.travelDate ? `Travel date: ${payment.travelDate}` : null,
      `Amount: ${(payment.amountCents / 100).toFixed(2)} ${payment.currency}`,
      `Confirmed: ${updatedAt}`
    ].filter(Boolean).join('\n');
    await db.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(messageId, conversation.id, payment.customerId, receipt, updatedAt);
    const receiptRecord = await db.prepare(`INSERT INTO payment_receipt_messages
      (payment_reference, conversation_id, message_id, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT (payment_reference) DO NOTHING`)
      .run(payment.referenceId, conversation.id, messageId, updatedAt);
    if (receiptRecord.changes === 1) {
      await db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?')
        .run(updatedAt, conversation.id);
    } else {
      await db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    }
  });
  await audit(null, `WAAFI_PAYMENT_${status}`, `${payment.referenceId} (${payment.amountCents} cents)`);
  return { ...payment, status, transactionId: transactionId || null, updatedAt };
}

const runInTransaction = callback => db.transaction(callback);

const demoAgencyIds = [
  'ag_east_africa', 'ag_sky_team', 'ag_best_fly', 'ag_airsom', 'ag_daruuro',
  'ag_transom', 'ag_damal', 'ag_asal', 'ag_safe', 'ag_mashad', 'ag_halla',
  'ag_taaj', 'ag_air_som_2'
];
async function initializeDatabase() {
  await db.exec(schema);
  if (!db.isPostgres) {
    const agencyColumns = new Set((await db.prepare('PRAGMA table_info(agencies)').all()).map(column => column.name));
    if (!agencyColumns.has('is_approved')) {
      await db.exec('ALTER TABLE agencies ADD COLUMN is_approved INTEGER NOT NULL DEFAULT 1 CHECK (is_approved IN (0, 1))');
    }
    for (const [column, definition] of [['logo_mime', 'TEXT'], ['logo_data', 'TEXT']]) {
      if (!agencyColumns.has(column)) await db.exec(`ALTER TABLE agencies ADD COLUMN ${column} ${definition}`);
    }
    const userColumns = new Set((await db.prepare('PRAGMA table_info(users)').all()).map(column => column.name));
    for (const [column, definition] of [
      ['avatar_mime', 'TEXT'], ['avatar_data', 'TEXT'],
      ['presence_status', "TEXT NOT NULL DEFAULT 'AVAILABLE'"], ['last_seen_at', 'TEXT'],
      ['typing_conversation_id', 'TEXT'], ['typing_until', 'TEXT']
    ]) {
      if (!userColumns.has(column)) await db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
    }
    const messageColumns = new Set((await db.prepare('PRAGMA table_info(messages)').all()).map(column => column.name));
    for (const [column, definition] of [
      ['message_type', "TEXT NOT NULL DEFAULT 'TEXT'"], ['attachment_mime', 'TEXT'],
      ['attachment_data', 'TEXT'], ['attachment_name', 'TEXT'], ['duration_ms', 'INTEGER'], ['edited_at', 'TEXT']
    ]) {
      if (!messageColumns.has(column)) await db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`);
    }
    const catalogColumns = new Set((await db.prepare('PRAGMA table_info(catalog_products)').all()).map(column => column.name));
    for (const [column, definition] of [
      ['available', 'INTEGER NOT NULL DEFAULT 1 CHECK (available >= 0)'],
      ['travel_date', 'TEXT'],
      ['baggage', "TEXT NOT NULL DEFAULT ''"],
      ['image_mime', 'TEXT'],
      ['image_data', 'TEXT'],
      ['is_published', 'INTEGER NOT NULL DEFAULT 1 CHECK (is_published IN (0, 1))']
    ]) {
      if (!catalogColumns.has(column)) await db.exec(`ALTER TABLE catalog_products ADD COLUMN ${column} ${definition}`);
    }
    const bookingColumns = new Set((await db.prepare('PRAGMA table_info(bookings)').all()).map(column => column.name));
    if (!bookingColumns.has('travel_date')) await db.exec('ALTER TABLE bookings ADD COLUMN travel_date TEXT');
    if (!bookingColumns.has('traveler_email')) await db.exec('ALTER TABLE bookings ADD COLUMN traveler_email TEXT');
    if (!bookingColumns.has('seat_count')) await db.exec('ALTER TABLE bookings ADD COLUMN seat_count INTEGER NOT NULL DEFAULT 1 CHECK (seat_count > 0)');
    if (!bookingColumns.has('offer_id')) await db.exec('ALTER TABLE bookings ADD COLUMN offer_id TEXT REFERENCES catalog_products(id) ON DELETE SET NULL');
    if (!bookingColumns.has('cancellation_reason')) await db.exec('ALTER TABLE bookings ADD COLUMN cancellation_reason TEXT');
    if (!bookingColumns.has('updated_at')) await db.exec('ALTER TABLE bookings ADD COLUMN updated_at TEXT');
    await db.exec("UPDATE bookings SET updated_at = COALESCE(updated_at, created_at) WHERE updated_at IS NULL");
    const bookingDocumentColumns = new Set((await db.prepare('PRAGMA table_info(booking_documents)').all()).map(column => column.name));
    for (const [column, definition] of [
      ['traveler_id', 'TEXT'], ['agency_id', 'TEXT'], ['storage_provider', "TEXT NOT NULL DEFAULT 'DATABASE'"],
      ['pdf_storage_path', 'TEXT'], ['jpg_storage_path', 'TEXT'], ['document_reference', 'TEXT'],
      ['document_version', 'INTEGER NOT NULL DEFAULT 1'], ['layout_version', 'INTEGER NOT NULL DEFAULT 1'],
      ['source_hash', 'TEXT'], ['email_delivery_status', 'TEXT'],
      ['email_sent_at', 'TEXT'], ['jpg_data', 'TEXT'], ['jpg_file_name', 'TEXT']
    ]) {
      if (!bookingDocumentColumns.has(column)) await db.exec(`ALTER TABLE booking_documents ADD COLUMN ${column} ${definition}`);
    }
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS booking_documents_reference_idx ON booking_documents(document_reference) WHERE document_reference IS NOT NULL');
    const deliveryColumns = new Set((await db.prepare('PRAGMA table_info(booking_document_deliveries)').all()).map(column => column.name));
    if (!deliveryColumns.has('document_version')) {
      await db.exec('ALTER TABLE booking_document_deliveries ADD COLUMN document_version INTEGER NOT NULL DEFAULT 1');
    }
  } else {
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
      CREATE UNIQUE INDEX IF NOT EXISTS password_reset_otps_email_lower_idx ON password_reset_otps (lower(email));
      CREATE UNIQUE INDEX IF NOT EXISTS users_single_super_admin_idx ON users (role) WHERE role = 'SUPER_ADMIN';
      ALTER TABLE agencies ADD COLUMN IF NOT EXISTS is_approved INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE agencies ADD COLUMN IF NOT EXISTS logo_mime TEXT;
      ALTER TABLE agencies ADD COLUMN IF NOT EXISTS logo_data TEXT;
      ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS available INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS travel_date TEXT;
      ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS baggage TEXT NOT NULL DEFAULT '';
      ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS image_mime TEXT;
      ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS image_data TEXT;
      ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS is_published INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS traveler_email TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS travel_date TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS seat_count INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS offer_id TEXT REFERENCES catalog_products(id) ON DELETE SET NULL;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TEXT;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS traveler_id TEXT;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS agency_id TEXT;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'DATABASE';
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS pdf_storage_path TEXT;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS jpg_storage_path TEXT;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS document_reference TEXT;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS document_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS layout_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS source_hash TEXT;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS email_delivery_status TEXT;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS email_sent_at TEXT;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS jpg_data TEXT;
      ALTER TABLE booking_documents ADD COLUMN IF NOT EXISTS jpg_file_name TEXT;
      ALTER TABLE booking_document_deliveries ADD COLUMN IF NOT EXISTS document_version INTEGER NOT NULL DEFAULT 1;
      UPDATE bookings SET updated_at = COALESCE(updated_at, created_at) WHERE updated_at IS NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_status TEXT NOT NULL DEFAULT 'AVAILABLE';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS typing_conversation_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS typing_until TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'TEXT';
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_mime TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_data TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TEXT;
    `);
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS booking_documents_reference_idx ON booking_documents(document_reference) WHERE document_reference IS NOT NULL');
  }

  await db.prepare(`
    UPDATE bookings
    SET offer_id = (
      SELECT products.id
      FROM catalog_products products
      WHERE products.agency_id = bookings.agency_id
        AND products.title = bookings.offer_title
        AND products.category = bookings.category
        AND (SELECT COUNT(*) FROM catalog_products matching
          WHERE matching.agency_id = bookings.agency_id
            AND matching.title = bookings.offer_title
            AND matching.category = bookings.category) = 1
    )
    WHERE offer_id IS NULL
  `).run();

  const demoAgencyPlaceholders = demoAgencyIds.map(() => '?').join(', ');
  const protectedDemoAgencyIds = new Set(
    (await db.prepare(`SELECT DISTINCT agency_id FROM users WHERE agency_id IN (${demoAgencyPlaceholders})`)
      .all(...demoAgencyIds))
      .map(row => row.agency_id)
  );
  const removableDemoAgencyIds = demoAgencyIds.filter(id => !protectedDemoAgencyIds.has(id));
  if (removableDemoAgencyIds.length) {
    const placeholders = removableDemoAgencyIds.map(() => '?').join(', ');
    await runInTransaction(async () => {
      await db.prepare(`DELETE FROM bookings WHERE agency_id IN (${placeholders})`).run(...removableDemoAgencyIds);
      await db.prepare(`DELETE FROM conversations WHERE agency_id IN (${placeholders})`).run(...removableDemoAgencyIds);
      await db.prepare(`DELETE FROM agency_clients WHERE agency_id IN (${placeholders})`).run(...removableDemoAgencyIds);
      await db.prepare(`
        DELETE FROM catalog_products
        WHERE agency_id IN (${placeholders}) OR id IN ('off_flt_01', 'off_flt_02', 'off_car_01')
      `).run(...removableDemoAgencyIds);
      await db.prepare(`DELETE FROM agencies WHERE id IN (${placeholders})`).run(...removableDemoAgencyIds);
    });
  }
  await db.prepare("DELETE FROM catalog_products WHERE id IN ('off_flt_01', 'off_flt_02', 'off_car_01')").run();
}

const dbReady = initializeDatabase();

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
  avatarData: user.avatar_data || null,
  presenceStatus: user.presence_status || 'AVAILABLE',
  lastSeenAt: user.last_seen_at || null
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

function sendChatAttachment(response, attachment) {
  const bytes = Buffer.from(attachment.attachment_data, 'base64');
  response.writeHead(200, {
    'Content-Type': attachment.attachment_mime,
    'Content-Length': bytes.length,
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(bytes);
}

function sendPdf(response, pdfData, fileName, download = false) {
  const bytes = Buffer.from(pdfData, 'base64');
  response.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': bytes.length,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${fileName.replace(/[^a-z0-9._-]/gi, '_')}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(bytes);
}

function sendJpg(response, jpgData, fileName, download = false) {
  const bytes = Buffer.from(jpgData, 'base64');
  response.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': bytes.length,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${fileName.replace(/[^a-z0-9._-]/gi, '_')}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(bytes);
}

function sendCatalogImage(response, image) {
  const bytes = Buffer.from(image.image_data, 'base64');
  response.writeHead(200, {
    'Content-Type': image.image_mime,
    'Content-Length': bytes.length,
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(bytes);
}

function publishCatalogChange(change = 'updated') {
  if (!catalogEventSubscribers.size) return;
  const event = `event: offers\ndata: ${JSON.stringify({ change, updatedAt: nowIso() })}\n\n`;
  for (const response of catalogEventSubscribers) {
    if (response.destroyed || response.writableEnded) {
      catalogEventSubscribers.delete(response);
      continue;
    }
    try {
      response.write(event);
    } catch {
      catalogEventSubscribers.delete(response);
    }
  }
}

function streamCatalogChanges(request, response) {
  if (!catalogRealtimeSupported) {
    sendJson(response, 404, { error: 'Live offer updates are not available on this server.' });
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff'
  });
  response.write('retry: 4000\nevent: ready\ndata: {}\n\n');
  catalogEventSubscribers.add(response);
  const heartbeat = setInterval(() => {
    if (response.destroyed || response.writableEnded) {
      clearInterval(heartbeat);
      catalogEventSubscribers.delete(response);
      return;
    }
    response.write(': keep-alive\n\n');
  }, 20_000);
  response.on('close', () => {
    clearInterval(heartbeat);
    catalogEventSubscribers.delete(response);
  });
  request.on('aborted', () => {
    clearInterval(heartbeat);
    catalogEventSubscribers.delete(response);
  });
}

function readJson(request, maxBytes = 16_384) {
  if (request.body !== undefined) {
    if (request.body && typeof request.body === 'object') {
      if (Buffer.byteLength(JSON.stringify(request.body)) > maxBytes) {
        return Promise.reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
      }
      return Promise.resolve(request.body);
    }
    try {
      return Promise.resolve(request.body ? JSON.parse(request.body) : {});
    } catch {
      return Promise.reject(Object.assign(new Error('Request must contain valid JSON.'), { statusCode: 400 }));
    }
  }
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

async function audit(actorId, action, target) {
  await db.prepare('INSERT INTO audit_logs (actor_id, action, target, created_at) VALUES (?, ?, ?, ?)').run(actorId || null, action, target, nowIso());
}

async function createSession(user, response) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + sessionMaxAge;
  await db.prepare('INSERT INTO sessions (id_hash, user_id, csrf_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), user.id, crypto.createHash('sha256').update(csrf).digest('hex'), expires, nowIso());
  response.setHeader('Set-Cookie', [
    `sk_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionMaxAge}${secureCookie}`,
    `sk_csrf=${csrf}; Path=/; SameSite=Strict; Max-Age=${sessionMaxAge}${secureCookie}`
  ]);
}

async function getSession(request) {
  const token = parseCookies(request).sk_session;
  if (!token) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const record = await db.prepare(`
    SELECT sessions.id_hash, sessions.csrf_hash, users.*
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id_hash = ? AND sessions.expires_at > ?
  `).get(hash, Math.floor(Date.now() / 1000));
  if (!record) return null;
  if (record.role === 'AGENCY' &&
      !await db.prepare("SELECT id FROM agencies WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1").get(record.agency_id)) {
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

async function getAccessibleConversation(id, user) {
  const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conversation) return null;
  if (user.role === 'SUPER_ADMIN') return conversation;
  if (user.role === 'AGENCY' && conversation.agency_id === user.agency_id) return conversation;
  if (user.role === 'CLIENT' && conversation.customer_id === user.id) return conversation;
  return null;
}

function notificationPublic(record) {
  return {
    id: record.id,
    recipientUserId: record.recipient_user_id || record.recipientUserId,
    agencyId: record.agency_id || record.agencyId || null,
    bookingId: record.booking_id || record.bookingId || null,
    conversationId: record.conversation_id || record.conversationId || null,
    type: record.type,
    title: record.title,
    body: record.body,
    href: record.href || null,
    createdAt: record.created_at || record.createdAt,
    readAt: record.read_at || record.readAt || null
  };
}

function publishNotification(userId, notification) {
  const clients = notificationEventSubscribers.get(userId);
  if (!clients) return;
  const payload = `event: notification\ndata: ${JSON.stringify(notification)}\n\n`;
  for (const client of [...clients]) {
    try { client.write(payload); } catch { clients.delete(client); }
  }
  if (clients.size === 0) notificationEventSubscribers.delete(userId);
}

async function deliverWebPush(userId, notification) {
  if (!webPushConfigured) return;
  const preferences = await db.prepare('SELECT desktop_push_enabled FROM notification_preferences WHERE user_id = ?').get(userId);
  if (preferences && Number(preferences.desktop_push_enabled) === 0) return;
  const subscriptions = await db.prepare('SELECT endpoint, subscription_json FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const subscription of subscriptions) {
    try {
      await webPush.sendNotification(JSON.parse(subscription.subscription_json), JSON.stringify({
        title: notification.title,
        body: notification.body,
        url: notification.href || '/',
        notificationId: notification.id
      }));
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subscription.endpoint);
      } else {
        console.warn('Web push delivery failed:', error.message);
      }
    }
  }
}

async function createConversationMessageNotifications(conversation, sender, message) {
  const recipients = conversation.customer_id && sender.id !== conversation.customer_id
    ? [{ id: conversation.customer_id }]
    : await db.prepare("SELECT id FROM users WHERE agency_id = ? AND role = 'AGENCY' AND id <> ?").all(conversation.agency_id, sender.id);
  const created = [];
  for (const recipient of recipients) {
    const notification = {
      id: crypto.randomUUID(), recipientUserId: recipient.id, agencyId: conversation.agency_id,
      bookingId: null, conversationId: conversation.id, type: 'MESSAGE', title: `New message from ${sender.name}`,
      body: `${message.body}`.slice(0, 220), href: `/?conversation=${encodeURIComponent(conversation.id)}`,
      createdAt: message.createdAt, readAt: null, dedupeKey: `MESSAGE:${message.id}:${recipient.id}`
    };
    const inserted = await db.prepare(`
      INSERT INTO notifications (id, recipient_user_id, agency_id, booking_id, conversation_id, type, title, body, href, dedupe_key, created_at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (dedupe_key) DO NOTHING
    `).run(notification.id, notification.recipientUserId, notification.agencyId, notification.bookingId, notification.conversationId,
      notification.type, notification.title, notification.body, notification.href, notification.dedupeKey, notification.createdAt, notification.readAt);
    if (inserted.changes === 1) created.push(notification);
  }
  for (const notification of created) {
    publishNotification(notification.recipientUserId, notification);
    deliverWebPush(notification.recipientUserId, notification).catch(error => console.warn('Web push message notification failed:', error.message));
  }
}

function createPdfBuffer(booking, qrBuffer, issuedAt, documentReference) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: [792, 310],
      margin: 0,
      info: { Title: 'SAFAR KAABE Booking Confirmation', Author: 'SAFAR KAABE' }
    });
    const chunks = [];
    document.on('data', chunk => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    try {
      const navy = '#202f7d';
      const ink = '#161923';
      const muted = '#687087';
      const compact = (value, limit) => {
        const normalized = String(value || '').replace(/\s+/g, ' ').trim();
        return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
      };
      const route = String(booking.routeBadge || booking.destination || 'Route unavailable').replace(/\s+/g, ' ').trim();
      const routeParts = route.split(/\s*(?:→|->|–|—)\s*/).map(part => part.trim().toUpperCase());
      const hasRouteCodes = routeParts.length === 2 && routeParts.every(part => /^[A-Z]{3}$/.test(part));
      const origin = hasRouteCodes ? routeParts[0] : route;
      const destination = hasRouteCodes ? routeParts[1] : null;
      const passenger = String(booking.travelerName || 'Traveler').replace(/\s+/g, ' ').trim();
      const provider = String(booking.supplierName || booking.offerTitle || 'Not listed').replace(/\s+/g, ' ').trim();
      const travelDate = String(booking.travelDate || 'Not confirmed').replace(/\s+/g, ' ').trim();
      const bookingReference = String(booking.reference || 'Unavailable').replace(/\s+/g, ' ').trim();
      const platformReference = String(booking.pnr || 'Not assigned').replace(/\s+/g, ' ').trim();
      const travelers = `${Math.max(1, Number(booking.seatCount) || 1)} ${Number(booking.seatCount) === 1 ? 'TRAVELER' : 'TRAVELERS'}`;
      const tripDetails = [
        booking.offerTitle && booking.offerTitle !== provider ? booking.offerTitle : null,
        booking.specs,
        booking.baggage && `Baggage: ${booking.baggage}`
      ].filter(Boolean).join(' | ') || 'Additional trip details not provided';
      const issuedTimestamp = `${String(issuedAt).replace('T', ' ').slice(0, 16)} UTC`;
      const drawText = (value, x, y, options = {}) => {
        document
          .fillColor(options.color || ink)
          .font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(options.size || 10)
          .text(String(value ?? ''), x, y, {
            width: options.width,
            align: options.align || 'left',
            lineBreak: false,
            ellipsis: true,
            characterSpacing: options.characterSpacing || 0
          });
      };
      const drawBox = (x, y, width, label, value, valueSize = 15) => {
        document.roundedRect(x, y, width, 51, 5).lineWidth(1.5).strokeColor(navy).fillAndStroke('#ffffff', navy);
        drawText(label, x + 5, y + 7, { size: 7.5, color: muted, bold: true, width: width - 10, align: 'center' });
        drawText(value, x + 5, y + 23, { size: valueSize, color: navy, bold: true, width: width - 10, align: 'center' });
      };

      document.save();
      document.roundedRect(1, 1, 790, 308, 14).clip();
      document.rect(0, 0, 792, 310).fill('#ffffff');
      document.rect(0, 0, 792, 46).fill(navy);
      document.rect(568, 46, 224, 242).fill('#f3f5fc');
      document.rect(0, 288, 792, 22).fill(navy);

      document.roundedRect(19, 7, 32, 32, 6).fill('#ffffff');
      const logo = ticketLogoBuffer(booking);
      if (logo) document.image(logo, 19, 7, { fit: [32, 32], align: 'center', valign: 'center' });
      else drawText('SK', 22, 12, { size: 20, color: navy, bold: true, width: 27, align: 'center' });
      drawText('SAFAR KAABE', 59, 8, { size: 20, color: '#ffffff', bold: true, width: 240 });
      drawText('TRAVEL BOOKING CONFIRMATION', 60, 30, { size: 7.5, color: '#dce4ff', bold: true, width: 280, characterSpacing: 0.7 });
      drawText('BOOKING CONFIRMATION', 326, 9, { size: 13, color: '#ffffff', bold: true, width: 226, align: 'right' });
      drawText('NOT AN AIRLINE BOARDING PASS', 326, 29, { size: 7.5, color: '#dce4ff', width: 226, align: 'right' });

      document.moveTo(568, 49).lineTo(568, 286).dash(4, { space: 4 }).strokeColor('#8f98b7').lineWidth(1).stroke().undash();
      document.circle(568, 46, 7).fill('#ffffff');
      document.circle(570, 288, 8).fill('#ffffff');

      drawText('PASSENGER', 24, 57, { size: 7.5, color: muted, bold: true, width: 100 });
      drawText(compact(passenger, 46), 24, 69, { size: 17, bold: true, width: 520 });
      drawText(`ISSUING AGENCY  |  ${compact(booking.agencyName || 'Travel agency', 32)}`, 24, 91, { size: 8, color: muted, width: 260 });
      drawText(`TRAVEL PROVIDER  |  ${compact(provider, 31)}`, 292, 91, { size: 8, color: muted, width: 260 });
      if (hasRouteCodes) {
        drawText(origin, 25, 108, { size: 31, bold: true, width: 130 });
        document.moveTo(202, 126).lineTo(236, 126).lineWidth(2.5).strokeColor(navy).stroke();
        document.moveTo(229, 121).lineTo(236, 126).lineTo(229, 131).lineWidth(2.5).strokeColor(navy).stroke();
        drawText(destination, 260, 108, { size: 31, bold: true, width: 130 });
        drawText('ORIGIN', 27, 141, { size: 7, color: muted, width: 100 });
        drawText('DESTINATION', 262, 141, { size: 7, color: muted, width: 120 });
      } else {
        drawText(compact(route, 70), 25, 113, { size: 20, bold: true, width: 500 });
        drawText('CONFIRMED ITINERARY', 27, 141, { size: 7, color: muted, width: 150 });
      }

      drawBox(24, 157, 164, 'BOOKING REFERENCE', compact(bookingReference, 18), 12);
      drawBox(200, 157, 164, 'CONFIRMED TRAVEL DATE', compact(travelDate, 18), 11);
      drawBox(376, 157, 164, 'TRAVELERS', travelers, 11);
      drawText('TRIP DETAILS', 25, 221, { size: 7, color: muted, bold: true, width: 100 });
      drawText(compact(tripDetails, 74), 25, 233, { size: 8, width: 516 });
      drawText('PLATFORM REQUEST  |  INTERNAL REFERENCE', 25, 255, { size: 6.5, color: muted, bold: true, width: 220 });
      drawText(compact(platformReference, 24), 25, 267, { size: 8, bold: true, width: 180 });
      drawText(`ISSUED  |  ${issuedTimestamp}`, 313, 267, { size: 7, color: muted, width: 220 });

      drawText('TRAVEL VOUCHER', 586, 57, { size: 9, color: navy, bold: true, width: 190 });
      drawText('PASSENGER', 586, 76, { size: 7, color: muted, bold: true, width: 190 });
      drawText(compact(passenger, 28), 586, 89, { size: 10, bold: true, width: 190 });
      drawText('CONFIRMED ROUTE', 586, 110, { size: 7, color: muted, bold: true, width: 190 });
      drawText(compact(route, 30), 586, 123, { size: 12, color: navy, bold: true, width: 190 });
      drawText(compact(travelDate, 24), 586, 143, { size: 8, color: muted, width: 190 });
      drawText('DOCUMENT REFERENCE', 586, 165, { size: 7, color: muted, bold: true, width: 190 });
      drawText(compact(documentReference, 26), 586, 178, { size: 8, bold: true, width: 190 });
      document.roundedRect(656, 194, 60, 60, 4).fill('#ffffff');
      document.image(qrBuffer, 660, 198, { fit: [52, 52] });
      drawText('SCAN TO VERIFY', 640, 259, { size: 6.5, color: muted, bold: true, width: 92, align: 'center' });
      drawText('Internal verification only', 620, 272, { size: 6, color: muted, width: 132, align: 'center' });

      drawText('Only confirmed booking details are shown. Not valid for boarding.', 24, 294, { size: 7, color: '#ffffff', bold: true, width: 520 });
      drawText('SAFAR KAABE BOOKING CONFIRMATION', 586, 294, { size: 6.5, color: '#ffffff', bold: true, width: 190 });
      document.restore();
      document.roundedRect(1, 1, 790, 308, 14).lineWidth(1.5).strokeColor('#c7cde0').stroke();
      document.end();
    } catch (error) {
      reject(error);
    }
  });
}

function escapeXml(value) {
  return String(value ?? 'Unavailable').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

async function createTicketJpgBuffer(pdfBuffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjsEntry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = `${path.resolve(path.dirname(pdfjsEntry), '..', '..', 'standard_fonts').split(path.sep).join('/')}/`;
  const loadingTask = getDocument({
    data: new Uint8Array(pdfBuffer),
    standardFontDataUrl,
    useWasm: false
  });
  const pdf = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 300 / 72 });
      const canvas = ticketCanvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      pages.push({
        buffer: canvas.toBuffer('image/jpeg', 92),
        width: canvas.width,
        height: canvas.height
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  if (!pages.length) throw new Error('PDF rendering did not produce any ticket pages.');
  if (pages.length === 1) return sharp(pages[0].buffer).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  const width = Math.max(...pages.map(page => page.width));
  const height = pages.reduce((total, page) => total + page.height, 0);
  let top = 0;
  const layers = pages.map(page => {
    const layer = { input: page.buffer, left: 0, top };
    top += page.height;
    return layer;
  });
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(layers)
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

function ticketDocumentPublic(document, origin) {
  const bookingId = document.booking_id || document.bookingId;
  const baseUrl = origin ? new URL(origin).origin : '';
  const pdfPath = `/api/bookings/${encodeURIComponent(bookingId)}/ticket.pdf`;
  const jpgPath = `/api/bookings/${encodeURIComponent(bookingId)}/ticket.jpg`;
  return {
    id: document.id,
    bookingId,
    documentReference: document.document_reference || document.documentReference || null,
    version: Number(document.document_version || document.documentVersion || 1),
    documentType: document.document_type || document.documentType,
    status: document.status,
    fileName: document.file_name || document.fileName,
    mimeType: document.mime_type || document.mimeType || 'application/pdf',
    issuedAt: document.issued_at || document.issuedAt || null,
    previewUrl: `${baseUrl}${pdfPath}`,
    downloadUrl: `${baseUrl}${pdfPath}?download=1`,
    jpgPreviewUrl: `${baseUrl}${jpgPath}`,
    jpgDownloadUrl: `${baseUrl}${jpgPath}?download=1`,
    jpgFileName: document.jpg_file_name || document.jpgFileName || `${(document.file_name || document.fileName || 'SAFAR-KAABE-ticket').replace(/\.pdf$/i, '')}.jpg`,
    emailDeliveryStatus: document.emailDeliveryStatus || document.email_delivery_status || null,
    emailSentAt: document.emailSentAt || document.email_sent_at || null
  };
}

function requestOrigin(request) {
  const forwardedHost = request.headers['x-forwarded-host'];
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || request.headers.host;
  if (typeof host !== 'string' || !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)) {
    throw Object.assign(new Error('Could not determine a safe public origin for this ticket request.'), { statusCode: 400 });
  }
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const protocol = process.env.VERCEL || request.socket.encrypted || forwardedProtocol === 'https' ? 'https' : 'http';
  return new URL(`${protocol}://${host}`).origin;
}

async function createTicketReadyNotification(booking, document) {
  if (!booking.customerId) return;
  const notification = {
    id: crypto.randomUUID(), recipientUserId: booking.customerId, agencyId: booking.agencyId,
    bookingId: booking.id, conversationId: null, type: 'TICKET_READY', title: 'Booking confirmation ready',
    body: `Your approved booking ${booking.reference} is ready to view and download.`,
    href: `/?booking=${encodeURIComponent(booking.id)}`, createdAt: document.issued_at || nowIso(), readAt: null,
    dedupeKey: `TICKET_READY:${booking.id}:${document.id}`
  };
  const inserted = await db.prepare(`
    INSERT INTO notifications (id, recipient_user_id, agency_id, booking_id, conversation_id, type, title, body, href, dedupe_key, created_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (dedupe_key) DO NOTHING
  `).run(notification.id, notification.recipientUserId, notification.agencyId, notification.bookingId, notification.conversationId,
    notification.type, notification.title, notification.body, notification.href, notification.dedupeKey, notification.createdAt, notification.readAt);
  if (inserted.changes === 1) {
    publishNotification(notification.recipientUserId, notification);
    deliverWebPush(notification.recipientUserId, notification).catch(error => console.warn('Ticket notification failed:', error.message));
  }
}

function ticketLogoBuffer(booking) {
  if (!booking.agencyLogoData || !['image/png', 'image/jpeg'].includes(booking.agencyLogoMime)) return null;
  const logo = Buffer.from(booking.agencyLogoData, 'base64');
  const validPng = booking.agencyLogoMime === 'image/png' && logo.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const validJpeg = booking.agencyLogoMime === 'image/jpeg' && logo.length > 3 && logo[0] === 0xff && logo[1] === 0xd8 && logo.at(-2) === 0xff && logo.at(-1) === 0xd9;
  if (!validPng && !validJpeg) {
    console.warn(`Ticket branding image is invalid for agency ${booking.agencyId}; using the SAFAR KAABE fallback mark.`);
    return null;
  }
  return logo;
}

async function deliverTicketReadyEmail(booking, document, origin) {
  const recipientEmail = booking.travelerEmail;
  if (!recipientEmail) {
    const reason = 'No traveler email is recorded for this booking.';
    await db.prepare('UPDATE booking_documents SET email_delivery_status = ?, email_sent_at = NULL, updated_at = ? WHERE id = ?')
      .run('FAILED', nowIso(), document.id);
    return { status: 'FAILED', error: reason };
  }
  const now = nowIso();
  const deliveryId = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const reservation = await db.prepare(`
    INSERT INTO booking_document_deliveries (id, document_id, recipient_email, document_version, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'PENDING', 1, ?, ?)
    ON CONFLICT (document_id, recipient_email) DO UPDATE
      SET status = 'PENDING', attempts = booking_document_deliveries.attempts + 1,
          document_version = excluded.document_version, last_error = NULL, updated_at = excluded.updated_at
      WHERE booking_document_deliveries.status = 'FAILED'
        OR (booking_document_deliveries.status = 'PENDING' AND booking_document_deliveries.updated_at < ?)
        OR booking_document_deliveries.document_version < excluded.document_version
  `).run(deliveryId, document.id, recipientEmail, Number(document.document_version || 1), now, now, staleBefore);
  const delivery = await db.prepare('SELECT * FROM booking_document_deliveries WHERE document_id = ? AND recipient_email = ?')
    .get(document.id, recipientEmail);
  if (delivery?.status === 'SENT') return { status: 'SENT', sentAt: delivery.sent_at };
  if (!reservation.changes && delivery?.status === 'PENDING') return { status: 'PENDING' };
  await db.prepare('UPDATE booking_documents SET email_delivery_status = ?, updated_at = ? WHERE id = ?')
    .run('PENDING', now, document.id);
  try {
    const transport = passwordResetTransport();
    if (!transport) throw new Error('SMTP is not configured; the document is ready in My Trips & Vouchers.');
    const baseUrl = new URL(origin).origin;
    const previewUrl = `${baseUrl}/?booking=${encodeURIComponent(booking.id)}`;
    const pdfUrl = `${baseUrl}/api/bookings/${encodeURIComponent(booking.id)}/ticket.pdf?download=1`;
    const jpgUrl = `${baseUrl}/api/bookings/${encodeURIComponent(booking.id)}/ticket.jpg?download=1`;
    const pdfBytes = Buffer.from(document.pdf_data, 'base64');
    const jpgBytes = document.jpg_data ? Buffer.from(document.jpg_data, 'base64') : null;
    const logo = ticketLogoBuffer(booking);
    const logoDataUrl = logo ? `data:${booking.agencyLogoMime};base64,${logo.toString('base64')}` : '';
    const itinerary = booking.routeBadge || booking.destination;
    const issueDate = document.issued_at || now;
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipientEmail,
      subject: `SAFAR KAABE booking confirmation ${booking.reference}`,
      text: `Your SAFAR KAABE booking confirmation ${booking.reference} from ${booking.agencyName} is ready. Passenger: ${booking.travelerName}. Route: ${itinerary}. Travel date: ${booking.travelDate}. Preview: ${previewUrl}. PDF: ${pdfUrl}. JPG: ${jpgUrl}. Sign in to access your documents.`,
      html: `<div style="font-family:Arial,sans-serif;color:#101b32;max-width:640px">${logoDataUrl ? `<img src="${logoDataUrl}" alt="${escapeXml(booking.agencyName)}" width="96" style="max-height:64px;object-fit:contain">` : ''}<h2>SAFAR KAABE booking confirmation</h2><p>Your approved booking <strong>${escapeXml(booking.reference)}</strong> from <strong>${escapeXml(booking.agencyName)}</strong> is ready.</p><p><strong>Passenger:</strong> ${escapeXml(booking.travelerName)}<br><strong>Route:</strong> ${escapeXml(itinerary)}<br><strong>Travel date:</strong> ${escapeXml(booking.travelDate)}<br><strong>Agency contact:</strong> ${escapeXml(booking.agencyEmail || booking.agencyPhone || 'Not available')}<br><strong>Issued:</strong> ${escapeXml(issueDate)}</p><p><a href="${escapeXml(previewUrl)}">My Trips & Vouchers</a> (sign-in required)</p><p><a href="${escapeXml(pdfUrl)}">Secure PDF download</a> · <a href="${escapeXml(jpgUrl)}">Secure JPG download</a> (sign-in required)</p><p>This is an agency booking confirmation, not an airline e-ticket unless airline issuance has been separately verified.</p></div>`,
      attachments: [
        { filename: document.file_name, content: pdfBytes, contentType: 'application/pdf' },
        ...(jpgBytes && jpgBytes.length <= 5_000_000 ? [{ filename: document.jpg_file_name, content: jpgBytes, contentType: 'image/jpeg' }] : [])
      ]
    });
    const sentAt = nowIso();
    await db.prepare('UPDATE booking_document_deliveries SET status = \'SENT\', sent_at = ?, updated_at = ?, last_error = NULL WHERE document_id = ? AND recipient_email = ?')
      .run(sentAt, sentAt, document.id, recipientEmail);
    await db.prepare('UPDATE booking_documents SET email_delivery_status = ?, email_sent_at = ?, updated_at = ? WHERE id = ?')
      .run('SENT', sentAt, sentAt, document.id);
    return { status: 'SENT', sentAt };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    const failedAt = nowIso();
    await db.prepare('UPDATE booking_document_deliveries SET status = \'FAILED\', last_error = ?, updated_at = ? WHERE document_id = ? AND recipient_email = ?')
      .run(message, failedAt, document.id, recipientEmail);
    await db.prepare('UPDATE booking_documents SET email_delivery_status = ?, email_sent_at = NULL, updated_at = ? WHERE id = ?')
      .run('FAILED', failedAt, document.id);
    console.error(`Ticket email delivery failed for booking ${booking.id}, document ${document.id}:`, error);
    return { status: 'FAILED', error: message };
  }
}

function ticketSourceHash(booking) {
  return crypto.createHash('sha256').update(JSON.stringify({
    ticketLayoutVersion,
    bookingId: booking.id,
    reference: booking.reference,
    requestNumber: booking.pnr,
    travelerName: booking.travelerName,
    travelerEmail: booking.travelerEmail,
    travelerPhone: booking.phone,
    travelerCount: booking.seatCount,
    agencyId: booking.agencyId,
    agencyName: booking.agencyName,
    agencyPhone: booking.agencyPhone,
    agencyEmail: booking.agencyEmail,
    agencyLogoMime: booking.agencyLogoMime,
    agencyLogoData: booking.agencyLogoData,
    offerTitle: booking.offerTitle,
    route: booking.routeBadge || booking.destination,
    travelDate: booking.travelDate,
    supplierName: booking.supplierName,
    supplierRef: booking.supplierRef,
    category: booking.category,
    baggage: booking.baggage,
    specs: booking.specs
  })).digest('hex');
}

async function isValidStoredTicket(document) {
  if (!document?.pdf_data || !document.jpg_data) return false;
  const pdf = Buffer.from(document.pdf_data, 'base64');
  if (pdf.length < 16 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-' || !pdf.toString('latin1').includes('%%EOF')) return false;
  try {
    const metadata = await sharp(Buffer.from(document.jpg_data, 'base64')).metadata();
    return metadata.format === 'jpeg' && metadata.width > 0 && metadata.height > 0;
  } catch {
    return false;
  }
}

async function ensureBookingTicketDocument(bookingId, origin) {
  const booking = await db.prepare(`
    SELECT b.id, b.reference, b.pnr, b.agency_id AS agencyId, b.offer_id AS offerId, b.customer_id AS customerId,
           b.traveler_name AS travelerName, b.traveler_email AS travelerEmail, b.phone, b.offer_title AS offerTitle,
           b.state, b.travel_date AS travelDate, b.seat_count AS seatCount, b.created_at AS createdAtUtc,
           a.name AS agencyName, a.logo_mime AS agencyLogoMime, a.logo_data AS agencyLogoData,
           (SELECT email FROM users WHERE users.agency_id = a.id AND users.role = 'AGENCY' ORDER BY users.created_at LIMIT 1) AS agencyEmail,
           (SELECT phone FROM users WHERE users.agency_id = a.id AND users.role = 'AGENCY' ORDER BY users.created_at LIMIT 1) AS agencyPhone,
           c.route_badge AS routeBadge, c.destination, c.category, c.supplier_name AS supplierName, c.supplier_ref AS supplierRef,
           c.baggage, c.specs
    FROM bookings b JOIN agencies a ON a.id = b.agency_id
    LEFT JOIN catalog_products c ON c.id = b.offer_id
    WHERE b.id = ?
  `).get(bookingId);
  if (!booking) throw Object.assign(new Error('Booking not found.'), { statusCode: 404 });
  if (booking.state !== 'ACCEPTED') throw Object.assign(new Error('A ticket confirmation is available only after agency approval.'), { statusCode: 409 });
  let existing = await db.prepare("SELECT * FROM booking_documents WHERE booking_id = ? AND document_type = 'BOOKING_CONFIRMATION'").get(bookingId);
  const missingDetails = [
    !booking.travelerName && 'passenger name',
    !booking.reference && 'booking reference',
    !booking.offerTitle && 'trip name',
    !booking.agencyName && 'issuing agency',
    !booking.travelDate && 'confirmed travel date',
    !(booking.routeBadge || booking.destination) && 'trip route'
  ].filter(Boolean);
  if (missingDetails.length) {
    const message = `Ticket generation needs the following booking details: ${missingDetails.join(', ')}. Update the booking details before retrying.`;
    if (existing?.status === 'PROCESSING' && Date.now() - Date.parse(existing.updated_at || 0) < 5 * 60 * 1000) {
      throw Object.assign(new Error('The booking confirmation is already being generated. Please try again shortly.'), { statusCode: 409 });
    }
    if (existing?.status === 'READY') {
      await db.prepare('UPDATE booking_documents SET error_message = ?, updated_at = ? WHERE id = ? AND status = \'READY\'')
        .run(message, nowIso(), existing.id);
    } else {
      const now = nowIso();
      const safeReference = String(booking.reference || bookingId).replace(/[^a-z0-9_-]/gi, '_');
      await db.prepare(`
        INSERT INTO booking_documents (
          id, booking_id, traveler_id, agency_id, document_type, status, file_name,
          verification_token_hash, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'BOOKING_CONFIRMATION', 'FAILED', ?, ?, ?, ?, ?)
        ON CONFLICT (booking_id, document_type) DO UPDATE SET
          status = 'FAILED', error_message = excluded.error_message, updated_at = excluded.updated_at
        WHERE booking_documents.status <> 'READY'
      `).run(existing?.id || crypto.randomUUID(), bookingId, booking.customerId, booking.agencyId,
        `SAFAR-KAABE-Booking-Voucher-${safeReference}.pdf`, crypto.createHash('sha256').update(crypto.randomBytes(24)).digest('hex'),
        message, existing?.created_at || now, now);
    }
    console.warn(`Ticket generation validation failed for booking ${bookingId}: ${message}`);
    throw Object.assign(new Error(message), { statusCode: 409 });
  }
  const sourceHash = ticketSourceHash(booking);
  if (existing?.status === 'READY' && existing.source_hash === sourceHash && await isValidStoredTicket(existing)) {
    const email = await deliverTicketReadyEmail(booking, existing, origin);
    return { booking, document: ticketDocumentPublic(existing, origin), email };
  }
  const originalDocument = existing?.status === 'READY' ? existing : null;
  const documentId = existing?.id || crypto.randomUUID();
  const verificationToken = crypto.randomBytes(24).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(verificationToken).digest('hex');
  let savedDocument = null;
  const now = nowIso();
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const safeReference = String(booking.reference).replace(/[^a-z0-9_-]/gi, '_');
  if (existing?.status === 'READY') {
    await db.prepare(`
      INSERT INTO booking_document_versions (
        document_id, booking_id, document_reference, document_version, verification_token_hash,
        document_hash, status, issued_at, created_at
      )
      SELECT id, booking_id, document_reference, document_version, verification_token_hash,
             document_hash, 'SUPERSEDED', issued_at, ?
      FROM booking_documents WHERE id = ? AND status = 'READY'
      ON CONFLICT (document_id, document_version) DO NOTHING
    `).run(now, existing.id);
  }
  const reservation = await db.prepare(`
    INSERT INTO booking_documents (
      id, booking_id, traveler_id, agency_id, document_type, status, file_name, mime_type,
      storage_provider, document_reference, document_version, source_hash, verification_token_hash, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 'BOOKING_CONFIRMATION', 'PROCESSING', ?, 'application/pdf',
      'DATABASE', ?, 1, ?, ?, ?, ?)
    ON CONFLICT (booking_id, document_type) DO UPDATE SET
      status = 'PROCESSING',
      traveler_id = excluded.traveler_id,
      agency_id = excluded.agency_id,
      file_name = excluded.file_name,
      document_reference = CASE WHEN booking_documents.source_hash IS DISTINCT FROM excluded.source_hash
        THEN excluded.document_reference ELSE booking_documents.document_reference END,
      document_version = CASE WHEN booking_documents.status = 'READY'
        THEN booking_documents.document_version + 1 ELSE booking_documents.document_version END,
      source_hash = excluded.source_hash,
      verification_token_hash = excluded.verification_token_hash,
      error_message = NULL,
      pdf_data = NULL,
      jpg_data = NULL,
      jpg_file_name = NULL,
      pdf_storage_path = NULL,
      jpg_storage_path = NULL,
      document_hash = NULL,
      updated_at = excluded.updated_at
    WHERE booking_documents.status <> 'PROCESSING' OR booking_documents.updated_at < ?
  `).run(documentId, bookingId, booking.customerId, booking.agencyId, `SAFAR-KAABE-Booking-Voucher-${safeReference}.pdf`,
    `SK-${safeReference}-V1`, sourceHash, tokenHash, existing?.created_at || now, now, staleBefore);
  existing = await db.prepare("SELECT * FROM booking_documents WHERE booking_id = ? AND document_type = 'BOOKING_CONFIRMATION'").get(bookingId);
  if (!reservation.changes) {
    if (existing?.status === 'READY' && existing.source_hash === sourceHash && await isValidStoredTicket(existing)) {
      const email = await deliverTicketReadyEmail(booking, existing, origin);
      return { booking, document: ticketDocumentPublic(existing, origin), email };
    }
    throw Object.assign(new Error('The booking confirmation is already being generated. Please try again shortly.'), { statusCode: 409 });
  }
  const documentVersion = Number(existing.document_version || 1);
  const documentReference = `SK-${safeReference}-V${documentVersion}`;
  try {
    const verificationUrl = `${origin}/api/tickets/${encodeURIComponent(documentId)}/verify?token=${encodeURIComponent(verificationToken)}`;
    const qrDataUrl = await QRCode.toDataURL(verificationUrl, { errorCorrectionLevel: 'M', margin: 1, width: 180 });
    const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    const issuedAt = nowIso();
    const pdf = await createPdfBuffer(booking, qrBuffer, issuedAt, documentReference);
    if (pdf.length < 100 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-' || !pdf.toString('latin1').includes('%%EOF')) {
      throw new Error('PDF rendering returned an invalid or incomplete PDF file.');
    }
    const jpg = await createTicketJpgBuffer(pdf);
    const jpgMetadata = await sharp(jpg).metadata();
    if (jpgMetadata.format !== 'jpeg' || jpgMetadata.width < 1200 || jpgMetadata.height < 700) {
      throw new Error('Ticket image rendering returned an invalid or low-resolution JPEG.');
    }
    const base64 = pdf.toString('base64');
    const jpgBase64 = jpg.toString('base64');
    const hash = crypto.createHash('sha256').update(pdf).digest('hex');
    const pdfPath = `booking-documents/${booking.id}/v${documentVersion}/${documentReference}.pdf`;
    const jpgFileName = `SAFAR-KAABE-Booking-Voucher-${safeReference}.jpg`;
    const jpgPath = `booking-documents/${booking.id}/v${documentVersion}/${documentReference}.jpg`;
    await db.prepare(`UPDATE booking_documents SET status = 'READY', storage_provider = 'DATABASE',
      pdf_storage_path = ?, jpg_storage_path = ?, document_reference = ?, pdf_data = ?, jpg_data = ?,
      jpg_file_name = ?, document_hash = ?, issued_at = ?, layout_version = ?, updated_at = ?, error_message = NULL
      WHERE id = ? AND status = 'PROCESSING'`).run(pdfPath, jpgPath, documentReference, base64, jpgBase64, jpgFileName, hash, issuedAt, ticketLayoutVersion, issuedAt, documentId);
    const ready = await db.prepare('SELECT * FROM booking_documents WHERE id = ?').get(documentId);
    if (ready?.status !== 'READY') throw new Error('The generated ticket was not saved as a ready document.');
    savedDocument = ready;
    try {
      await createTicketReadyNotification(booking, ready);
    } catch (notificationError) {
      console.error(`Ticket notification failed for booking ${bookingId}, document ${documentId}:`, notificationError);
    }
    const email = await deliverTicketReadyEmail(booking, ready, origin);
    return { booking, document: ticketDocumentPublic(ready, origin), email };
  } catch (error) {
    const message = String(error.message || 'Unknown PDF generation error').slice(0, 500);
    const failedAt = nowIso();
    if (savedDocument) {
      await db.prepare(`UPDATE booking_documents SET email_delivery_status = 'FAILED', email_sent_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'READY' AND document_version = ? AND COALESCE(email_delivery_status, '') <> 'SENT'`)
        .run(failedAt, documentId, documentVersion);
      const ready = await db.prepare('SELECT * FROM booking_documents WHERE id = ? AND status = \'READY\'').get(documentId);
      console.error(`Ticket stored for booking ${bookingId}, but follow-up delivery failed for document ${documentId}:`, error);
      if (ready) {
        return {
          booking,
          document: ticketDocumentPublic(ready, origin),
          email: { status: ready.email_delivery_status || 'FAILED', error: 'Ticket was saved, but email delivery could not be confirmed. Retry email delivery.' }
        };
      }
    }
    if (originalDocument) {
      await db.prepare(`UPDATE booking_documents SET status = 'READY', file_name = ?, mime_type = ?,
        storage_provider = ?, pdf_storage_path = ?, jpg_storage_path = ?, document_reference = ?,
        document_version = ?, layout_version = ?, source_hash = ?, pdf_data = ?, jpg_data = ?, jpg_file_name = ?,
        document_hash = ?, verification_token_hash = ?, error_message = ?, issued_at = ?, updated_at = ?
        WHERE id = ? AND status = 'PROCESSING'`).run(
        originalDocument.file_name, originalDocument.mime_type, originalDocument.storage_provider,
        originalDocument.pdf_storage_path, originalDocument.jpg_storage_path, originalDocument.document_reference,
        originalDocument.document_version, originalDocument.layout_version || 1, originalDocument.source_hash, originalDocument.pdf_data,
        originalDocument.jpg_data, originalDocument.jpg_file_name, originalDocument.document_hash,
        originalDocument.verification_token_hash, message, originalDocument.issued_at, failedAt, documentId
      );
      await db.prepare('DELETE FROM booking_document_versions WHERE document_id = ? AND document_version = ?')
        .run(documentId, originalDocument.document_version);
    } else {
      await db.prepare(`UPDATE booking_documents SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ? AND status = 'PROCESSING'`)
        .run(message, failedAt, documentId);
    }
    console.error(`Ticket generation failed for booking ${bookingId}, document ${documentId}, version ${documentVersion}:`, error);
    throw Object.assign(new Error(`Ticket generation failed: ${message}`), { statusCode: 503, cause: error });
  }
}

function conversationPeerPredicate(role) {
  if (role === 'CLIENT') return `((peer.role = 'AGENCY' AND peer.agency_id = c.agency_id) OR (c.agency_id IS NULL AND peer.role = 'SUPER_ADMIN'))`;
  if (role === 'AGENCY') return `(peer.id = c.customer_id OR (c.customer_id IS NULL AND peer.role = 'SUPER_ADMIN'))`;
  return `(peer.id = c.customer_id OR (c.customer_id IS NULL AND peer.role = 'AGENCY' AND peer.agency_id = c.agency_id))`;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) {
    throw Object.assign(new Error('Password must be at least 12 characters long.'), { statusCode: 400 });
  }
  return value;
}

function validateImageData(data, mime) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime) ||
      typeof data !== 'string' || data.length > Math.ceil(maxCatalogImageBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw Object.assign(new Error(`Choose a PNG, JPEG, or WebP image no larger than ${maxCatalogImageBytes / 1024} KB.`), { statusCode: 400 });
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.length > maxCatalogImageBytes) {
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

async function allowRateLimitRequest(key, windowMs, limit) {
  const now = Date.now();
  const updated = await db.prepare(`
    INSERT INTO auth_rate_limits (key, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN auth_rate_limits.expires_at <= ? THEN 1 ELSE auth_rate_limits.attempts + 1 END,
      expires_at = CASE WHEN auth_rate_limits.expires_at <= ? THEN ? ELSE auth_rate_limits.expires_at END
    RETURNING attempts
  `).get(key, now + windowMs, now, now, now + windowMs);
  return updated.attempts <= limit;
}

function clientIp(request) {
  const address = request.headers['x-real-ip'] || request.socket?.remoteAddress || 'unknown';
  return String(address).slice(0, 64);
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  const method = request.method || 'GET';
  const session = await getSession(request);
  const user = session?.user || null;
  if (method === 'GET' && pathname === '/api/payments/methods') {
    const config = getWaafiConfig();
    sendJson(response, 200, { waafiEnabled: Boolean(config), waafiEnvironment: config ? (config.sandbox ? 'sandbox' : 'production') : null });
    return;
  }
  if (method === 'GET' && ['/api/payments/waafi/success', '/api/payments/waafi/failure'].includes(pathname)) {
    const referenceId = String(url.searchParams.get('referenceId') || '').slice(0, 80);
    let destination = 'pending';
    if (referenceId) {
      try {
        const payment = await refreshWaafiPayment(referenceId);
        destination = payment?.status === 'APPROVED' ? 'success'
          : ['DECLINED', 'FAILED'].includes(payment?.status) ? 'failed' : 'pending';
      } catch (error) {
        console.error('Unable to verify WaafiPay return:', error.message);
      }
    }
    const target = new URL('/the%20style.html', `https://${request.headers.host || 'travel-agancey-app.vercel.app'}`);
    target.searchParams.set('payment', destination);
    response.writeHead(303, { Location: target.toString(), 'Cache-Control': 'no-store' }).end();
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.origin;
    const expectedOrigin = `http://${request.headers.host}`;
    const expectedSecureOrigin = `https://${request.headers.host}`;
    if (origin && origin !== expectedOrigin && origin !== expectedSecureOrigin) {
      sendJson(response, 403, { error: 'Cross-origin requests are not allowed.' });
      return;
    }
  }

  if (method === 'GET' && pathname === '/api/catalog/realtime') {
    sendJson(response, 200, { supported: catalogRealtimeSupported });
    return;
  }

  if (method === 'GET' && pathname === '/api/catalog/stream') {
    streamCatalogChanges(request, response);
    return;
  }

  if (!user && method === 'GET' && pathname === '/api/agencies/active') {
    const agencies = await db.prepare(`SELECT agencies.id, agencies.name,
      (SELECT users.email FROM users WHERE users.agency_id = agencies.id AND users.role = 'AGENCY'
        ORDER BY users.created_at, users.email LIMIT 1) AS contactEmail
      FROM agencies WHERE agencies.status = 'ACTIVE' AND agencies.is_approved = 1 ORDER BY agencies.name, agencies.id`).all();
    const sanitizedAgencies = agencies.map(({ contactEmail, ...agency }) =>
      contactEmail ? { ...agency, contactEmail } : agency
    );
    sendJson(response, 200, { agencies: sanitizedAgencies });
    return;
  }

  if (!user && method === 'GET' && pathname === '/api/catalog') {
    const catalog = await db.prepare(`
      SELECT p.id, p.category, p.title AS titleEn, p.title_so AS titleSo, p.destination,
             p.route_badge AS routeBadge, p.specs, p.supplier_name AS supplierName,
             p.supplier_ref AS supplierRef, p.agency_id AS agencyId, p.base_cents AS baseUsdCents,
             p.tax_cents AS taxUsdCents, p.supplier_commission_pct AS supplierCommPct,
             p.available, p.travel_date AS travelDate, p.baggage, p.is_published AS published,
             CASE WHEN p.image_data IS NOT NULL THEN '/api/catalog/' || p.id || '/image' ELSE NULL END AS imageUrl,
             p.base_cents + p.tax_cents + CAST(ROUND(p.base_cents * a.markup_pct / 100.0) AS INTEGER) + 1200 AS estimatedTotalUsdCents
      FROM catalog_products p
      JOIN agencies a ON a.id = p.agency_id
      WHERE p.is_published = 1 AND p.available > 0
        AND a.status = 'ACTIVE' AND a.is_approved = 1
        AND (p.travel_date IS NULL OR p.travel_date >= date('now'))
      ORDER BY p.title
    `).all();
    sendJson(response, 200, { catalog });
    return;
  }

  const catalogImageMatch = pathname.match(/^\/api\/catalog\/([0-9a-f-]+)\/image$/i);
  if (method === 'GET' && catalogImageMatch) {
    const image = await db.prepare(`
      SELECT p.agency_id AS agencyId, p.image_mime AS imageMime, p.image_data AS imageData,
             p.is_published AS published, p.available, p.travel_date AS travelDate,
             a.status AS agencyStatus, a.is_approved AS agencyApproved
      FROM catalog_products p
      JOIN agencies a ON a.id = p.agency_id
      WHERE p.id = ?
    `).get(catalogImageMatch[1]);
    const isOwner = user?.role === 'AGENCY' && image?.agencyId === user.agency_id;
    const isAdmin = user?.role === 'SUPER_ADMIN';
    const isPublic = image?.published === 1 && image.available > 0 &&
      image.agencyStatus === 'ACTIVE' && image.agencyApproved === 1 &&
      (!image.travelDate || image.travelDate >= new Date().toISOString().slice(0, 10));
    if (!image?.imageData || (!isOwner && !isAdmin && !isPublic)) {
      sendJson(response, 404, { error: 'Listing image not found.' });
      return;
    }
    sendCatalogImage(response, { image_mime: image.imageMime, image_data: image.imageData });
    return;
  }

  if (method === 'GET' && pathname === '/api/setup/status') {
    const configured = Boolean(await db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1").get());
    const status = { configured };
    if (process.env.VERCEL) status.setupTokenRequired = !configured;
    sendJson(response, 200, status);
    return;
  }

  if (method === 'GET' && pathname === '/api/app-version') {
    const releaseId = process.env.VERCEL_DEPLOYMENT_ID ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      'local';
    sendJson(response, 200, { releaseId });
    return;
  }

  if (method === 'POST' && pathname === '/api/setup/admin') {
    const body = await readJson(request);
    const name = requireString(body.name, 'Name');
    const email = normalizeEmail(body.email);
    const password = validatePassword(body.password);
    if (process.env.VERCEL) {
      const setupToken = process.env.INITIAL_ADMIN_SETUP_TOKEN;
      if (!setupToken) {
        sendJson(response, 503, { error: 'Initial administrator setup is not configured. Set INITIAL_ADMIN_SETUP_TOKEN in Vercel first.' });
        return;
      }
      if (!safeEqual(body.setupToken, setupToken)) {
        sendJson(response, 403, { error: 'Enter the one-time administrator setup token configured by the system administrator.' });
        return;
      }
    }
    if (await db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1").get()) {
      sendJson(response, 409, { error: 'Super Admin setup has already been completed. Sign in instead.' });
      return;
    }
    const credentials = await hashPassword(password);
    const admin = { id: crypto.randomUUID(), email, name, phone: '', role: 'SUPER_ADMIN', agency_id: null };
    try {
      await runInTransaction(async () => {
        if (await db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1").get()) throw Object.assign(new Error('Super Admin setup has already been completed.'), { statusCode: 409 });
        await db.prepare('INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(admin.id, admin.email, admin.name, '', credentials.salt, credentials.hash, admin.role, nowIso());
        await audit(admin.id, 'INITIAL_SUPER_ADMIN_CREATED', admin.email);
      });
    } catch (error) {
      if (error.statusCode === 409 || error.constraint === 'users_single_super_admin_idx') {
        sendJson(response, 409, { error: 'Super Admin setup has already been completed. Sign in instead.' });
        return;
      }
      if (error.code === '23505' || String(error.message).includes('UNIQUE constraint failed')) {
        sendJson(response, 409, { error: 'An account with that email already exists. Use a different email address.' });
        return;
      }
      throw error;
    }
    await createSession(admin, response);
    sendJson(response, 201, { user: publicUser(admin) });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/password-reset/request') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const ip = clientIp(request);
    if (!await allowRateLimitRequest(`ip:${ip}`, passwordResetRateWindowMs, passwordResetRequestLimit) ||
        !await allowRateLimitRequest(`email:${email}`, passwordResetRateWindowMs, passwordResetRequestLimit)) {
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
    const account = await db.prepare('SELECT id, email FROM users WHERE email = ? COLLATE NOCASE').get(email);
    if (account) {
      const code = String(crypto.randomInt(100000, 1000000));
      const credentials = await hashPassword(code);
      const createdAt = Date.now();
      await db.prepare(`
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
        await db.prepare('DELETE FROM password_reset_otps WHERE email = ?').run(email);
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
    const reset = await db.prepare('SELECT * FROM password_reset_otps WHERE email = ? COLLATE NOCASE').get(email);
    if (!reset || !code || reset.expires_at <= Date.now() || reset.attempts >= passwordResetAttemptsLimit) {
      if (reset && (reset.expires_at <= Date.now() || reset.attempts >= passwordResetAttemptsLimit)) {
        await db.prepare('DELETE FROM password_reset_otps WHERE email = ?').run(email);
      }
      sendJson(response, 400, { error: 'The reset code is invalid or expired. Request a new code.' });
      return;
    }
    const supplied = await hashPassword(code, reset.password_salt);
    if (!safeEqual(supplied.hash, reset.password_hash)) {
      const attempts = reset.attempts + 1;
      await db.prepare('UPDATE password_reset_otps SET attempts = ? WHERE email = ?').run(attempts, email);
      if (attempts >= passwordResetAttemptsLimit) await db.prepare('DELETE FROM password_reset_otps WHERE email = ?').run(email);
      sendJson(response, 400, { error: 'The reset code is invalid or expired. Request a new code.' });
      return;
    }
    const credentials = await hashPassword(newPassword);
    await runInTransaction(async () => {
      await db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
        .run(credentials.salt, credentials.hash, reset.user_id);
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);
      await db.prepare('DELETE FROM password_reset_otps WHERE email = ?').run(email);
      await audit(reset.user_id, 'ACCOUNT_PASSWORD_RESET', email);
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
      await db.prepare('INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(customer.id, email, name, phone, credentials.salt, credentials.hash, customer.role, nowIso());
    } catch (error) {
      if (error.code === '23505' || String(error.message).includes('UNIQUE constraint failed')) {
        sendJson(response, 409, { error: 'An account with that email already exists. Sign in instead.' });
        return;
      }
      throw error;
    }
    await audit(customer.id, 'CUSTOMER_ACCOUNT_REGISTERED', email);
    await createSession(customer, response);
    sendJson(response, 201, { user: publicUser(customer) });
    return;
  }

  if (method === 'PATCH' && pathname === '/api/auth/profile') {
    if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
    if (!authorizeMutation(request, response, session)) return;
    const body = await readJson(request);
    const name = requireString(body.name, 'Name');
    const phone = requireString(body.phone, 'Phone', 40);
    await db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone, user.id);
    await audit(user.id, 'ACCOUNT_PROFILE_UPDATED', user.email);
    sendJson(response, 200, { user: publicUser({ ...user, name, phone }) });
    return;
  }

  if (method === 'PUT' && pathname === '/api/auth/avatar') {
    if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
    if (!authorizeMutation(request, response, session)) return;
    const body = await readJson(request, 400_000);
    const mime = requireString(body.mime, 'Image type', 32);
    const imageData = body.data === null ? null : validateImageData(body.data, mime);
    await db.prepare('UPDATE users SET avatar_mime = ?, avatar_data = ? WHERE id = ?')
      .run(imageData ? mime : null, imageData, user.id);
    await audit(user.id, imageData ? 'ACCOUNT_AVATAR_UPDATED' : 'ACCOUNT_AVATAR_REMOVED', user.email);
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
    await db.prepare('UPDATE agencies SET logo_mime = ?, logo_data = ? WHERE id = ?')
      .run(imageData ? mime : null, imageData, user.agency_id);
    await audit(user.id, imageData ? 'AGENCY_LOGO_UPDATED' : 'AGENCY_LOGO_REMOVED', user.agency_id);
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
    await runInTransaction(async () => {
      await db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
        .run(credentials.salt, credentials.hash, user.id);
      await db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?')
        .run(user.id, session.session.id_hash);
      await audit(user.id, 'ACCOUNT_PASSWORD_CHANGED', user.email);
    });
    sendJson(response, 200, { ok: true, message: 'Password updated. Other signed-in sessions were revoked.' });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = requireString(body.password, 'Password', 256);
    const account = await db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
    const credentials = account
      ? await hashPassword(password, account.password_salt)
      : await hashPassword(password, 'safar-kaabe-unknown-account');
    if (!account || !safeEqual(credentials.hash, account.password_hash)) {
      sendJson(response, 401, { error: 'Email or password is incorrect.' });
      return;
    }
    if (account.role === 'AGENCY' &&
        !await db.prepare("SELECT id FROM agencies WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1").get(account.agency_id)) {
      sendJson(response, 403, { error: 'This agency account is pending approval or suspended. Contact SAFAR KAABE support.' });
      return;
    }
    await createSession(account, response);
    await audit(account.id, 'AUTHENTICATED', account.email);
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
    await db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(session.session.id_hash);
    response.setHeader('Set-Cookie', ['sk_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', 'sk_csrf=; Path=/; SameSite=Strict; Max-Age=0']);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname.startsWith('/api/')) {
    const publicTicketVerification = method === 'GET' && /^\/api\/tickets\/[0-9a-f-]+\/verify$/i.test(pathname);
    if (!user && !(method === 'POST' && pathname === '/api/bookings') && !publicTicketVerification) {
      sendJson(response, 401, { error: 'Sign in to continue.' });
      return;
    }

    const ticketVerificationMatch = pathname.match(/^\/api\/tickets\/([0-9a-f-]+)\/verify$/i);
    if (ticketVerificationMatch && method === 'GET') {
      const token = url.searchParams.get('token') || '';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      let verified = await db.prepare(`
        SELECT d.id, d.document_reference AS documentReference, d.document_version AS version,
               d.document_type AS documentType, d.status, d.issued_at AS issuedAt,
               b.state AS bookingState, b.reference AS bookingReference,
               b.travel_date AS travelDate, a.name AS issuingAgency,
               c.route_badge AS routeBadge
        FROM booking_documents d JOIN bookings b ON b.id = d.booking_id JOIN agencies a ON a.id = b.agency_id
        LEFT JOIN catalog_products c ON c.id = b.offer_id
        WHERE d.id = ? AND d.status = 'READY' AND d.verification_token_hash = ?
      `).get(ticketVerificationMatch[1], tokenHash);
      const superseded = !verified && await db.prepare(`
        SELECT d.id, v.document_reference AS documentReference, v.document_version AS version,
               d.document_type AS documentType, v.status, v.issued_at AS issuedAt,
               b.state AS bookingState, b.reference AS bookingReference,
               b.travel_date AS travelDate, a.name AS issuingAgency,
               c.route_badge AS routeBadge
        FROM booking_document_versions v
        JOIN booking_documents d ON d.id = v.document_id
        JOIN bookings b ON b.id = v.booking_id
        JOIN agencies a ON a.id = b.agency_id
        LEFT JOIN catalog_products c ON c.id = b.offer_id
        WHERE v.document_id = ? AND v.verification_token_hash = ?
      `).get(ticketVerificationMatch[1], tokenHash);
      if (superseded) verified = superseded;
      const valid = Boolean(verified);
      const status = !verified ? 'Not verified'
        : verified.bookingState === 'CANCELLED' ? 'Cancelled'
          : verified.status === 'SUPERSEDED' ? 'Superseded'
          : verified.bookingState === 'ACCEPTED' ? 'Valid SAFAR KAABE document' : 'No longer current';
      const detail = valid
        ? `<dl><dt>Document reference</dt><dd>${escapeXml(verified.documentReference || verified.bookingReference)}</dd><dt>Booking reference</dt><dd>${escapeXml(verified.bookingReference)}</dd><dt>Issuing agency</dt><dd>${escapeXml(verified.issuingAgency)}</dd><dt>Route</dt><dd>${escapeXml(verified.routeBadge || 'Not specified')}</dd><dt>Travel date</dt><dd>${escapeXml(verified.travelDate || 'Not specified')}</dd><dt>Issued</dt><dd>${escapeXml(verified.issuedAt || 'Not available')}</dd></dl>`
        : '<p>The document reference or verification token is invalid.</p>';
      response.writeHead(valid ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SAFAR KAABE document verification</title><style>body{font:16px system-ui;background:#101b32;color:#fff;margin:0;padding:2rem}.card{max-width:42rem;margin:8vh auto;background:#f7f9fc;color:#101b32;border-radius:1rem;padding:2rem}h1{color:#185bd5}dt{font-size:.75rem;color:#596579;text-transform:uppercase;margin-top:1rem}dd{margin:.25rem 0;font-weight:700}.notice{padding:.8rem;border-radius:.5rem;background:${valid && verified.bookingState === 'ACCEPTED' && verified.status !== 'SUPERSEDED' ? '#dcfce7' : '#fee2e2'}}.foot{margin-top:1.5rem;font-size:.8rem;color:#596579}</style><main class="card"><h1>SAFAR KAABE</h1><h2>Document verification</h2><p class="notice">${escapeXml(status)}</p>${detail}<p class="foot">This verifies a SAFAR KAABE booking document only. It is not an airline-issued ticket or boarding pass.</p></main></html>`);
      return;
    }

    const ticketBookingMatch = pathname.match(/^\/api\/bookings\/([0-9a-f-]+)\/ticket(?:\.pdf|\.jpg|\/generate|\/email)?$/i);
    if (ticketBookingMatch && ['GET', 'POST'].includes(method)) {
      const bookingId = ticketBookingMatch[1];
      const ticketRecord = await db.prepare(`SELECT d.*, b.customer_id AS customerId, b.agency_id AS agencyId,
        (SELECT status FROM booking_document_deliveries WHERE document_id = d.id ORDER BY updated_at DESC LIMIT 1) AS emailDeliveryStatus,
        (SELECT sent_at FROM booking_document_deliveries WHERE document_id = d.id AND status = 'SENT' ORDER BY sent_at DESC LIMIT 1) AS emailSentAt
        FROM booking_documents d JOIN bookings b ON b.id = d.booking_id
        WHERE d.booking_id = ? AND d.document_type = 'BOOKING_CONFIRMATION'`).get(bookingId);
      const bookingOwner = ticketRecord || await db.prepare('SELECT customer_id AS customerId, agency_id AS agencyId FROM bookings WHERE id = ?').get(bookingId);
      const canAccess = bookingOwner && (user.role === 'SUPER_ADMIN' || (user.role === 'AGENCY' && bookingOwner.agencyId === user.agency_id) || (user.role === 'CLIENT' && bookingOwner.customerId === user.id));
      if (method === 'GET' && pathname.endsWith('/ticket')) {
        if (!canAccess) { sendJson(response, 404, { error: 'Booking confirmation not found.' }); return; }
        sendJson(response, 200, {
          ticket: ticketRecord?.status === 'READY' ? ticketDocumentPublic(ticketRecord, requestOrigin(request)) : null,
          status: ticketRecord?.status || 'NOT_GENERATED',
          error: user.role === 'CLIENT' ? null : ticketRecord?.error_message || null,
          retryAvailable: Boolean(ticketRecord?.error_message) ||
            (ticketRecord?.status === 'READY' && Number(ticketRecord.layout_version || 1) < ticketLayoutVersion),
          email: ticketRecord ? { status: ticketRecord.emailDeliveryStatus || ticketRecord.email_delivery_status || null, sentAt: ticketRecord.emailSentAt || ticketRecord.email_sent_at || null } : null
        });
        return;
      }
      if (method === 'POST' && pathname.endsWith('/ticket/generate')) {
        const bookingOwner = ticketRecord || await db.prepare('SELECT customer_id AS customerId, agency_id AS agencyId FROM bookings WHERE id = ?').get(bookingId);
        const assignedAgency = user?.role === 'AGENCY' && bookingOwner?.agencyId === user.agency_id;
        const travelerRetry = user?.role === 'CLIENT' && bookingOwner?.customerId === user.id &&
          (['FAILED', 'NOT_GENERATED'].includes(ticketRecord?.status || 'NOT_GENERATED') ||
            (ticketRecord?.status === 'READY' &&
              (Boolean(ticketRecord.error_message) || Number(ticketRecord.layout_version || 1) < ticketLayoutVersion)));
        if (!user || !(user.role === 'SUPER_ADMIN' || assignedAgency || travelerRetry)) {
          sendJson(response, 403, { error: 'Only the assigned agency, Super Admin, or booking traveler retrying their own failed document can generate this confirmation.' }); return;
        }
        if (!authorizeMutation(request, response, session)) return;
        const result = await ensureBookingTicketDocument(bookingId, requestOrigin(request));
        sendJson(response, 200, { ticket: result.document, email: result.email });
        return;
      }
      if (method === 'POST' && pathname.endsWith('/ticket/email')) {
        if (!canAccess) { sendJson(response, 404, { error: 'Booking confirmation not found.' }); return; }
        if (!authorizeMutation(request, response, session)) return;
        if (!ticketRecord || ticketRecord.status !== 'READY' || !ticketRecord.pdf_data || !ticketRecord.jpg_data) {
          sendJson(response, 409, { error: 'Generate and store the booking document before retrying email delivery.' });
          return;
        }
        const emailBooking = await db.prepare(`
          SELECT b.id, b.reference, b.traveler_name AS travelerName, b.traveler_email AS travelerEmail,
                 b.travel_date AS travelDate, b.offer_title AS offerTitle, c.route_badge AS routeBadge,
                 c.destination, a.id AS agencyId, a.name AS agencyName, a.logo_mime AS agencyLogoMime,
                 a.logo_data AS agencyLogoData,
                 (SELECT email FROM users WHERE agency_id = a.id AND role = 'AGENCY' ORDER BY created_at LIMIT 1) AS agencyEmail,
                 (SELECT phone FROM users WHERE agency_id = a.id AND role = 'AGENCY' ORDER BY created_at LIMIT 1) AS agencyPhone
          FROM bookings b JOIN agencies a ON a.id = b.agency_id
          LEFT JOIN catalog_products c ON c.id = b.offer_id WHERE b.id = ?
        `).get(bookingId);
        const email = await deliverTicketReadyEmail(emailBooking, ticketRecord, requestOrigin(request));
        sendJson(response, 200, { ticket: ticketDocumentPublic(ticketRecord, requestOrigin(request)), email });
        return;
      }
      if (method === 'GET' && pathname.endsWith('/ticket.pdf')) {
        if (!canAccess || !ticketRecord || ticketRecord.status !== 'READY' || !ticketRecord.pdf_data) { sendJson(response, 404, { error: 'Booking confirmation PDF is not available.' }); return; }
        sendPdf(response, ticketRecord.pdf_data, ticketRecord.file_name, url.searchParams.get('download') === '1');
        return;
      }
      if (method === 'GET' && pathname.endsWith('/ticket.jpg')) {
        if (!canAccess || !ticketRecord || ticketRecord.status !== 'READY' || !ticketRecord.jpg_data) { sendJson(response, 404, { error: 'Booking confirmation JPG is not available.' }); return; }
        sendJpg(response, ticketRecord.jpg_data, ticketRecord.jpg_file_name || `${bookingId}.jpg`, url.searchParams.get('download') === '1');
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/notifications') {
      if (!user) { sendJson(response, 401, { error: 'Sign in to continue.' }); return; }
      const notifications = await db.prepare(`
        SELECT id, recipient_user_id, agency_id, booking_id, conversation_id, type, title, body, href, dedupe_key, created_at, read_at
        FROM notifications WHERE recipient_user_id = ? ORDER BY created_at DESC LIMIT 100
      `).all(user.id);
      const unread = notifications.filter(item => !item.read_at).length;
      sendJson(response, 200, { notifications: notifications.map(notificationPublic), unreadCount: unread });
      return;
    }

    if (method === 'GET' && pathname === '/api/notifications/stream') {
      if (!user) { sendJson(response, 401, { error: 'Sign in to continue.' }); return; }
      if (!catalogRealtimeSupported) {
        sendJson(response, 404, { error: 'Live notifications are not available on this server.' });
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write('event: ready\ndata: {}\n\n');
      if (!notificationEventSubscribers.has(user.id)) notificationEventSubscribers.set(user.id, new Set());
      notificationEventSubscribers.get(user.id).add(response);
      const heartbeat = setInterval(() => { try { response.write(': heartbeat\n\n'); } catch {} }, 25000);
      request.on('close', () => {
        clearInterval(heartbeat);
        const subscribers = notificationEventSubscribers.get(user.id);
        subscribers?.delete(response);
        if (subscribers?.size === 0) notificationEventSubscribers.delete(user.id);
      });
      return;
    }

    if (method === 'PATCH' && /^\/api\/notifications\/[^/]+$/.test(pathname)) {
      if (!authorizeMutation(request, response, session)) return;
      const notificationId = decodeURIComponent(pathname.split('/').pop());
      const body = await readJson(request);
      const action = String(body.action || '').toUpperCase();
      if (!['READ', 'UNREAD'].includes(action)) { sendJson(response, 400, { error: 'Choose READ or UNREAD.' }); return; }
      const notification = await db.prepare('SELECT id FROM notifications WHERE id = ? AND recipient_user_id = ?').get(notificationId, user.id);
      if (!notification) { sendJson(response, 404, { error: 'Notification not found.' }); return; }
      await db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(action === 'READ' ? nowIso() : null, notificationId);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/api/notifications/read-all') {
      if (!authorizeMutation(request, response, session)) return;
      await db.prepare('UPDATE notifications SET read_at = ? WHERE recipient_user_id = ? AND read_at IS NULL').run(nowIso(), user.id);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/push/public-key') {
      sendJson(response, 200, { configured: webPushConfigured, publicKey: webPushConfigured ? process.env.VAPID_PUBLIC_KEY : null });
      return;
    }

    if (method === 'POST' && pathname === '/api/push/subscriptions') {
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const subscription = body.subscription && typeof body.subscription === 'object' ? body.subscription : body;
      if (typeof subscription.endpoint !== 'string' || !/^https:\/\//i.test(subscription.endpoint) || !subscription.keys || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string') {
        sendJson(response, 400, { error: 'A valid browser push subscription is required.' }); return;
      }
      const timestamp = nowIso();
      await db.prepare(`
        INSERT INTO push_subscriptions (id, user_id, endpoint, subscription_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, subscription_json = excluded.subscription_json, updated_at = excluded.updated_at
      `).run(crypto.randomUUID(), user.id, subscription.endpoint, JSON.stringify(subscription), timestamp, timestamp);
      sendJson(response, 201, { ok: true });
      return;
    }

    if (method === 'DELETE' && pathname === '/api/push/subscriptions') {
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      if (typeof body.endpoint !== 'string') { sendJson(response, 400, { error: 'Endpoint is required.' }); return; }
      await db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(user.id, body.endpoint);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/notification-preferences') {
      const timestamp = nowIso();
      await db.prepare(`INSERT INTO notification_preferences (user_id, updated_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING`).run(user.id, timestamp);
      const preferences = await db.prepare('SELECT sound_enabled AS soundEnabled, desktop_push_enabled AS desktopPushEnabled FROM notification_preferences WHERE user_id = ?').get(user.id);
      sendJson(response, 200, { soundEnabled: Boolean(preferences.soundEnabled), desktopPushEnabled: Boolean(preferences.desktopPushEnabled) });
      return;
    }

    if (method === 'PATCH' && pathname === '/api/notification-preferences') {
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      if (typeof body.soundEnabled !== 'boolean' || typeof body.desktopPushEnabled !== 'boolean') { sendJson(response, 400, { error: 'Notification preferences are invalid.' }); return; }
      await db.prepare(`
        INSERT INTO notification_preferences (user_id, sound_enabled, desktop_push_enabled, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET sound_enabled = excluded.sound_enabled, desktop_push_enabled = excluded.desktop_push_enabled, updated_at = excluded.updated_at
      `).run(user.id, body.soundEnabled ? 1 : 0, body.desktopPushEnabled ? 1 : 0, nowIso());
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/portal/summary') {
      if (user.role === 'SUPER_ADMIN') {
        const agencies = await db.prepare(`
          SELECT agencies.id, agencies.name, agencies.tier, agencies.markup_pct AS markupPct,
                 CASE WHEN agencies.is_approved = 0 THEN 'PENDING' ELSE agencies.status END AS status,
                 agencies.logo_mime AS logoMime, agencies.logo_data AS logoData, agencies.created_at AS createdAt,
                 (SELECT COUNT(*) FROM users WHERE users.agency_id = agencies.id AND users.role = 'AGENCY') AS staffCount,
                 (SELECT COUNT(*) FROM agency_clients WHERE agency_clients.agency_id = agencies.id) AS clientCount
          FROM agencies ORDER BY agencies.name
        `).all();
        const customers = await db.prepare("SELECT id, name, email, phone, avatar_mime AS avatarMime, avatar_data AS avatarData, created_at AS createdAt FROM users WHERE role = 'CLIENT' ORDER BY created_at DESC").all();
        const agencyStaff = await db.prepare(`
          SELECT users.id, users.name, users.email, users.role, users.avatar_mime AS avatarMime,
                 users.avatar_data AS avatarData, users.agency_id AS agencyId,
                 agencies.name AS agencyName, users.created_at AS createdAt
          FROM users JOIN agencies ON agencies.id = users.agency_id
          WHERE users.role = 'AGENCY' ORDER BY users.created_at DESC
        `).all();
        const auditLogs = await db.prepare(`
          SELECT audit_logs.action, audit_logs.target, audit_logs.created_at AS time, users.email AS actor
          FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_id
          ORDER BY audit_logs.id DESC LIMIT 100
        `).all();
        sendJson(response, 200, { user: publicUser(user), agencies, customers, agencyStaff, auditLogs });
        return;
      }
      if (user.role === 'AGENCY') {
        const agency = await db.prepare('SELECT id, name, tier, markup_pct AS markupPct, status, logo_mime AS logoMime, logo_data AS logoData FROM agencies WHERE id = ?').get(user.agency_id);
        if (!agency) {
          sendJson(response, 403, { error: 'Your agency account is no longer active.' });
          return;
        }
        const staff = await db.prepare("SELECT id, name, email, role, avatar_mime AS avatarMime, avatar_data AS avatarData, created_at AS createdAt FROM users WHERE agency_id = ? AND role = 'AGENCY' ORDER BY created_at").all(user.agency_id);
        const clients = await db.prepare('SELECT id, name, phone, email, created_at AS createdAt FROM agency_clients WHERE agency_id = ? ORDER BY created_at DESC').all(user.agency_id);
        sendJson(response, 200, { user: publicUser(user), agency, staff, clients });
        return;
      }
      sendJson(response, 200, { user: publicUser(user), customer: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
      return;
    }

    if (pathname === '/api/statuses' && method === 'GET') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      await db.prepare('DELETE FROM chat_statuses WHERE expires_at <= ?').run(nowIso());
      const statuses = await db.prepare(`
        SELECT statuses.id, statuses.user_id AS userId, users.name AS userName, users.role AS userRole,
               CASE WHEN users.role = 'AGENCY' THEN agencies.logo_mime ELSE users.avatar_mime END AS avatarMime,
               CASE WHEN users.role = 'AGENCY' THEN agencies.logo_data ELSE users.avatar_data END AS avatarData,
               statuses.body, statuses.attachment_mime AS attachmentMime,
               statuses.created_at AS createdAt, statuses.expires_at AS expiresAt,
               (SELECT COUNT(*) FROM chat_status_replies replies WHERE replies.status_id = statuses.id) AS replyCount,
               (SELECT COUNT(*) FROM chat_status_reactions reactions WHERE reactions.status_id = statuses.id) AS reactionCount,
               (SELECT reactions.emoji FROM chat_status_reactions reactions WHERE reactions.status_id = statuses.id AND reactions.user_id = ?) AS myReaction
        FROM chat_statuses statuses
        JOIN users ON users.id = statuses.user_id
        LEFT JOIN agencies ON agencies.id = users.agency_id
        WHERE statuses.expires_at > ?
        ORDER BY statuses.created_at DESC
      `).all(user.id, nowIso());
      sendJson(response, 200, { statuses });
      return;
    }

    if (pathname === '/api/statuses' && method === 'POST') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request, maxChatRequestBytes);
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (text.length > 500) {
        sendJson(response, 400, { error: 'Status text cannot be longer than 500 characters.' });
        return;
      }
      const attachment = body.attachmentData
        ? validateChatAttachment(body.attachmentData, body.attachmentMime, 'IMAGE')
        : null;
      if (!text && !attachment) {
        sendJson(response, 400, { error: 'Write a status or add a photo.' });
        return;
      }
      const id = crypto.randomUUID();
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await db.prepare(`INSERT INTO chat_statuses (id, user_id, body, attachment_mime, attachment_data, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, user.id, text, attachment?.mime || null, attachment?.data || null, createdAt, expiresAt);
      await audit(user.id, 'CHAT_STATUS_CREATED', id);
      sendJson(response, 201, { status: { id, userId: user.id, body: text, attachmentMime: attachment?.mime || null, createdAt, expiresAt } });
      return;
    }

    const statusRepliesMatch = pathname.match(/^\/api\/statuses\/([0-9a-f-]+)\/replies$/i);
    if (statusRepliesMatch && method === 'GET') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      const status = await db.prepare('SELECT id, user_id AS userId FROM chat_statuses WHERE id = ? AND expires_at > ?').get(statusRepliesMatch[1], nowIso());
      if (!status) { sendJson(response, 404, { error: 'Status not found or expired.' }); return; }
      if (status.userId !== user.id) { sendJson(response, 403, { error: 'Only the status owner can view its replies.' }); return; }
      const replies = await db.prepare(`SELECT replies.id, replies.body, replies.created_at AS createdAt,
          users.id AS userId, users.name AS userName, users.role AS userRole
        FROM chat_status_replies replies JOIN users ON users.id = replies.user_id
        WHERE replies.status_id = ? ORDER BY replies.created_at ASC`).all(status.id);
      sendJson(response, 200, { replies });
      return;
    }
    if (statusRepliesMatch && method === 'POST') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const status = await db.prepare('SELECT id, user_id AS userId FROM chat_statuses WHERE id = ? AND expires_at > ?').get(statusRepliesMatch[1], nowIso());
      if (!status) { sendJson(response, 404, { error: 'Status not found or expired.' }); return; }
      const payload = await readJson(request);
      const text = typeof payload.body === 'string' ? payload.body.trim() : '';
      if (!text || text.length > 500) { sendJson(response, 400, { error: 'A reply must be between 1 and 500 characters.' }); return; }
      if (status.userId === user.id) { sendJson(response, 400, { error: 'You cannot reply to your own status.' }); return; }
      const reply = { id: crypto.randomUUID(), statusId: status.id, userId: user.id, userName: user.name, body: text, createdAt: nowIso() };
      await db.prepare('INSERT INTO chat_status_replies (id, status_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(reply.id, reply.statusId, reply.userId, reply.body, reply.createdAt);
      await audit(user.id, 'CHAT_STATUS_REPLIED', status.id);
      sendJson(response, 201, { reply });
      return;
    }
    const statusReactionMatch = pathname.match(/^\/api\/statuses\/([0-9a-f-]+)\/reactions$/i);
    if (statusReactionMatch && method === 'POST') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const status = await db.prepare('SELECT id FROM chat_statuses WHERE id = ? AND expires_at > ?').get(statusReactionMatch[1], nowIso());
      if (!status) { sendJson(response, 404, { error: 'Status not found or expired.' }); return; }
      const payload = await readJson(request);
      const emoji = typeof payload.emoji === 'string' ? payload.emoji : '';
      if (!['😍', '😂', '😮', '❤️'].includes(emoji)) { sendJson(response, 400, { error: 'Choose one of the available status reactions.' }); return; }
      const existing = await db.prepare('SELECT emoji FROM chat_status_reactions WHERE status_id = ? AND user_id = ?').get(status.id, user.id);
      if (existing?.emoji === emoji) {
        await db.prepare('DELETE FROM chat_status_reactions WHERE status_id = ? AND user_id = ?').run(status.id, user.id);
      } else {
        await db.prepare(`INSERT INTO chat_status_reactions (status_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(status_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`).run(status.id, user.id, emoji, nowIso());
      }
      const reaction = existing?.emoji === emoji ? null : emoji;
      await audit(user.id, 'CHAT_STATUS_REACTED', status.id);
      sendJson(response, 200, { reaction });
      return;
    }

    const chatStatusAttachmentMatch = pathname.match(/^\/api\/statuses\/([0-9a-f-]+)\/attachment$/i);
    if (chatStatusAttachmentMatch && method === 'GET') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      const status = await db.prepare(`SELECT attachment_mime, attachment_data FROM chat_statuses
        WHERE id = ? AND expires_at > ? AND attachment_data IS NOT NULL`).get(chatStatusAttachmentMatch[1], nowIso());
      if (!status) {
        sendJson(response, 404, { error: 'Status photo not found or expired.' });
        return;
      }
      sendChatAttachment(response, { attachment_mime: status.attachment_mime, attachment_data: status.attachment_data });
      return;
    }

    const chatStatusMatch = pathname.match(/^\/api\/statuses\/([0-9a-f-]+)$/i);
    if (chatStatusMatch && ['PATCH', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const status = await db.prepare('SELECT id, user_id AS userId, body, attachment_data AS attachmentData FROM chat_statuses WHERE id = ? AND expires_at > ?')
        .get(chatStatusMatch[1], nowIso());
      if (!status) {
        sendJson(response, 404, { error: 'Status not found or expired.' });
        return;
      }
      if (status.userId !== user.id) {
        sendJson(response, 403, { error: 'You can only change or delete your own status.' });
        return;
      }
      if (method === 'PATCH') {
        const body = await readJson(request);
        const text = typeof body.body === 'string' ? body.body.trim() : '';
        if (text.length > 500 || (!text && !status.attachmentData)) {
          sendJson(response, 400, { error: text.length > 500 ? 'Status text cannot be longer than 500 characters.' : 'A photo status must keep a caption or photo.' });
          return;
        }
        await db.prepare('UPDATE chat_statuses SET body = ? WHERE id = ? AND user_id = ?').run(text, status.id, user.id);
        await audit(user.id, 'CHAT_STATUS_UPDATED', status.id);
        sendJson(response, 200, { ok: true, body: text });
        return;
      }
      await db.prepare('DELETE FROM chat_statuses WHERE id = ? AND user_id = ?').run(status.id, user.id);
      await audit(user.id, 'CHAT_STATUS_DELETED', status.id);
      sendJson(response, 200, { ok: true });
      return;
    }

    const communityMessagesMatch = pathname.match(/^\/api\/communities\/([0-9a-f-]+)\/messages$/i);
    const communityMemberMatch = pathname.match(/^\/api\/communities\/([0-9a-f-]+)\/(join|leave)$/i);
    const communityMessageMatch = pathname.match(/^\/api\/communities\/([0-9a-f-]+)\/messages\/([0-9a-f-]+)$/i);
    const communityResourceMatch = pathname.match(/^\/api\/communities\/([0-9a-f-]+)$/i);
    if (pathname === '/api/communities' && method === 'GET') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      const communities = await db.prepare(`
        SELECT communities.id, communities.name, communities.description, communities.created_by AS createdBy,
          communities.created_at AS createdAt, owner.name AS ownerName,
          (SELECT COUNT(*) FROM chat_community_members members WHERE members.community_id = communities.id) AS memberCount,
          EXISTS (SELECT 1 FROM chat_community_members mine WHERE mine.community_id = communities.id AND mine.user_id = ?) AS isMember,
          (SELECT body FROM chat_community_messages messages WHERE messages.community_id = communities.id ORDER BY messages.created_at DESC, messages.id DESC LIMIT 1) AS lastMessage,
          (SELECT created_at FROM chat_community_messages messages WHERE messages.community_id = communities.id ORDER BY messages.created_at DESC, messages.id DESC LIMIT 1) AS lastMessageAt
        FROM chat_communities communities JOIN users owner ON owner.id = communities.created_by
        ORDER BY COALESCE((SELECT messages.created_at FROM chat_community_messages messages WHERE messages.community_id = communities.id ORDER BY messages.created_at DESC, messages.id DESC LIMIT 1), communities.created_at) DESC, communities.name
      `).all(user.id);
      sendJson(response, 200, { communities });
      return;
    }
    if (pathname === '/api/communities' && method === 'POST') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (name.length < 2 || name.length > 80 || description.length > 500) {
        sendJson(response, 400, { error: 'Use a community name from 2 to 80 characters and a description up to 500 characters.' });
        return;
      }
      const id = crypto.randomUUID();
      const createdAt = nowIso();
      await db.prepare('INSERT INTO chat_communities (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, description, user.id, createdAt);
      await db.prepare('INSERT INTO chat_community_members (community_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, user.id, createdAt);
      await audit(user.id, 'CHAT_COMMUNITY_CREATED', id);
      sendJson(response, 201, { community: { id, name, description, createdBy: user.id, createdAt, memberCount: 1, isMember: true } });
      return;
    }
    if (communityMemberMatch && method === 'POST') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const community = await db.prepare('SELECT id FROM chat_communities WHERE id = ?').get(communityMemberMatch[1]);
      if (!community) { sendJson(response, 404, { error: 'Community not found.' }); return; }
      if (communityMemberMatch[2] === 'join') {
        await db.prepare('INSERT INTO chat_community_members (community_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT(community_id, user_id) DO NOTHING').run(community.id, user.id, nowIso());
        await audit(user.id, 'CHAT_COMMUNITY_JOINED', community.id);
      } else {
        await db.prepare('DELETE FROM chat_community_members WHERE community_id = ? AND user_id = ?').run(community.id, user.id);
        await audit(user.id, 'CHAT_COMMUNITY_LEFT', community.id);
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (communityMessagesMatch && ['GET', 'POST'].includes(method)) {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      const community = await db.prepare('SELECT id FROM chat_communities WHERE id = ?').get(communityMessagesMatch[1]);
      const membership = community && await db.prepare('SELECT user_id FROM chat_community_members WHERE community_id = ? AND user_id = ?').get(community.id, user.id);
      if (!community) { sendJson(response, 404, { error: 'Community not found.' }); return; }
      if (!membership) { sendJson(response, 403, { error: 'Join this community to view and send messages.' }); return; }
      if (method === 'GET') {
        const messages = await db.prepare(`SELECT messages.id, messages.sender_id AS senderId, users.name AS senderName,
          users.role AS senderRole, users.avatar_mime AS senderImageMime, users.avatar_data AS senderImageData,
          messages.body, messages.created_at AS createdAt, messages.edited_at AS editedAt
          FROM chat_community_messages messages JOIN users ON users.id = messages.sender_id
          WHERE messages.community_id = ? ORDER BY messages.created_at, messages.id`).all(community.id);
        sendJson(response, 200, { messages });
        return;
      }
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message || message.length > 5000) { sendJson(response, 400, { error: 'Community messages must be between 1 and 5,000 characters.' }); return; }
      const id = crypto.randomUUID();
      const createdAt = nowIso();
      await db.prepare('INSERT INTO chat_community_messages (id, community_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, community.id, user.id, message, createdAt);
      await audit(user.id, 'CHAT_COMMUNITY_MESSAGE_SENT', id);
      sendJson(response, 201, { message: { id, senderId: user.id, senderName: user.name, senderRole: user.role, body: message, createdAt } });
      return;
    }
    if (communityMessageMatch && ['PATCH', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const existing = await db.prepare('SELECT id, sender_id AS senderId FROM chat_community_messages WHERE id = ? AND community_id = ?').get(communityMessageMatch[2], communityMessageMatch[1]);
      if (!existing) { sendJson(response, 404, { error: 'Community message not found.' }); return; }
      if (existing.senderId !== user.id && user.role !== 'SUPER_ADMIN') { sendJson(response, 403, { error: 'You can only change or remove your own community messages.' }); return; }
      if (method === 'PATCH') {
        const body = await readJson(request);
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message || message.length > 5000) { sendJson(response, 400, { error: 'Community messages must be between 1 and 5,000 characters.' }); return; }
        await db.prepare('UPDATE chat_community_messages SET body = ?, edited_at = ? WHERE id = ?').run(message, nowIso(), existing.id);
        await audit(user.id, 'CHAT_COMMUNITY_MESSAGE_EDITED', existing.id);
        sendJson(response, 200, { ok: true, body: message });
        return;
      }
      await db.prepare('DELETE FROM chat_community_messages WHERE id = ?').run(existing.id);
      await audit(user.id, 'CHAT_COMMUNITY_MESSAGE_DELETED', existing.id);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (communityResourceMatch && ['PATCH', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const community = await db.prepare('SELECT id, created_by AS createdBy FROM chat_communities WHERE id = ?').get(communityResourceMatch[1]);
      if (!community) { sendJson(response, 404, { error: 'Community not found.' }); return; }
      if (community.createdBy !== user.id && user.role !== 'SUPER_ADMIN') { sendJson(response, 403, { error: 'Only the community owner or a Super Admin can manage this community.' }); return; }
      if (method === 'PATCH') {
        const body = await readJson(request);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const description = typeof body.description === 'string' ? body.description.trim() : '';
        if (name.length < 2 || name.length > 80 || description.length > 500) { sendJson(response, 400, { error: 'Use a community name from 2 to 80 characters and a description up to 500 characters.' }); return; }
        await db.prepare('UPDATE chat_communities SET name = ?, description = ? WHERE id = ?').run(name, description, community.id);
        await audit(user.id, 'CHAT_COMMUNITY_UPDATED', community.id);
        sendJson(response, 200, { ok: true });
        return;
      }
      await db.prepare('DELETE FROM chat_communities WHERE id = ?').run(community.id);
      await audit(user.id, 'CHAT_COMMUNITY_DELETED', community.id);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/api/presence') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const presenceStatus = body.presenceStatus === undefined
        ? null
        : ['AVAILABLE', 'BUSY', 'AWAY'].includes(body.presenceStatus)
          ? body.presenceStatus
          : (() => { throw Object.assign(new Error('Choose available, busy, or away status.'), { statusCode: 400 }); })();
      const hasTyping = Object.hasOwn(body, 'typingConversationId');
      let typingConversationId = null;
      let typingUntil = null;
      if (hasTyping && body.typingConversationId !== null) {
        typingConversationId = requireString(body.typingConversationId, 'Conversation', 80);
        if (!await getAccessibleConversation(typingConversationId, user)) {
          sendJson(response, 404, { error: 'Conversation not found.' });
          return;
        }
        typingUntil = new Date(Date.now() + 8_000).toISOString();
      }
      const lastSeenAt = nowIso();
      if (hasTyping) {
        await db.prepare(`UPDATE users SET last_seen_at = ?, presence_status = COALESCE(?, presence_status),
          typing_conversation_id = ?, typing_until = ? WHERE id = ?`)
          .run(lastSeenAt, presenceStatus, typingConversationId, typingUntil, user.id);
      } else {
        await db.prepare('UPDATE users SET last_seen_at = ?, presence_status = COALESCE(?, presence_status) WHERE id = ?')
          .run(lastSeenAt, presenceStatus, user.id);
      }
      sendJson(response, 200, { presence: { status: presenceStatus || user.presence_status || 'AVAILABLE', lastSeenAt } });
      return;
    }

    if (method === 'GET' && pathname === '/api/conversations') {
      const peerPredicate = conversationPeerPredicate(user.role);
      const conversations = await db.prepare(`
        SELECT c.id, c.agency_id AS agencyId, c.customer_id AS customerId, c.subject,
               c.created_at AS createdAt, c.last_message_at AS lastMessageAt,
               a.name AS agencyName, a.logo_mime AS agencyLogoMime, a.logo_data AS agencyLogoData,
               (SELECT contact.email FROM users contact WHERE contact.agency_id = c.agency_id AND contact.role = 'AGENCY' ORDER BY contact.created_at LIMIT 1) AS agencyContactEmail,
               (SELECT contact.phone FROM users contact WHERE contact.agency_id = c.agency_id AND contact.role = 'AGENCY' ORDER BY contact.created_at LIMIT 1) AS agencyContactPhone,
               u.name AS customerName, u.email AS customerEmail, u.phone AS customerPhone,
               u.avatar_mime AS customerAvatarMime, u.avatar_data AS customerAvatarData,
               (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) AS lastMessage,
               (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND read_at IS NULL) AS unreadCount,
               COALESCE((SELECT peer.presence_status FROM users peer WHERE ${peerPredicate} AND peer.last_seen_at IS NOT NULL ORDER BY peer.last_seen_at DESC LIMIT 1), 'OFFLINE') AS peerPresenceStatus,
               (SELECT MAX(peer.last_seen_at) FROM users peer WHERE ${peerPredicate}) AS peerLastSeenAt,
               EXISTS (SELECT 1 FROM users peer WHERE ${peerPredicate} AND peer.typing_conversation_id = c.id AND peer.typing_until > ?) AS peerTyping
        FROM conversations c LEFT JOIN agencies a ON a.id = c.agency_id
        LEFT JOIN users u ON u.id = c.customer_id
        WHERE (? = 'SUPER_ADMIN' OR (? = 'AGENCY' AND c.agency_id = ?) OR (? = 'CLIENT' AND c.customer_id = ?))
          AND NOT EXISTS (SELECT 1 FROM conversation_hidden hidden WHERE hidden.conversation_id = c.id AND hidden.user_id = ?)
        ORDER BY c.last_message_at DESC
      `).all(user.id, nowIso(), user.role, user.role, user.agency_id, user.role, user.id, user.id);
      sendJson(response, 200, { conversations });
      return;
    }

    if (method === 'GET' && pathname === '/api/agencies/active') {
      const agencies = await db.prepare(`SELECT agencies.id, agencies.name,
        (SELECT users.email FROM users WHERE users.agency_id = agencies.id AND users.role = 'AGENCY'
          ORDER BY users.created_at, users.email LIMIT 1) AS contactEmail
        FROM agencies WHERE agencies.status = 'ACTIVE' AND agencies.is_approved = 1 ORDER BY agencies.name, agencies.id`).all();
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
      const agency = await db.prepare('SELECT id, name, status, is_approved FROM agencies WHERE id = ?').get(agencyStatusMatch[1]);
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
      await runInTransaction(async () => {
        await db.prepare('UPDATE agencies SET status = ?, is_approved = ? WHERE id = ?').run(status, isApproved, agency.id);
        if (status === 'SUSPENDED') {
          await db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE agency_id = ? AND role = ?)').run(agency.id, 'AGENCY');
        }
        await audit(user.id, `AGENCY_${body.action}`, `${agency.name} (${agency.id})`);
      });
      publishCatalogChange('agency-status');
      sendJson(response, 200, { agency: { id: agency.id, name: agency.name, status } });
      return;
    }

    const agencyMatch = pathname.match(/^\/api\/agencies\/([0-9a-f-]+)$/i);
    if (agencyMatch && method === 'PATCH') {
      if (!requireRole(response, user, ['SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const name = requireString(body.name, 'Agency name');
      const tier = requireString(body.tier, 'Plan');
      const markup = Number(body.markupPct);
      if (!['BASIC', 'PROFESSIONAL', 'ENTERPRISE'].includes(tier) || !Number.isFinite(markup) || markup < 0 || markup > 100) {
        sendJson(response, 400, { error: 'Choose a valid plan and markup from 0 to 100%.' });
        return;
      }
      const agency = await db.prepare('SELECT id, name FROM agencies WHERE id = ?').get(agencyMatch[1]);
      if (!agency) {
        sendJson(response, 404, { error: 'Agency not found.' });
        return;
      }
      await runInTransaction(async () => {
        await db.prepare('UPDATE agencies SET name = ?, tier = ?, markup_pct = ? WHERE id = ?')
          .run(name, tier, markup, agency.id);
        await audit(user.id, 'AGENCY_UPDATED', `${agency.name} -> ${name} (${agency.id})`);
      });
      publishCatalogChange('agency-details');
      sendJson(response, 200, { agency: { id: agency.id, name, tier, markupPct: markup } });
      return;
    }

    if (agencyMatch && method === 'DELETE') {
      if (!requireRole(response, user, ['SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const agency = await db.prepare('SELECT id, name FROM agencies WHERE id = ?').get(agencyMatch[1]);
      if (!agency) {
        sendJson(response, 404, { error: 'Agency not found.' });
        return;
      }
      const bookingCount = await db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE agency_id = ?').get(agency.id);
      const inventoryCount = await db.prepare('SELECT COUNT(*) AS count FROM catalog_products WHERE agency_id = ?').get(agency.id);
      if (bookingCount.count || inventoryCount.count) {
        sendJson(response, 409, { error: 'This agency has bookings or travel listings. Remove its listings and retain booking history before deleting it.' });
        return;
      }
      await runInTransaction(async () => {
        await audit(user.id, 'AGENCY_DELETED', `${agency.name} (${agency.id})`);
        await db.prepare('DELETE FROM conversations WHERE agency_id = ?').run(agency.id);
        await db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE agency_id = ?)').run(agency.id);
        await db.prepare('DELETE FROM users WHERE agency_id = ?').run(agency.id);
        await db.prepare('DELETE FROM agency_clients WHERE agency_id = ?').run(agency.id);
        await db.prepare('DELETE FROM agencies WHERE id = ?').run(agency.id);
      });
      publishCatalogChange('agency-removed');
      sendJson(response, 200, { deleted: true, agencyId: agency.id });
      return;
    }

    if (method === 'POST' && pathname === '/api/conversations') {
      if (!requireRole(response, user, ['CLIENT', 'AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const subject = requireString(body.subject, 'Subject', 160);
      const message = requireString(body.message, 'Message', 5000);
      const support = body.support === true;
      let agencyId = null;
      let customerId = null;
      if (user.role === 'SUPER_ADMIN') {
        const recipientType = requireString(body.recipientType, 'Recipient type', 16);
        const recipientId = requireString(body.recipientId, 'Recipient', 80);
        if (recipientType === 'AGENCY') {
          if (!await db.prepare("SELECT id FROM agencies WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1").get(recipientId)) {
            sendJson(response, 404, { error: 'The selected travel agency is not available.' });
            return;
          }
          agencyId = recipientId;
        } else if (recipientType === 'CLIENT') {
          if (!await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'CLIENT'").get(recipientId)) {
            sendJson(response, 404, { error: 'The selected traveler is not available.' });
            return;
          }
          customerId = recipientId;
        } else {
          sendJson(response, 400, { error: 'Choose a traveler or agency as the conversation recipient.' });
          return;
        }
      } else if (user.role === 'CLIENT') {
        customerId = user.id;
        if (!support) {
          agencyId = requireString(body.agencyId, 'Agency', 80);
          if (!await db.prepare("SELECT id FROM agencies WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1").get(agencyId)) {
            sendJson(response, 404, { error: 'The selected travel agency is not available.' });
            return;
          }
        }
      } else {
        agencyId = user.agency_id;
        if (!await db.prepare("SELECT id FROM agencies WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1").get(agencyId)) {
          sendJson(response, 403, { error: 'Your agency cannot open a support conversation while inactive.' });
          return;
        }
        if (body.recipientId) {
          customerId = requireString(body.recipientId, 'Traveler', 80);
          if (!await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'CLIENT'").get(customerId)) {
            sendJson(response, 404, { error: 'The selected traveler is not available.' });
            return;
          }
        }
      }
      const conversationId = crypto.randomUUID();
      const firstMessageId = crypto.randomUUID();
      const createdAt = nowIso();
      await runInTransaction(async () => {
        await db.prepare(`
          INSERT INTO conversations (id, agency_id, customer_id, subject, created_by, created_at, last_message_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(conversationId, agencyId, customerId, subject, user.id, createdAt, createdAt);
        await db.prepare(`
          INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(firstMessageId, conversationId, user.id, message, createdAt);
      });
      await createConversationMessageNotifications(
        { id: conversationId, agency_id: agencyId, customer_id: customerId },
        user,
        { id: firstMessageId, body: message, createdAt }
      );
      await audit(user.id, 'CONVERSATION_CREATED', `${subject} (${conversationId})`);
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

    if (pathname === '/api/calls/ice-config' && method === 'GET') {
      const iceServers = [{
        urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
      }];
      const turnUrls = String(process.env.TURN_URLS || '')
        .split(',')
        .map(value => value.trim())
        .filter(value => /^turns?:/i.test(value));
      const turnSecret = process.env.TURN_SHARED_SECRET;
      if (turnUrls.length && turnSecret) {
        const username = `${Math.floor(Date.now() / 1000) + 3600}:${user.id}`;
        const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
        iceServers.push({ urls: turnUrls, username, credential });
      }
      sendJson(response, 200, { iceServers, turnAvailable: iceServers.length > 1 });
      return;
    }

    const conversationCallMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/calls$/i);
    if (conversationCallMatch && method === 'POST') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const conversation = await getAccessibleConversation(conversationCallMatch[1], user);
      if (!conversation) { sendJson(response, 404, { error: 'Conversation not found.' }); return; }
      const body = await readJson(request);
      const callType = typeof body.callType === 'string' ? body.callType.toUpperCase() : '';
      if (!['AUDIO', 'VIDEO'].includes(callType)) { sendJson(response, 400, { error: 'Choose an audio or video call.' }); return; }
      let callee;
      if (user.role === 'CLIENT' || (user.role === 'SUPER_ADMIN' && !conversation.customer_id)) {
        callee = await db.prepare(`SELECT id, name FROM users WHERE agency_id = ? AND role = 'AGENCY'
          ORDER BY CASE WHEN presence_status = 'AVAILABLE' THEN 0 WHEN presence_status = 'AWAY' THEN 1 ELSE 2 END,
          last_seen_at DESC, created_at LIMIT 1`).get(conversation.agency_id);
        if (!callee && !conversation.agency_id) {
          callee = await db.prepare("SELECT id, name FROM users WHERE role = 'SUPER_ADMIN' ORDER BY created_at LIMIT 1").get();
        }
      } else if (conversation.customer_id) {
        callee = await db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'CLIENT'").get(conversation.customer_id);
      } else if (conversation.agency_id) {
        callee = await db.prepare(`SELECT id, name FROM users WHERE agency_id = ? AND role = 'AGENCY'
          ORDER BY CASE WHEN presence_status = 'AVAILABLE' THEN 0 WHEN presence_status = 'AWAY' THEN 1 ELSE 2 END,
          last_seen_at DESC, created_at LIMIT 1`).get(conversation.agency_id);
      }
      if (!callee || callee.id === user.id) { sendJson(response, 409, { error: 'No other call participant is available in this conversation.' }); return; }
      const busy = await db.prepare(`SELECT id FROM chat_calls WHERE status IN ('RINGING', 'ACCEPTED')
        AND (caller_id IN (?, ?) OR callee_id IN (?, ?)) LIMIT 1`).get(user.id, callee.id, user.id, callee.id);
      if (busy) { sendJson(response, 409, { error: 'This participant is already in another call. Try again shortly.' }); return; }
      const callId = crypto.randomUUID();
      const createdAt = nowIso();
      await db.prepare(`INSERT INTO chat_calls (id, conversation_id, caller_id, callee_id, call_type, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'RINGING', ?)`).run(callId, conversation.id, user.id, callee.id, callType, createdAt);
      sendJson(response, 201, { call: { id: callId, conversationId: conversation.id, callerId: user.id,
        calleeId: callee.id, peerName: callee.name, callType, status: 'RINGING', createdAt } });
      return;
    }

    const callSignalsMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/signals$/i);
    const chatCallMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)$/i);
    if (method === 'GET' && pathname === '/api/calls/active') {
      const cutoff = new Date(Date.now() - 60_000).toISOString();
      await db.prepare("UPDATE chat_calls SET status = 'MISSED', ended_at = ? WHERE status = 'RINGING' AND created_at < ?")
        .run(nowIso(), cutoff);
      const calls = await db.prepare(`SELECT calls.id, calls.conversation_id AS conversationId,
        calls.caller_id AS callerId, caller.name AS callerName, caller.avatar_mime AS callerAvatarMime,
        caller.avatar_data AS callerAvatarData, calls.callee_id AS calleeId, callee.name AS calleeName,
        callee.avatar_mime AS calleeAvatarMime, callee.avatar_data AS calleeAvatarData,
        calls.call_type AS callType, calls.status, calls.created_at AS createdAt
        FROM chat_calls calls JOIN users caller ON caller.id = calls.caller_id
        JOIN users callee ON callee.id = calls.callee_id
        WHERE (calls.caller_id = ? OR calls.callee_id = ?) AND calls.status IN ('RINGING', 'ACCEPTED')
        ORDER BY calls.created_at DESC LIMIT 10`).all(user.id, user.id);
      sendJson(response, 200, { calls: calls.map(call => ({ ...call,
        peerName: call.callerId === user.id ? call.calleeName : call.callerName,
        peerAvatarMime: call.callerId === user.id ? call.calleeAvatarMime : call.callerAvatarMime,
        peerAvatarData: call.callerId === user.id ? call.calleeAvatarData : call.callerAvatarData
      })) });
      return;
    }
    if (callSignalsMatch && ['GET', 'POST'].includes(method)) {
      if (method === 'POST' && !authorizeMutation(request, response, session)) return;
      const call = await db.prepare('SELECT * FROM chat_calls WHERE id = ?').get(callSignalsMatch[1]);
      if (!call || (call.caller_id !== user.id && call.callee_id !== user.id)) {
        sendJson(response, 404, { error: 'Call not found.' }); return;
      }
      if (method === 'GET') {
        const rawAfter = Number(url.searchParams.get('after') || 0);
        const after = Number.isSafeInteger(rawAfter) && rawAfter >= 0 ? rawAfter : 0;
        const signals = await db.prepare(`SELECT id, sender_id AS senderId, signal_type AS signalType,
          payload_json AS payloadJson, created_at AS createdAt FROM chat_call_signals
          WHERE call_id = ? AND sender_id != ? AND id > ? ORDER BY id LIMIT 100`).all(call.id, user.id, after);
        sendJson(response, 200, { call: { id: call.id, callType: call.call_type, status: call.status },
          signals: signals.map(signal => ({ id: signal.id, senderId: signal.senderId,
            signalType: signal.signalType, payload: JSON.parse(signal.payloadJson), createdAt: signal.createdAt })) });
        return;
      }
      if (!['RINGING', 'ACCEPTED'].includes(call.status)) { sendJson(response, 409, { error: 'This call has already ended.' }); return; }
      const body = await readJson(request, 32_768);
      const signalType = typeof body.signalType === 'string' ? body.signalType.toUpperCase() : '';
      const allowedSignal = signalType === 'ICE' || (signalType === 'OFFER' && user.id === call.caller_id) ||
        (signalType === 'ANSWER' && user.id === call.callee_id);
      const payloadSize = Buffer.byteLength(JSON.stringify(body.payload || {}));
      if (!allowedSignal || !body.payload || typeof body.payload !== 'object' || payloadSize > 24_000) {
        sendJson(response, 400, { error: 'The call could not exchange its connection details.' }); return;
      }
      await db.prepare(`INSERT INTO chat_call_signals (call_id, sender_id, signal_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(call.id, user.id, signalType, JSON.stringify(body.payload), nowIso());
      sendJson(response, 201, { ok: true });
      return;
    }
    if (chatCallMatch && method === 'PATCH') {
      if (!authorizeMutation(request, response, session)) return;
      const call = await db.prepare('SELECT * FROM chat_calls WHERE id = ?').get(chatCallMatch[1]);
      if (!call || (call.caller_id !== user.id && call.callee_id !== user.id)) {
        sendJson(response, 404, { error: 'Call not found.' }); return;
      }
      const body = await readJson(request);
      const action = typeof body.action === 'string' ? body.action.toUpperCase() : '';
      if (action === 'ACCEPT' && call.callee_id === user.id && call.status === 'RINGING') {
        await db.prepare("UPDATE chat_calls SET status = 'ACCEPTED', accepted_at = ? WHERE id = ? AND status = 'RINGING'").run(nowIso(), call.id);
      } else if (action === 'REJECT' && call.callee_id === user.id && call.status === 'RINGING') {
        await db.prepare("UPDATE chat_calls SET status = 'REJECTED', ended_at = ? WHERE id = ? AND status = 'RINGING'").run(nowIso(), call.id);
      } else if (action === 'END' && ['RINGING', 'ACCEPTED'].includes(call.status)) {
        await db.prepare("UPDATE chat_calls SET status = 'ENDED', ended_at = ? WHERE id = ? AND status IN ('RINGING', 'ACCEPTED')").run(nowIso(), call.id);
      } else if (action !== 'ACCEPT' && action !== 'REJECT' && action !== 'END') {
        sendJson(response, 400, { error: 'Choose answer, decline, or end call.' }); return;
      } else if (!['RINGING', 'ACCEPTED'].includes(call.status)) {
        sendJson(response, 409, { error: 'This call has already ended.' }); return;
      } else {
        sendJson(response, 403, { error: 'Only the person receiving the call can answer or decline it.' }); return;
      }
      const updated = await db.prepare('SELECT status FROM chat_calls WHERE id = ?').get(call.id);
      sendJson(response, 200, { status: updated.status });
      return;
    }

    const conversationResourceMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]+)$/i);
    const conversationMessageResourceMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages\/([0-9a-f-]+)$/i);
    const conversationMessagesMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages$/i);
    const conversationAttachmentMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages\/([0-9a-f-]+)\/attachment$/i);
    if (conversationResourceMatch && method === 'DELETE') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const conversation = await getAccessibleConversation(conversationResourceMatch[1], user);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      await db.prepare(`INSERT INTO conversation_hidden (conversation_id, user_id, hidden_at) VALUES (?, ?, ?)
        ON CONFLICT(conversation_id, user_id) DO UPDATE SET hidden_at = excluded.hidden_at`)
        .run(conversation.id, user.id, nowIso());
      await audit(user.id, 'CONVERSATION_HIDDEN', `${conversation.subject} (${conversation.id})`);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (conversationMessageResourceMatch && ['PATCH', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const conversation = await getAccessibleConversation(conversationMessageResourceMatch[1], user);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      const messageId = conversationMessageResourceMatch[2];
      const existing = await db.prepare(`SELECT id, sender_id AS senderId, message_type AS messageType
        FROM messages WHERE id = ? AND conversation_id = ?`).get(messageId, conversation.id);
      if (!existing) {
        sendJson(response, 404, { error: 'Message not found.' });
        return;
      }
      if (existing.senderId !== user.id) {
        sendJson(response, 403, { error: 'You can only change messages you sent.' });
        return;
      }
      if (await db.prepare('SELECT payment_reference FROM payment_receipt_messages WHERE message_id = ?').get(existing.id)) {
        sendJson(response, 403, { error: 'Provider-confirmed payment receipts cannot be changed.' });
        return;
      }
      if (method === 'PATCH') {
        if (existing.messageType !== 'TEXT') {
          sendJson(response, 400, { error: 'Only text messages can be edited.' });
          return;
        }
        const body = await readJson(request);
        const message = requireString(body.message, 'Message', 5000).trim();
        if (!message) {
          sendJson(response, 400, { error: 'Messages cannot be empty.' });
          return;
        }
        const editedAt = nowIso();
        await db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ? AND conversation_id = ?')
          .run(message, editedAt, existing.id, conversation.id);
        await audit(user.id, 'CONVERSATION_MESSAGE_EDITED', `${existing.id} (${conversation.id})`);
        sendJson(response, 200, { ok: true, editedAt });
        return;
      }
      await runInTransaction(async () => {
        await db.prepare('DELETE FROM messages WHERE id = ? AND conversation_id = ?').run(existing.id, conversation.id);
        const latest = await db.prepare('SELECT created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(conversation.id);
        await db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(latest?.createdAt || conversation.created_at, conversation.id);
      });
      await audit(user.id, 'CONVERSATION_MESSAGE_DELETED', `${existing.id} (${conversation.id})`);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (conversationAttachmentMatch && method === 'GET') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      const conversation = await getAccessibleConversation(conversationAttachmentMatch[1], user);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      const attachment = await db.prepare(`SELECT attachment_mime, attachment_data FROM messages
        WHERE id = ? AND conversation_id = ? AND attachment_data IS NOT NULL`).get(conversationAttachmentMatch[2], conversation.id);
      if (!attachment) {
        sendJson(response, 404, { error: 'Attachment not found.' });
        return;
      }
      sendChatAttachment(response, attachment);
      return;
    }

    if (conversationMessagesMatch && method === 'GET') {
      const conversation = await getAccessibleConversation(conversationMessagesMatch[1], user);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      const messages = await db.prepare(`
        SELECT messages.id, messages.sender_id AS senderId, users.name AS senderName,
               users.role AS senderRole,
               CASE WHEN users.role = 'AGENCY' THEN sender_agency.logo_mime ELSE users.avatar_mime END AS senderImageMime,
               CASE WHEN users.role = 'AGENCY' THEN sender_agency.logo_data ELSE users.avatar_data END AS senderImageData,
               messages.body, messages.message_type AS messageType,
               messages.attachment_mime AS attachmentMime, messages.attachment_name AS attachmentName,
               messages.duration_ms AS durationMs, messages.edited_at AS editedAt,
               messages.created_at AS createdAt, messages.read_at AS readAt
        FROM messages JOIN users ON users.id = messages.sender_id
        LEFT JOIN agencies sender_agency ON sender_agency.id = users.agency_id
        WHERE messages.conversation_id = ? ORDER BY messages.created_at ASC, messages.id ASC LIMIT 200
      `).all(conversation.id);
      sendJson(response, 200, { messages });
      return;
    }

    const conversationReadMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/read$/i);
    if (conversationReadMatch && method === 'POST') {
      if (!authorizeMutation(request, response, session)) return;
      const conversation = await getAccessibleConversation(conversationReadMatch[1], user);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      await db.prepare('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL')
        .run(nowIso(), conversation.id, user.id);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (conversationMessagesMatch && method === 'POST') {
      if (!authorizeMutation(request, response, session)) return;
      const conversation = await getAccessibleConversation(conversationMessagesMatch[1], user);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      const body = await readJson(request, maxChatRequestBytes);
      const messageType = typeof body.messageType === 'string' ? body.messageType.toUpperCase() : 'TEXT';
      if (!['TEXT', 'IMAGE', 'AUDIO'].includes(messageType)) {
        sendJson(response, 400, { error: 'Choose a text, image, or voice message.' });
        return;
      }
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (message.length > 5_000) {
        sendJson(response, 400, { error: 'Messages cannot be longer than 5,000 characters.' });
        return;
      }
      if (messageType === 'TEXT' && !message) {
        sendJson(response, 400, { error: 'Write a message before sending.' });
        return;
      }
      const attachment = messageType === 'TEXT'
        ? null
        : validateChatAttachment(body.attachmentData, body.attachmentMime, messageType);
      const attachmentName = attachment
        ? String(body.attachmentName || (messageType === 'IMAGE' ? 'photo.jpg' : 'voice-message')).replace(/[^a-z0-9._-]/gi, '_').slice(0, 120)
        : null;
      const durationMs = messageType === 'AUDIO' && Number.isFinite(Number(body.durationMs))
        ? Math.max(0, Math.min(120_000, Math.round(Number(body.durationMs))))
        : null;
      const displayBody = message || (messageType === 'IMAGE' ? 'Photo' : 'Voice message');
      const messageId = crypto.randomUUID();
      const createdAt = nowIso();
      await runInTransaction(async () => {
        await db.prepare(`INSERT INTO messages (
          id, conversation_id, sender_id, body, message_type, attachment_mime, attachment_data,
          attachment_name, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(messageId, conversation.id, user.id, displayBody, messageType, attachment?.mime || null,
            attachment?.data || null, attachmentName, durationMs, createdAt);
        await db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(createdAt, conversation.id);
        await db.prepare('UPDATE users SET typing_conversation_id = NULL, typing_until = NULL WHERE id = ?').run(user.id);
        await db.prepare('DELETE FROM conversation_hidden WHERE conversation_id = ?').run(conversation.id);
      });
      await createConversationMessageNotifications(conversation, user, {
        id: messageId,
        body: displayBody,
        createdAt
      });
      await audit(user.id, messageType === 'TEXT' ? 'CONVERSATION_MESSAGE_SENT' : `CONVERSATION_${messageType}_SENT`, `${conversation.subject} (${conversation.id})`);
      sendJson(response, 201, {
        message: {
          id: messageId, senderId: user.id, senderName: user.name, senderRole: user.role,
          body: displayBody, messageType, attachmentMime: attachment?.mime || null,
          attachmentName, durationMs, createdAt, readAt: null
        }
      });
      return;
    }

    if (pathname === '/api/catalog' && method === 'GET') {
      const selectCatalog = `
          SELECT id, category, title AS titleEn, title_so AS titleSo, destination, route_badge AS routeBadge,
                 specs, supplier_name AS supplierName, supplier_ref AS supplierRef, agency_id AS agencyId,
                 base_cents AS baseUsdCents, tax_cents AS taxUsdCents, supplier_commission_pct AS supplierCommPct,
                 available, travel_date AS travelDate, baggage, is_published AS published,
                 CASE WHEN image_data IS NOT NULL THEN '/api/catalog/' || id || '/image' ELSE NULL END AS imageUrl,
                 base_cents + tax_cents + CAST(ROUND(base_cents * (SELECT markup_pct FROM agencies WHERE agencies.id = catalog_products.agency_id) / 100.0) AS INTEGER) + 1200 AS estimatedTotalUsdCents
          FROM catalog_products`;
      const products = user.role === 'AGENCY'
        ? await db.prepare(`${selectCatalog} WHERE agency_id = ? ORDER BY title`).all(user.agency_id)
        : user.role === 'CLIENT'
          ? await db.prepare(`${selectCatalog}
            WHERE is_published = 1 AND available > 0
              AND agency_id IN (SELECT id FROM agencies WHERE status = 'ACTIVE' AND is_approved = 1)
              AND (travel_date IS NULL OR travel_date >= date('now'))
            ORDER BY title`).all()
          : await db.prepare(`${selectCatalog} ORDER BY title`).all();
      sendJson(response, 200, { catalog: products });
      return;
    }

    if (pathname === '/api/catalog' && method === 'POST') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request, maxCatalogImageRequestBytes);
      const title = requireString(body.title, 'Product name');
      const destination = requireString(body.destination, 'Destination', 12).toUpperCase();
      const origin = typeof body.origin === 'string' ? body.origin.trim().toUpperCase() : '';
      const agencyId = user.role === 'AGENCY' ? user.agency_id : requireString(body.agencyId, 'Agency');
      const category = requireString(body.category, 'Category', 20);
      const price = Number(body.price);
      const available = Number(body.available ?? 1);
      const travelDate = body.travelDate === '' || body.travelDate == null ? null : requireString(body.travelDate, 'Travel date', 10);
      const baggage = typeof body.baggage === 'string' ? body.baggage.trim() : '';
      const specs = typeof body.specs === 'string' && body.specs.trim() ? body.specs.trim().slice(0, 500) : 'Agency managed inventory';
      const published = body.published === undefined || body.published === true ? 1 : body.published === false ? 0 : -1;
      const imageMime = body.imageData == null ? null : requireString(body.imageMime, 'Image type', 32);
      const imageData = body.imageData == null ? null : validateImageData(body.imageData, imageMime);
      const dateIsValid = !travelDate || isValidIsoDate(travelDate);
      const agency = await db.prepare('SELECT id, name FROM agencies WHERE id = ? AND status = ?').get(agencyId, 'ACTIVE');
      if (!agency || !['HOTEL', 'CAR', 'TOUR', 'TRANSFER', 'FLIGHT', 'PACKAGE'].includes(category) ||
          (category === 'FLIGHT' && !/^[A-Z]{3}$/.test(origin)) ||
          !Number.isFinite(price) || price <= 0 || price > 1000000 ||
          !Number.isSafeInteger(available) || available < 0 || available > 100000 ||
          (body.baggage !== undefined && typeof body.baggage !== 'string') ||
          (body.specs !== undefined && typeof body.specs !== 'string') ||
          baggage.length > 120 || !dateIsValid || published < 0) {
        sendJson(response, 400, { error: 'Choose an active agency and enter valid listing details, flight origin, price, availability and travel date.' });
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
        routeBadge: category === 'FLIGHT' ? `${origin} ── ✈ ── ${destination}` : `${destination} • DIRECT`,
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
      await db.prepare(`
        INSERT INTO catalog_products (id, agency_id, title, title_so, category, destination, route_badge, specs, supplier_name, supplier_ref, base_cents, tax_cents, supplier_commission_pct, available, travel_date, baggage, image_mime, image_data, is_published)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(product.id, product.agencyId, product.titleEn, product.titleSo, product.category, product.destination, product.routeBadge, product.specs, product.supplierName, product.supplierRef, product.baseUsdCents, product.taxUsdCents, product.supplierCommPct, product.available, product.travelDate, product.baggage, imageData ? imageMime : null, imageData, published);
      await audit(user.id, published ? 'AGENCY_PRODUCT_PUBLISHED' : 'AGENCY_PRODUCT_DRAFTED', `${title} (${supplierRef})`);
      if (published) publishCatalogChange('published');
      sendJson(response, 201, { product });
      return;
    }

    const catalogMatch = pathname.match(/^\/api\/catalog\/([0-9a-f-]+)$/i);
    if (catalogMatch && ['PATCH', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const existing = await db.prepare('SELECT * FROM catalog_products WHERE id = ?').get(catalogMatch[1]);
      if (!existing || (user.role === 'AGENCY' && existing.agency_id !== user.agency_id)) {
        sendJson(response, 404, { error: 'Inventory listing not found.' });
        return;
      }
      if (method === 'DELETE') {
        await db.prepare('DELETE FROM catalog_products WHERE id = ?').run(existing.id);
        await audit(user.id, 'AGENCY_PRODUCT_REMOVED', `${existing.title} (${existing.supplier_ref})`);
        publishCatalogChange('removed');
        sendJson(response, 200, { ok: true });
        return;
      }

      const body = await readJson(request, maxCatalogImageRequestBytes);
      const title = body.title === undefined ? existing.title : requireString(body.title, 'Product name');
      const destination = body.destination === undefined ? existing.destination : requireString(body.destination, 'Destination', 12).toUpperCase();
      const category = body.category === undefined ? existing.category : requireString(body.category, 'Category', 20);
      const existingOrigin = existing.route_badge.match(/^([A-Z]{3})\s*(?:→|─)/)?.[1] || '';
      const origin = category === 'FLIGHT'
        ? body.origin === undefined ? existingOrigin : requireString(body.origin, 'Origin', 3).toUpperCase()
        : '';
      const price = body.price === undefined ? existing.base_cents / 100 : Number(body.price);
      const available = body.available === undefined ? existing.available : Number(body.available);
      const travelDate = body.travelDate === undefined ? existing.travel_date : body.travelDate === '' || body.travelDate === null ? null : requireString(body.travelDate, 'Travel date', 10);
      const baggage = body.baggage === undefined ? existing.baggage : typeof body.baggage === 'string' ? body.baggage.trim() : '';
      const specs = body.specs === undefined ? existing.specs : typeof body.specs === 'string' && body.specs.trim() ? body.specs.trim().slice(0, 500) : 'Agency managed inventory';
      const published = body.published === undefined ? existing.is_published : body.published === true ? 1 : body.published === false ? 0 : -1;
      const imageMime = body.imageData === undefined
        ? existing.image_mime
        : body.imageData === null ? null : requireString(body.imageMime, 'Image type', 32);
      const imageData = body.imageData === undefined
        ? existing.image_data
        : body.imageData === null ? null : validateImageData(body.imageData, imageMime);
      const dateIsValid = !travelDate || isValidIsoDate(travelDate);
      if (!['HOTEL', 'CAR', 'TOUR', 'TRANSFER', 'FLIGHT', 'PACKAGE'].includes(category) ||
          (category === 'FLIGHT' && !/^[A-Z]{3}$/.test(origin)) ||
          !Number.isFinite(price) || price <= 0 || price > 1000000 ||
          !Number.isSafeInteger(available) || available < 0 || available > 100000 ||
          (body.baggage !== undefined && typeof body.baggage !== 'string') ||
          (body.specs !== undefined && typeof body.specs !== 'string') ||
          baggage.length > 120 || !dateIsValid || published < 0) {
        sendJson(response, 400, { error: 'Enter valid listing details, price, availability and travel date.' });
        return;
      }
      const routeBadge = category === 'FLIGHT' ? `${origin} ── ✈ ── ${destination}` : `${destination} • DIRECT`;
      await db.prepare(`
        UPDATE catalog_products
        SET title = ?, title_so = ?, category = ?, destination = ?, route_badge = ?, specs = ?,
            base_cents = ?, tax_cents = ?, available = ?, travel_date = ?, baggage = ?,
            image_mime = ?, image_data = ?, is_published = ?
        WHERE id = ?
      `).run(title, title, category, destination, routeBadge, specs, Math.round(price * 100), Math.round(price * 12), available, travelDate, baggage, imageData ? imageMime : null, imageData, published, existing.id);
      await audit(user.id, published ? 'AGENCY_PRODUCT_UPDATED' : 'AGENCY_PRODUCT_UNPUBLISHED', `${title} (${existing.supplier_ref})`);
      publishCatalogChange(published ? 'updated' : 'paused');
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === '/api/payments/waafi/refresh' && method === 'POST') {
      if (!requireRole(response, user, ['CLIENT', 'AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const referenceId = requireString(body.referenceId, 'Payment reference', 80);
      const owner = await db.prepare(`SELECT b.customer_id AS customerId, b.agency_id AS agencyId
        FROM waafi_payments p JOIN bookings b ON b.id = p.booking_id WHERE p.reference_id = ?`).get(referenceId);
      if (!owner || (user.role === 'CLIENT' && owner.customerId !== user.id) ||
          (user.role === 'AGENCY' && owner.agencyId !== user.agency_id)) {
        sendJson(response, 404, { error: 'Payment record not found.' });
        return;
      }
      const payment = await refreshWaafiPayment(referenceId);
      sendJson(response, 200, { payment: { referenceId: payment.referenceId, status: payment.status, transactionId: payment.transactionId || null } });
      return;
    }

    const bookingActionMatch = pathname.match(/^\/api\/bookings\/([0-9a-f-]+)$/i);
    if (bookingActionMatch && ['PATCH', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const bookingId = bookingActionMatch[1];
      const selectBooking = `SELECT id, reference AS ref, pnr, agency_id AS agencyId, offer_id AS offerId,
        cancellation_reason AS cancellationReason, customer_id AS customerId, traveler_name AS travelerName, traveler_email AS travelerEmail, phone,
        offer_title AS offerTitle, category, payment_provider AS paymentProvider, state, financials_json,
        seat_count AS seatCount, travel_date AS travelDate, created_at AS createdAtUtc, updated_at AS updatedAtUtc,
        (SELECT status FROM waafi_payments WHERE booking_id = bookings.id) AS paymentStatus,
        (SELECT transaction_id FROM waafi_payments WHERE booking_id = bookings.id) AS paymentTransactionId,
        (SELECT reference_id FROM waafi_payments WHERE booking_id = bookings.id) AS paymentReference
        FROM bookings WHERE id = ?`;
      const existing = await db.prepare(selectBooking).get(bookingId);
      if (!existing || (user.role === 'AGENCY' && existing.agencyId !== user.agency_id)) {
        sendJson(response, 404, { error: 'Booking request not found.' });
        return;
      }

      if (method === 'PATCH') {
        const body = await readJson(request);
        let generatedTicket = null;
        let ticketError = null;
        if (body.action === 'ACCEPT') {
          if (!['REQUESTED', 'PAYMENT_RECEIVED'].includes(existing.state)) {
            sendJson(response, 409, { error: 'Only a new request or a paid request can be accepted.' });
            return;
          }
          const accepted = await db.prepare('UPDATE bookings SET state = ?, updated_at = ? WHERE id = ? AND agency_id = ? AND state = ?')
            .run('ACCEPTED', nowIso(), bookingId, existing.agencyId, existing.state);
          if (accepted.changes !== 1) {
            sendJson(response, 409, { error: 'This request has changed. Refresh the bookings list and try again.' });
            return;
          }
          await audit(user.id, 'BOOKING_REQUEST_ACCEPTED', `${existing.ref} (${existing.agencyId})`);
          try {
            const ticketResult = await ensureBookingTicketDocument(bookingId, `https://${request.headers.host}`);
            generatedTicket = ticketResult.document;
          } catch (error) {
            ticketError = error.message;
            console.error('Booking confirmation generation failed after approval:', error);
          }
        } else if (body.action === 'UNDO_ACCEPTANCE') {
          if (existing.state !== 'ACCEPTED' || existing.paymentProvider !== 'REQUEST_ONLY' || existing.paymentStatus === 'APPROVED') {
            sendJson(response, 409, { error: 'Only an unpaid accepted request can be returned to the pending list. Use booking cancellation for paid bookings.' });
            return;
          }
          const reopened = await db.prepare(`UPDATE bookings SET state = 'REQUESTED', updated_at = ?
            WHERE id = ? AND agency_id = ? AND state = 'ACCEPTED' AND payment_provider = 'REQUEST_ONLY'
              AND NOT EXISTS (SELECT 1 FROM waafi_payments WHERE booking_id = bookings.id AND status = 'APPROVED')`)
            .run(nowIso(), bookingId, existing.agencyId);
          if (reopened.changes !== 1) {
            sendJson(response, 409, { error: 'This booking can no longer be reopened. Refresh the bookings list and try again.' });
            return;
          }
          await audit(user.id, 'BOOKING_ACCEPTANCE_UNDONE', `${existing.ref} (${existing.agencyId})`);
        } else if (body.action === 'EDIT') {
          if (existing.state !== 'REQUESTED' || existing.paymentProvider !== 'REQUEST_ONLY') {
            sendJson(response, 409, { error: 'Traveler details can only be edited before the request is accepted or paid.' });
            return;
          }
          if (body.travelerEmail !== undefined && body.travelerEmail !== null && typeof body.travelerEmail !== 'string') {
            sendJson(response, 400, { error: 'Enter a valid traveler email address or leave it blank.' });
            return;
          }
          const travelerName = requireString(body.travelerName, 'Traveler name');
          const travelerEmailText = typeof body.travelerEmail === 'string' ? body.travelerEmail.trim() : '';
          const travelerEmail = travelerEmailText ? normalizeEmail(travelerEmailText) : null;
          const phone = requireString(body.phone, 'Phone', 40);
          const updated = await db.prepare(`UPDATE bookings SET traveler_name = ?, traveler_email = ?, phone = ?, updated_at = ?
            WHERE id = ? AND agency_id = ? AND state = 'REQUESTED' AND payment_provider = 'REQUEST_ONLY'`)
            .run(travelerName, travelerEmail, phone, nowIso(), bookingId, existing.agencyId);
          if (updated.changes !== 1) {
            sendJson(response, 409, { error: 'This request has changed. Refresh the bookings list and try again.' });
            return;
          }
          await audit(user.id, 'BOOKING_TRAVELER_DETAILS_UPDATED', `${existing.ref} (${existing.agencyId})`);
        } else if (body.action === 'REJECT') {
          if (existing.state !== 'REQUESTED' || existing.paymentProvider !== 'REQUEST_ONLY') {
            sendJson(response, 409, { error: 'Only an unpaid requested booking can be rejected.' });
            return;
          }
          const reason = typeof body.reason === 'string' ? body.reason.trim().replace(/\s+/g, ' ').slice(0, 500) : '';
          const rejected = await runInTransaction(async () => {
            const changed = await db.prepare(`UPDATE bookings SET state = 'REJECTED', cancellation_reason = ?, updated_at = ?
              WHERE id = ? AND agency_id = ? AND state = 'REQUESTED' AND payment_provider = 'REQUEST_ONLY'
              RETURNING seat_count AS seatCount, offer_id AS offerId`).get(reason || 'Rejected by agency', nowIso(), bookingId, existing.agencyId);
            if (!changed) return null;
            if (changed.offerId) await db.prepare('UPDATE catalog_products SET available = available + ? WHERE id = ? AND agency_id = ?')
              .run(changed.seatCount, changed.offerId, existing.agencyId);
            return changed;
          });
          if (!rejected) {
            sendJson(response, 409, { error: 'This request has changed. Refresh the bookings list and try again.' });
            return;
          }
          await audit(user.id, 'BOOKING_REQUEST_REJECTED', `${existing.ref} (${existing.agencyId})`);
          if (rejected.offerId) publishCatalogChange('availability');
        } else if (body.action === 'RESTORE_REQUESTED') {
          if (existing.state !== 'REJECTED' || existing.paymentProvider !== 'REQUEST_ONLY') {
            sendJson(response, 409, { error: 'Only a rejected unpaid request can be restored.' });
            return;
          }
          const restored = await runInTransaction(async () => {
            if (existing.offerId) {
              const inventory = await db.prepare('UPDATE catalog_products SET available = available - ? WHERE id = ? AND agency_id = ? AND available >= ?')
                .run(existing.seatCount, existing.offerId, existing.agencyId, existing.seatCount);
              if (inventory.changes !== 1) return null;
            }
            return db.prepare(`UPDATE bookings SET state = 'REQUESTED', cancellation_reason = NULL, updated_at = ?
              WHERE id = ? AND agency_id = ? AND state = 'REJECTED'`).run(nowIso(), bookingId, existing.agencyId);
          });
          if (!restored || restored.changes !== 1) {
            sendJson(response, 409, { error: 'The request could not be restored because inventory changed. Refresh and try again.' });
            return;
          }
          await audit(user.id, 'BOOKING_REQUEST_RESTORED', `${existing.ref} (${existing.agencyId})`);
          if (existing.offerId) publishCatalogChange('availability');
        } else {
          sendJson(response, 400, { error: 'Choose accept, undo acceptance, edit, reject, or restore this booking request.' });
          return;
        }

        const updatedBooking = await db.prepare(selectBooking).get(bookingId);
        const { financials_json, ...booking } = updatedBooking;
        sendJson(response, 200, { booking: { ...booking, financials: JSON.parse(financials_json) }, ticket: generatedTicket, ticketError });
        return;
      }

      const isNewUnpaidRequest = existing.state === 'REQUESTED' && existing.paymentProvider === 'REQUEST_ONLY';
      const isAcceptedBooking = existing.state === 'ACCEPTED';
      if (!isNewUnpaidRequest && !isAcceptedBooking) {
        sendJson(response, 409, { error: 'Only an open request or an accepted booking can be canceled here.' });
        return;
      }
      const body = await readJson(request);
      const reason = requireString(body.reason, 'Cancellation reason', 500).replace(/\s+/g, ' ');
      if (body.returnSeats !== undefined && typeof body.returnSeats !== 'boolean') {
        sendJson(response, 400, { error: 'Choose whether the seats can return to inventory.' });
        return;
      }
      const paymentReceived = existing.paymentStatus === 'APPROVED';
      const returnSeats = !paymentReceived || body.returnSeats === true;
      if (paymentReceived && body.returnSeats === undefined) {
        sendJson(response, 400, { error: 'Choose whether the paid seats are safe to return to inventory.' });
        return;
      }
      if (paymentReceived && returnSeats && body.confirmTicketNotIssued !== true) {
        sendJson(response, 400, { error: 'Confirm that the travel ticket was not issued before returning its seats.' });
        return;
      }
      if (returnSeats && !existing.offerId) {
        sendJson(response, 409, { error: 'This older booking has no linked trip, so its seats cannot be safely returned.' });
        return;
      }
      const canceled = await runInTransaction(async () => {
        const canceledBooking = await db.prepare(`UPDATE bookings SET state = 'CANCELLED', cancellation_reason = ?, updated_at = ?
          WHERE id = ? AND agency_id = ? AND state = ? AND payment_provider = ?
          RETURNING seat_count AS seatCount`)
          .get(reason, nowIso(), bookingId, existing.agencyId, existing.state, existing.paymentProvider);
        if (!canceledBooking) return null;
        let available = null;
        if (returnSeats) {
          const inventory = await db.prepare(`UPDATE catalog_products SET available = available + ?
            WHERE id = ? AND agency_id = ?`).run(canceledBooking.seatCount, existing.offerId, existing.agencyId);
          if (inventory.changes !== 1) {
            throw Object.assign(new Error('The trip inventory could not be restored. The booking was not canceled.'), { statusCode: 409 });
          }
          available = (await db.prepare('SELECT available FROM catalog_products WHERE id = ?').get(existing.offerId)).available;
        }
        await audit(user.id, 'BOOKING_CANCELLED', `${existing.ref} (${existing.agencyId}): ${reason}`);
        return { offerId: returnSeats ? existing.offerId : null, available, seatsReturned: returnSeats, paymentNeedsRefund: paymentReceived };
      });
      if (!canceled) {
        sendJson(response, 409, { error: 'This request has changed. Refresh the bookings list and try again.' });
        return;
      }
      if (canceled.seatsReturned) publishCatalogChange('availability');
      const message = canceled.paymentNeedsRefund
        ? canceled.seatsReturned
          ? 'Booking canceled and seats returned. Any payment refund must be handled separately.'
          : 'Booking canceled. Payment was not refunded, and the seats remain reserved.'
        : 'Request canceled. Its seats are available again.';
      sendJson(response, 200, { ok: true, message, ...canceled });
      return;
    }

    if (pathname === '/api/bookings' && method === 'GET') {
      const bookingScope = user.role === 'SUPER_ADMIN' ? '' : user.role === 'AGENCY' ? 'WHERE b.agency_id = ?' : 'WHERE b.customer_id = ?';
      const bookingScopeValue = user.role === 'SUPER_ADMIN' ? [] : [user.role === 'AGENCY' ? user.agency_id : user.id];
      const records = await db.prepare(`
        SELECT b.id, b.reference AS ref, b.pnr, b.agency_id AS agencyId, b.offer_id AS offerId,
          b.cancellation_reason AS cancellationReason, b.customer_id AS customerId,
          b.traveler_name AS travelerName, b.traveler_email AS travelerEmail, b.phone,
          b.offer_title AS offerTitle, b.category, b.payment_provider AS paymentProvider, b.state,
          b.financials_json, b.seat_count AS seatCount, b.travel_date AS travelDate,
          b.created_at AS createdAtUtc, b.updated_at AS updatedAtUtc,
          (SELECT status FROM waafi_payments WHERE booking_id = b.id) AS paymentStatus,
          (SELECT transaction_id FROM waafi_payments WHERE booking_id = b.id) AS paymentTransactionId,
          (SELECT reference_id FROM waafi_payments WHERE booking_id = b.id) AS paymentReference,
          a.name AS agencyName, a.logo_mime AS agencyLogoMime, a.logo_data AS agencyLogoData,
          (SELECT email FROM users WHERE users.agency_id = a.id AND users.role = 'AGENCY' ORDER BY users.created_at LIMIT 1) AS agencyEmail,
          (SELECT phone FROM users WHERE users.agency_id = a.id AND users.role = 'AGENCY' ORDER BY users.created_at LIMIT 1) AS agencyPhone,
          c.route_badge AS routeBadge, c.destination, c.supplier_name AS supplierName,
          c.supplier_ref AS supplierRef, c.baggage, c.specs,
          d.id AS ticketDocumentId, d.document_reference AS ticketDocumentReference,
          d.document_version AS ticketDocumentVersion, d.document_type AS ticketDocumentType,
          d.status AS ticketStatus, d.file_name AS ticketFileName, d.jpg_file_name AS ticketJpgFileName,
          d.issued_at AS ticketIssuedAt,
          CASE WHEN d.error_message IS NOT NULL OR COALESCE(d.layout_version, 1) < ${ticketLayoutVersion} THEN 1 ELSE 0 END AS ticketRetryAvailable,
          d.email_delivery_status AS ticketEmailStatus, d.email_sent_at AS ticketEmailSentAt
        FROM bookings b
        JOIN agencies a ON a.id = b.agency_id
        LEFT JOIN catalog_products c ON c.id = b.offer_id
        LEFT JOIN booking_documents d ON d.booking_id = b.id AND d.document_type = 'BOOKING_CONFIRMATION'
        ${bookingScope}
        ORDER BY b.created_at DESC
      `).all(...bookingScopeValue);
      sendJson(response, 200, { bookings: records.map(({ financials_json, ...booking }) => ({ ...booking, financials: JSON.parse(financials_json) })) });
      return;
    }

    if (pathname === '/api/bookings' && method === 'POST') {
      if (user) {
        if (!requireRole(response, user, ['CLIENT', 'AGENCY'])) return;
        if (!authorizeMutation(request, response, session)) return;
      } else {
        const origin = request.headers.origin;
        const expectedOrigin = `http://${request.headers.host}`;
        const expectedSecureOrigin = `https://${request.headers.host}`;
        if (!origin || (origin !== expectedOrigin && origin !== expectedSecureOrigin)) {
          sendJson(response, 403, { error: 'A same-origin request is required to submit a guest booking.' });
          return;
        }
        if (!await allowRateLimitRequest(`guest-booking:${clientIp(request)}`, 15 * 60 * 1000, 5)) {
          sendJson(response, 429, { error: 'Too many booking requests. Please wait 15 minutes before trying again.' }, {
            'Retry-After': '900'
          });
          return;
        }
      }
      const body = await readJson(request);
      const offerId = requireString(body.offerId, 'Travel offer', 80);
      const seatCount = body.seatCount === undefined ? 1 : Number(body.seatCount);
      if (!Number.isSafeInteger(seatCount) || seatCount < 1 || seatCount > 100000) {
        sendJson(response, 400, { error: 'Enter a number of seats from 1 to 100,000.' });
        return;
      }
      const offer = await db.prepare(`
        SELECT catalog_products.*, agencies.markup_pct AS agency_markup_pct
        FROM catalog_products JOIN agencies ON agencies.id = catalog_products.agency_id
        WHERE catalog_products.id = ? AND agencies.status = 'ACTIVE' AND agencies.is_approved = 1
          AND catalog_products.is_published = 1
          AND (catalog_products.travel_date IS NULL OR catalog_products.travel_date >= date('now'))
      `).get(offerId);
      if (!offer || (user?.role === 'AGENCY' && offer.agency_id !== user.agency_id)) {
        sendJson(response, 404, { error: 'This trip is no longer available. Refresh the trip list and choose another.' });
        return;
      }
      if (offer.available < seatCount) {
        sendJson(response, 409, { error: `Only ${offer.available} ${offer.available === 1 ? 'seat is' : 'seats are'} left for this trip. Choose fewer seats or another trip.` });
        return;
      }
      const rawPaymentMethod = typeof body.paymentMethod === 'string' ? body.paymentMethod : 'REQUEST_ONLY';
      const paymentMethod = rawPaymentMethod === 'EVC_PLUS' ? 'REQUEST_ONLY' : rawPaymentMethod;
      const travelDate = body.travelDate === undefined || body.travelDate === '' ? offer.travel_date : requireString(body.travelDate, 'Travel date', 10);
      if ((travelDate && (!isValidIsoDate(travelDate) || travelDate < new Date().toISOString().slice(0, 10))) ||
          (offer.travel_date && travelDate !== offer.travel_date)) {
        sendJson(response, 400, { error: 'Choose a valid travel date available for this listing.' });
        return;
      }
      if (!['REQUEST_ONLY', 'WAAFI'].includes(paymentMethod)) {
        sendJson(response, 400, { error: 'Choose a valid booking request option.' });
        return;
      }
      if (paymentMethod === 'WAAFI' && (user?.role !== 'CLIENT' || !getWaafiConfig())) {
        sendJson(response, 503, { error: 'Online checkout is unavailable for this account. Choose a booking request or contact support.' });
        return;
      }
      const travelerName = requireString(body.travelerName, 'Traveler name');
      const travelerEmail = user?.role === 'CLIENT'
        ? normalizeEmail(body.travelerEmail || user.email)
        : normalizeEmail(body.travelerEmail || '');
      const phone = requireString(body.phone, 'Phone', 40);
      const baseCents = offer.base_cents;
      const taxCents = offer.tax_cents;
      const supplierCommissionCents = Math.round(baseCents * offer.supplier_commission_pct / 100);
      const agencyCommissionCents = Math.round(baseCents * offer.agency_markup_pct / 100);
      const safarKaabeFeeCents = 1200;
      const subtotalCents = baseCents + taxCents + agencyCommissionCents + safarKaabeFeeCents;
      const paymentFeeCents = 0;
      const financials = {
        supplierBaseCents: baseCents * seatCount,
        supplierTaxesCents: taxCents * seatCount,
        supplierCommissionCents: supplierCommissionCents * seatCount,
        agencyCommissionCents: agencyCommissionCents * seatCount,
        safarKaabeFeeCents: safarKaabeFeeCents * seatCount,
        paymentFeeCents: paymentFeeCents * seatCount,
        customerGrandTotalCents: (subtotalCents + paymentFeeCents) * seatCount,
        netPayableToSupplierCents: (baseCents + taxCents - supplierCommissionCents) * seatCount,
        recognizedPlatformRevenueCents: (safarKaabeFeeCents + supplierCommissionCents) * seatCount,
        agencyMarkupPct: offer.agency_markup_pct
      };
      const booking = {
        id: crypto.randomUUID(),
        reference: `SK-${randomCode()}`,
        pnr: `REQ-SK-${randomCode()}`,
        agencyId: offer.agency_id,
        offerId: offer.id,
        customerId: user?.role === 'CLIENT' ? user.id : null,
        travelerName,
        travelerEmail,
        phone,
        offerTitle: offer.title,
        category: offer.category,
        paymentProvider: paymentMethod === 'WAAFI' ? 'WAAFI' : 'REQUEST_ONLY',
        state: paymentMethod === 'WAAFI' ? 'PAYMENT_PENDING' : 'REQUESTED',
        seatCount,
        travelDate,
        financials
      };
      const normalizedPhone = phone.replace(/[\s()+.-]/g, '').replace(/^00/, '');
      const subscriptionId = /^0\d{8,14}$/.test(normalizedPhone) ? `252${normalizedPhone.slice(1)}` : normalizedPhone;
      if (paymentMethod === 'WAAFI' && !/^\d{10,15}$/.test(subscriptionId)) {
        sendJson(response, 400, { error: 'Enter a valid mobile wallet number with its country code.' });
        return;
      }
      const inventoryUpdate = await db.prepare(`UPDATE catalog_products SET available = available - ?
        WHERE id = ? AND is_published = 1 AND available >= ?
          AND (travel_date IS NULL OR travel_date >= date('now'))
          AND EXISTS (SELECT 1 FROM agencies WHERE agencies.id = catalog_products.agency_id
            AND agencies.status = 'ACTIVE' AND agencies.is_approved = 1)`);
      const inventoryAvailable = await runInTransaction(async () => (await inventoryUpdate.run(seatCount, offer.id, seatCount)).changes === 1);
      if (!inventoryAvailable) {
        const latestInventory = await db.prepare('SELECT available FROM catalog_products WHERE id = ?').get(offer.id);
        const availableSeats = latestInventory?.available ?? 0;
        sendJson(response, 409, { error: `Only ${availableSeats} ${availableSeats === 1 ? 'seat is' : 'seats are'} left for this trip. Choose fewer seats or another trip.` });
        return;
      }
      let paymentStart = null;
      if (paymentMethod === 'WAAFI') {
        try {
          const referenceId = `SK-${crypto.randomUUID()}`;
          const origin = `https://${request.headers.host}`;
          const { payload } = await waafiRequest('HPP_PURCHASE', {
          paymentMethod: 'MWALLET_ACCOUNT',
          hppSuccessCallbackUrl: `${origin}/api/payments/waafi/success?referenceId=${encodeURIComponent(referenceId)}`,
          hppFailureCallbackUrl: `${origin}/api/payments/waafi/failure?referenceId=${encodeURIComponent(referenceId)}`,
          hppRespDataFormat: 2,
          payerInfo: { subscriptionId },
          transactionInfo: {
            referenceId,
            amount: Number((financials.customerGrandTotalCents / 100).toFixed(2)),
            currency: 'USD',
            description: `SAFAR KAABE ticket request ${booking.reference}`
          }
          });
          const params = payload.params || {};
          const hppUrl = params.hppUrl || params.paymentUrl;
          if (String(payload.responseCode) !== '2001' || typeof hppUrl !== 'string' || !/^https:\/\//i.test(hppUrl)) {
            throw Object.assign(new Error('WaafiPay could not create a secure checkout link. No booking or payment was recorded.'), { statusCode: 502 });
          }
          paymentStart = { referenceId, hppUrl, orderId: params.orderId ? String(params.orderId) : null };
        } catch (error) {
          await db.prepare('UPDATE catalog_products SET available = available + ? WHERE id = ?').run(seatCount, offer.id);
          throw error;
        }
      }
      const createdAtUtc = nowIso();
      let bookingConversationId = null;
      const bookingNotifications = [];
      try {
        await runInTransaction(async () => {
        await db.prepare(`
          INSERT INTO bookings (id, reference, pnr, agency_id, offer_id, customer_id, traveler_name, traveler_email, phone, offer_title, category, payment_provider, state, financials_json, seat_count, travel_date, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(booking.id, booking.reference, booking.pnr, booking.agencyId, booking.offerId, booking.customerId, booking.travelerName, booking.travelerEmail, booking.phone, booking.offerTitle, booking.category, booking.paymentProvider, booking.state, JSON.stringify(booking.financials), booking.seatCount, booking.travelDate, createdAtUtc, createdAtUtc);
        if (booking.customerId) {
          const existingConversation = await db.prepare(`
            SELECT id FROM conversations
            WHERE agency_id = ? AND customer_id = ?
            ORDER BY last_message_at DESC
            LIMIT 1
          `).get(booking.agencyId, booking.customerId);
          bookingConversationId = existingConversation?.id || crypto.randomUUID();
          if (!existingConversation) {
            await db.prepare(`
              INSERT INTO conversations (id, agency_id, customer_id, subject, created_by, created_at, last_message_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
              bookingConversationId,
              booking.agencyId,
              booking.customerId,
              `Booking ${booking.reference}`,
              booking.customerId,
              createdAtUtc,
              createdAtUtc
            );
          }
          await db.prepare(`
            INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            crypto.randomUUID(),
            bookingConversationId,
            booking.customerId,
            `Booking request ${booking.reference} submitted for ${booking.offerTitle}. ${booking.seatCount} ${booking.seatCount === 1 ? 'seat' : 'seats'} requested${booking.travelDate ? ` for ${booking.travelDate}` : ''}.`,
            createdAtUtc
          );
          await db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?')
            .run(createdAtUtc, bookingConversationId);
        }
        if (paymentStart) {
          await db.prepare(`INSERT INTO waafi_payments (id, booking_id, reference_id, amount_cents, currency, status, hpp_url, order_id, updated_at, created_at)
            VALUES (?, ?, ?, ?, 'USD', 'PENDING', ?, ?, ?, ?)`)
            .run(crypto.randomUUID(), booking.id, paymentStart.referenceId, booking.financials.customerGrandTotalCents,
              paymentStart.hppUrl, paymentStart.orderId, createdAtUtc, createdAtUtc);
        }
        const agencyRecipients = await db.prepare("SELECT id FROM users WHERE agency_id = ? AND role = 'AGENCY'").all(booking.agencyId);
        for (const recipient of agencyRecipients) {
          const notification = {
            id: crypto.randomUUID(), recipientUserId: recipient.id, agencyId: booking.agencyId,
            bookingId: booking.id, conversationId: bookingConversationId, type: 'BOOKING_REQUEST',
            title: 'New Booking Request',
            body: `${booking.travelerName} requested ${booking.offerTitle}${booking.travelDate ? ` on ${booking.travelDate}` : ''}. Booking ID: ${booking.reference}.`,
            href: `/?booking=${encodeURIComponent(booking.id)}`, createdAt: createdAtUtc, readAt: null,
            dedupeKey: `BOOKING_REQUEST:${booking.id}:${recipient.id}`
          };
          const inserted = await db.prepare(`
            INSERT INTO notifications (id, recipient_user_id, agency_id, booking_id, conversation_id, type, title, body, href, dedupe_key, created_at, read_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (dedupe_key) DO NOTHING
          `).run(notification.id, notification.recipientUserId, notification.agencyId, notification.bookingId, notification.conversationId,
            notification.type, notification.title, notification.body, notification.href, notification.dedupeKey, notification.createdAt, notification.readAt);
          if (inserted.changes === 1) bookingNotifications.push(notification);
        }
        });
      } catch (error) {
        await db.prepare('UPDATE catalog_products SET available = available + ? WHERE id = ?').run(seatCount, offer.id);
        throw error;
      }
      for (const notification of bookingNotifications) {
        publishNotification(notification.recipientUserId, notification);
        deliverWebPush(notification.recipientUserId, notification).catch(error => console.warn('Web push notification failed:', error.message));
      }
      await audit(user?.id || null, paymentStart ? 'WAAFI_CHECKOUT_STARTED' : 'BOOKING_REQUESTED', `${booking.reference} (${booking.agencyId})`);
      publishCatalogChange('availability');
      sendJson(response, 201, { booking: { ...booking, ref: booking.reference, createdAtUtc,
        paymentStatus: paymentStart ? 'PENDING' : null, paymentReference: paymentStart?.referenceId || null,
        conversationId: bookingConversationId },
        conversationId: bookingConversationId,
        paymentUrl: paymentStart?.hppUrl || null });
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
        await runInTransaction(async () => {
          await db.prepare('INSERT INTO agencies (id, name, tier, markup_pct, status, is_approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, name, tier, markup, 'SUSPENDED', 0, nowIso());
          await db.prepare('INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, agency_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(ownerId, ownerEmail, ownerName, '', credentials.salt, credentials.hash, 'AGENCY', id, nowIso());
          await audit(user.id, 'AGENCY_REGISTERED', `${name} (${ownerEmail})`);
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
      if (!agencyId || !await db.prepare('SELECT id FROM agencies WHERE id = ?').get(agencyId)) {
        sendJson(response, 400, { error: 'Choose a valid agency.' });
        return;
      }
      const clients = await db.prepare('SELECT id, name, phone, email, created_at AS createdAt FROM agency_clients WHERE agency_id = ? ORDER BY created_at DESC').all(agencyId);
      sendJson(response, 200, { clients });
      return;
    }

    if (pathname === '/api/agency/staff' && method === 'POST') {
      if (!requireRole(response, user, ['AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const agencyId = user.role === 'AGENCY' ? user.agency_id : requireString(body.agencyId, 'Agency');
      if (!await db.prepare('SELECT id FROM agencies WHERE id = ?').get(agencyId)) {
        sendJson(response, 404, { error: 'Agency not found.' });
        return;
      }
      const name = requireString(body.name, 'Staff name');
      const email = normalizeEmail(body.email);
      const password = validatePassword(body.password);
      const credentials = await hashPassword(password);
      const id = crypto.randomUUID();
      try {
        await db.prepare('INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, agency_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, email, name, '', credentials.salt, credentials.hash, 'AGENCY', agencyId, nowIso());
      } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed')) {
          sendJson(response, 409, { error: 'An account with that email already exists.' });
          return;
        }
        throw error;
      }
      await audit(user.id, 'AGENCY_STAFF_CREATED', `${name} (${email}, ${agencyId})`);
      sendJson(response, 201, { staff: { id, name, email, role: 'AGENCY', createdAt: nowIso() } });
      return;
    }

    const staffMatch = pathname.match(/^\/api\/agency\/staff\/([0-9a-f-]+)$/i);
    if (staffMatch && method === 'DELETE') {
      if (!requireRole(response, user, ['AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const staff = await db.prepare("SELECT id, agency_id, name, email FROM users WHERE id = ? AND role = 'AGENCY'").get(staffMatch[1]);
      if (!staff || (user.role === 'AGENCY' && user.agency_id !== staff.agency_id) || staff.id === user.id) {
        sendJson(response, 404, { error: 'Staff account not found.' });
        return;
      }
      await db.prepare('DELETE FROM users WHERE id = ?').run(staff.id);
      await audit(user.id, 'AGENCY_STAFF_DELETED', `${staff.email} (${staff.agency_id})`);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === '/api/agency/clients' && method === 'POST') {
      if (!requireRole(response, user, ['AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const agencyId = user.role === 'AGENCY' ? user.agency_id : requireString(body.agencyId, 'Agency');
      if (!await db.prepare('SELECT id FROM agencies WHERE id = ?').get(agencyId)) {
        sendJson(response, 404, { error: 'Agency not found.' });
        return;
      }
      const name = requireString(body.name, 'Client name');
      const phone = requireString(body.phone, 'Phone', 40);
      const email = body.email ? normalizeEmail(body.email) : null;
      const client = { id: crypto.randomUUID(), name, phone, email, createdAt: nowIso() };
      await db.prepare('INSERT INTO agency_clients (id, agency_id, name, phone, email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(client.id, agencyId, client.name, client.phone, client.email, client.createdAt);
      await audit(user.id, 'AGENCY_CLIENT_CREATED', `${name} (${agencyId})`);
      sendJson(response, 201, { client });
      return;
    }

    const clientMatch = pathname.match(/^\/api\/agency\/clients\/([0-9a-f-]+)$/i);
    if (clientMatch && method === 'DELETE') {
      if (!requireRole(response, user, ['AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const client = await db.prepare('SELECT id, agency_id, name FROM agency_clients WHERE id = ?').get(clientMatch[1]);
      if (!client || (user.role === 'AGENCY' && user.agency_id !== client.agency_id)) {
        sendJson(response, 404, { error: 'Client not found.' });
        return;
      }
      await db.prepare('DELETE FROM agency_clients WHERE id = ?').run(client.id);
      await audit(user.id, 'AGENCY_CLIENT_DELETED', `${client.name} (${client.agency_id})`);
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

async function handleRequest(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  let requestPath = '/';
  try {
    await dbReady;
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    requestPath = url.pathname;
    const isLogin = request.method === 'POST' && url.pathname === '/api/auth/login';
    const loginRateKey = isLogin ? `login:${clientIp(request)}` : null;
    if (loginRateKey) {
      const attempt = await db.prepare('SELECT attempts, expires_at FROM auth_rate_limits WHERE key = ?').get(loginRateKey);
      if (attempt && attempt.expires_at > Date.now() && attempt.attempts >= 10) {
        sendJson(response, 429, { error: 'Too many sign-in attempts. Try again in a few minutes.' }, {
          'Retry-After': String(Math.ceil((attempt.expires_at - Date.now()) / 1000))
        });
        return;
      }
    }
    if (url.pathname.startsWith('/api/')) {
      const isInitialAdminSetup = request.method === 'POST' && url.pathname === '/api/setup/admin';
      const before = isInitialAdminSetup
        ? (await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'SUPER_ADMIN'").get()).count
        : null;
      await handleApi(request, response, url);
      if (loginRateKey) {
        if (response.statusCode >= 400) await allowRateLimitRequest(loginRateKey, 5 * 60 * 1000, 10);
        else await db.prepare('DELETE FROM auth_rate_limits WHERE key = ?').run(loginRateKey);
      }
      if (before === 0) {
        const after = (await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'SUPER_ADMIN'").get()).count;
        if (after > 0) console.log('Initial Super Admin account created.');
      }
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
    if (error.statusCode >= 500 || !error.statusCode) {
      console.error(`Request failed for ${request.method} ${requestPath}:`, error);
    }
    sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'The server could not complete your request.' });
  }
}

module.exports = handleRequest;
module.exports.databaseReady = dbReady;
module.exports.database = db;

if (require.main === module && !process.env.VERCEL) {
  const server = http.createServer(handleRequest);
  server.listen(port, host, () => {
    console.log(`SAFAR KAABE is running at http://localhost:${port}`);
    console.log(`Database: ${db.isPostgres ? 'PostgreSQL' : path.join(dataDir, 'safar-kaabe.sqlite')}`);
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal) console.log(`On this Wi-Fi network: http://${address.address}:${port}`);
      }
    }
    console.log('Create the first Super Admin account in the app to get started.');
    console.log('Press Ctrl+C to stop the server.');
  });
}

function validateChatAttachment(dataUrl, suppliedMime, expectedType) {
  const mime = typeof suppliedMime === 'string' ? suppliedMime.toLowerCase().split(';')[0].trim() : '';
  const allowedMimes = expectedType === 'IMAGE'
    ? new Set(['image/jpeg', 'image/png', 'image/webp'])
    : new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac']);
  if (!allowedMimes.has(mime) || typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(maxChatAttachmentBytes * 4 / 3) + 160) {
    throw Object.assign(new Error(expectedType === 'IMAGE'
      ? 'Choose a JPEG, PNG, or WebP image no larger than 2 MB.'
      : 'Choose a supported audio recording no larger than 2 MB.'), { statusCode: 400 });
  }
  const match = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?;base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i);
  if (!match || match[1].toLowerCase() !== mime) {
    throw Object.assign(new Error('The selected attachment is invalid.'), { statusCode: 400 });
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxChatAttachmentBytes) {
    throw Object.assign(new Error('Attachments must be no larger than 2 MB.'), { statusCode: 413 });
  }
  const isPng = mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  const isWebp = mime === 'image/webp' && bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const isWebm = mime === 'audio/webm' && bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const isOgg = mime === 'audio/ogg' && bytes.toString('ascii', 0, 4) === 'OggS';
  const isMp4 = mime === 'audio/mp4' && bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  const isWav = mime === 'audio/wav' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  const isMpeg = mime === 'audio/mpeg' && bytes.length >= 3 && (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  const isAac = mime === 'audio/aac' && bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (!(isPng || isJpeg || isWebp || isWebm || isOgg || isMp4 || isWav || isMpeg || isAac)) {
    throw Object.assign(new Error('The attachment contents do not match its file type.'), { statusCode: 400 });
  }
  return { mime, data: match[2] };
}
