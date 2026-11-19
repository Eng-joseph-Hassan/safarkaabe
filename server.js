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
const phonePay = require('./marupay-gateway');

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
  '.mp4': 'video/mp4',
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
  CREATE TABLE IF NOT EXISTS phone_payments (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('WAAFI', 'EDAHAB')),
    account_number TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'FAILED', 'UNKNOWN')),
    transaction_id TEXT,
    reference_id TEXT,
    error_message TEXT,
    started_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
    is_published INTEGER NOT NULL DEFAULT 1 CHECK (is_published IN (0, 1)),
    image_updated_at TEXT
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
    booking_alerts INTEGER NOT NULL DEFAULT 1,
    payment_notifications INTEGER NOT NULL DEFAULT 1,
    travel_news INTEGER NOT NULL DEFAULT 1,
    promotional_notifications INTEGER NOT NULL DEFAULT 0,
    status_updates INTEGER NOT NULL DEFAULT 1,
    lock_screen_previews INTEGER NOT NULL DEFAULT 1,
    quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
    quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
    quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    muted_conversation_ids TEXT NOT NULL DEFAULT '[]',
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
    audience TEXT NOT NULL DEFAULT 'EVERYONE' CHECK (audience IN ('EVERYONE', 'CONTACTS')),
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
    ended_at TEXT,
    caller_seen_at TEXT,
    callee_seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS blocked_parties (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (blocker_id, blocked_key)
  );
  CREATE TABLE IF NOT EXISTS chat_call_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL REFERENCES chat_calls(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    signal_type TEXT NOT NULL CHECK (signal_type IN ('OFFER', 'ANSWER', 'ICE')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_status_views (
    status_id TEXT NOT NULL REFERENCES chat_statuses(id) ON DELETE CASCADE,
    viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TEXT NOT NULL,
    PRIMARY KEY (status_id, viewer_id)
  );
  CREATE TABLE IF NOT EXISTS agency_reviews (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
    customer_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 1000),
    agency_reply TEXT CHECK (agency_reply IS NULL OR length(agency_reply) <= 1000),
    agency_reply_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saved_offers (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offer_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, offer_id)
  );
  CREATE TABLE IF NOT EXISTS trip_waitlist (
    offer_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seat_count INTEGER NOT NULL DEFAULT 1 CHECK (seat_count > 0),
    created_at TEXT NOT NULL,
    notified_at TEXT,
    PRIMARY KEY (offer_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS login_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_salt TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS native_push_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS native_push_tokens_user_idx ON native_push_tokens(user_id);
  CREATE INDEX IF NOT EXISTS trip_waitlist_user_idx ON trip_waitlist(user_id, created_at);
  CREATE INDEX IF NOT EXISTS login_challenges_user_idx ON login_challenges(user_id);
  CREATE INDEX IF NOT EXISTS chat_status_views_status_idx ON chat_status_views(status_id, viewed_at);
  CREATE INDEX IF NOT EXISTS agency_reviews_agency_idx ON agency_reviews(agency_id, created_at);
  CREATE INDEX IF NOT EXISTS saved_offers_user_idx ON saved_offers(user_id, created_at);
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
  let seatsReleased = false;
  let paidAfterCancellation = false;
  await runInTransaction(async () => {
    await db.prepare(`UPDATE waafi_payments SET status = ?, order_id = COALESCE(?, order_id),
      transaction_id = COALESCE(?, transaction_id), updated_at = ? WHERE id = ?`)
      .run(status, params.orderId ? String(params.orderId) : null, transactionId, updatedAt, payment.id);
    if (status === 'DECLINED') {
      seatsReleased = await releasePendingPaymentBooking(payment.bookingId, 'Payment was not completed');
      return;
    }
    if (status !== 'APPROVED' || !payment.customerId) return;

    const bookingPaid = await db.prepare("UPDATE bookings SET state = 'PAYMENT_RECEIVED', updated_at = ? WHERE id = ? AND state = 'PAYMENT_PENDING'")
      .run(updatedAt, payment.bookingId);
    if (bookingPaid.changes !== 1 && payment.status !== 'APPROVED') {
      const current = await db.prepare('SELECT state FROM bookings WHERE id = ?').get(payment.bookingId);
      paidAfterCancellation = current?.state === 'CANCELLED';
    }
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
  if (seatsReleased) publishCatalogChange('availability');
  if (paidAfterCancellation) {
    await db.prepare("UPDATE bookings SET refund_status = 'NEEDED', updated_at = ? WHERE id = ? AND refund_status IS NULL")
      .run(nowIso(), payment.bookingId);
    await audit(null, 'PAYMENT_RECEIVED_FOR_CANCELLED_BOOKING', `${payment.bookingReference} (${payment.referenceId})`);
    try {
      await createNotifications((await agencyStaffIds(payment.agencyId)).map(staffId => ({
        recipientUserId: staffId, agencyId: payment.agencyId, bookingId: payment.bookingId, type: 'PAYMENT_NEEDS_REFUND',
        title: 'Payment received for a cancelled booking',
        body: `WaafiPay confirmed ${(payment.amountCents / 100).toFixed(2)} ${payment.currency} for booking ${payment.bookingReference}, which was already cancelled. Contact the traveler to rebook or refund.`,
        href: `/?booking=${encodeURIComponent(payment.bookingId)}`, dedupeKey: `PAYMENT_NEEDS_REFUND:${payment.referenceId}:${staffId}`
      })));
    } catch (error) {
      console.error('Refund-needed notification could not be created:', error.message);
    }
  }
  if (status !== payment.status && ['APPROVED', 'DECLINED'].includes(status)) {
    try {
      await createPaymentNotifications(payment, status);
    } catch (error) {
      console.error('Payment notification could not be created:', error.message);
    }
  }
  return { ...payment, status, transactionId: transactionId || null, updatedAt };
}

const runInTransaction = callback => db.transaction(callback);

// Takes the booking row's write lock for the rest of the transaction. The phone-payment claim and every path
// that cancels a booking waiting for payment call this first, so on Postgres (READ COMMITTED) they run one
// after the other and each later statement sees what the other committed. SQLite already serializes writes.
async function lockBookingRow(bookingId) {
  await db.prepare('UPDATE bookings SET updated_at = updated_at WHERE id = ?').run(bookingId);
}

// Cancels a booking that is still waiting for online payment and returns its seats.
// Must run inside a transaction. Returns true when seats were released.
async function releasePendingPaymentBooking(bookingId, reason) {
  await lockBookingRow(bookingId);
  const released = await db.prepare(`UPDATE bookings SET state = 'CANCELLED', cancellation_reason = ?, updated_at = ?
    WHERE id = ? AND state = 'PAYMENT_PENDING'
      AND NOT EXISTS (SELECT 1 FROM waafi_payments WHERE booking_id = bookings.id AND status = 'APPROVED')
      AND NOT EXISTS (SELECT 1 FROM phone_payments WHERE booking_id = bookings.id
        AND (status IN ('APPROVED', 'UNKNOWN') OR (status = 'PENDING' AND started_at IS NOT NULL)))
    RETURNING seat_count AS "seatCount", offer_id AS "offerId", agency_id AS "agencyId"`).get(reason, nowIso(), bookingId);
  if (!released) return false;
  if (released.offerId) {
    await db.prepare('UPDATE catalog_products SET available = available + ? WHERE id = ? AND agency_id = ?')
      .run(released.seatCount, released.offerId, released.agencyId);
  }
  return true;
}

async function notifyReleasedPaymentHold(booking, reason) {
  try {
    const items = [];
    if (booking.customerId) items.push({ recipientUserId: booking.customerId, agencyId: booking.agencyId, bookingId: booking.id,
      type: 'BOOKING_CANCELLED', title: 'Booking request cancelled',
      body: `Your booking ${booking.reference} (${booking.offerTitle}) was cancelled because ${reason}. No payment was taken. You can book again.`,
      href: `/?booking=${encodeURIComponent(booking.id)}`, dedupeKey: `BOOKING_CANCELLED:${booking.id}:${booking.customerId}` });
    for (const staffId of await agencyStaffIds(booking.agencyId)) items.push({ recipientUserId: staffId, agencyId: booking.agencyId, bookingId: booking.id,
      type: 'BOOKING_CANCELLED', title: 'Unpaid booking released',
      body: `Booking ${booking.reference} (${booking.offerTitle}) was cancelled because ${reason}. Its seats are available again.`,
      href: `/?booking=${encodeURIComponent(booking.id)}`, dedupeKey: `BOOKING_CANCELLED:${booking.id}:${staffId}` });
    await createNotifications(items);
  } catch (error) {
    console.error('Released-hold notification could not be created:', error.message);
  }
}

// ---------- Pay by phone (marupay): the customer approves on their phone with their PIN ----------
const phonePaymentSelect = `SELECT p.id, p.booking_id AS "bookingId", p.provider, p.account_number AS "accountNumber",
    p.amount_cents AS "amountCents", p.currency, p.status, p.transaction_id AS "transactionId", p.reference_id AS "referenceId",
    p.error_message AS "errorMessage", p.started_at AS "startedAt", p.updated_at AS "updatedAt",
    b.customer_id AS "customerId", b.agency_id AS "agencyId", b.reference AS "bookingReference",
    b.offer_title AS "offerTitle", b.seat_count AS "seatCount", b.travel_date AS "travelDate", b.state AS "bookingState"
  FROM phone_payments p JOIN bookings b ON b.id = p.booking_id`;

const loadPhonePayment = bookingId => db.prepare(`${phonePaymentSelect} WHERE p.booking_id = ?`).get(bookingId);

function publicPhonePayment(payment) {
  if (!payment) return null;
  return {
    bookingId: payment.bookingId, provider: payment.provider, providerLabel: phonePay.providerLabel(payment.provider),
    accountNumber: payment.accountNumber, amountCents: Number(payment.amountCents), currency: payment.currency,
    status: payment.status === 'PENDING' && payment.startedAt ? 'PROCESSING' : payment.status,
    transactionId: payment.transactionId || null, message: payment.errorMessage || null,
    bookingState: payment.bookingState
  };
}

async function notifyPhonePayment(payment, outcome, reason) {
  const amount = `${(Number(payment.amountCents) / 100).toFixed(2)} ${payment.currency}`;
  const href = `/?booking=${encodeURIComponent(payment.bookingId)}`;
  const base = { agencyId: payment.agencyId, bookingId: payment.bookingId, href };
  const wallet = phonePay.providerLabel(payment.provider);
  const portal = phonePay.providerPortal(payment.provider);
  const trip = `booking ${payment.bookingReference} (${payment.offerTitle})`;
  const items = [];
  const key = `PHONE_PAYMENT:${payment.id}:${outcome}`;
  if (payment.customerId) {
    const traveler = {
      APPROVED: ['PAYMENT_CONFIRMED', 'Payment confirmed', `Your payment of ${amount} for ${trip} was received. The agency will finalize your trip.`],
      FAILED: ['PAYMENT_FAILED', 'Payment not completed', `Your payment for ${trip} did not go through: ${reason} The booking was cancelled and no money was taken. You can book again.`],
      UNKNOWN: ['PAYMENT_CHECK_NEEDED', 'Payment is being checked', `We could not confirm your payment of ${amount} for ${trip} yet. Please do not pay again. The agency will check and let you know.`],
      PAID_AFTER_CANCELLATION: ['PAYMENT_NEEDS_REFUND', 'Payment received for a cancelled booking', `Your payment of ${amount} for ${trip} arrived after the booking was cancelled. The agency will refund you or help you rebook.`],
      AGENCY_REJECTED: ['PAYMENT_FAILED', 'Payment not found', `The agency could not find your payment for ${trip}, so the booking was cancelled. If money was taken from your wallet, message the agency with the transaction details.`]
    }[outcome];
    if (traveler) items.push({ ...base, recipientUserId: payment.customerId, type: traveler[0], title: traveler[1], body: traveler[2], dedupeKey: `${key}:${payment.customerId}` });
  }
  const agency = {
    APPROVED: ['PAYMENT_RECEIVED', 'Payment received', `${trip} was paid: ${amount} by phone (${wallet}, ${payment.accountNumber}). Review and accept the booking.`],
    FAILED: ['PAYMENT_FAILED', 'Customer payment not completed', `The phone payment for ${trip} did not go through: ${reason} The booking was cancelled and its seats are free again.`],
    UNKNOWN: ['PAYMENT_CHECK_NEEDED', 'Check a phone payment', `We could not confirm the phone payment of ${amount} for ${trip} from ${payment.accountNumber}. Check your ${portal} merchant portal, then tap "Payment received" or "Payment not received" on the booking.`],
    AGENCY_REJECTED: ['PAYMENT_FAILED', 'Phone payment marked not received', `You marked the phone payment for ${trip} as not received. The booking was cancelled and its seats are free again. If the traveler later shows the money was taken, record a refund.`],
    PAID_AFTER_CANCELLATION: ['PAYMENT_NEEDS_REFUND', 'Payment received for a cancelled booking', `${wallet} confirmed ${amount} from ${payment.accountNumber} for ${trip}, which was already cancelled. Contact the traveler to rebook or refund.`]
  }[outcome];
  if (agency) {
    for (const staffId of await agencyStaffIds(payment.agencyId)) {
      items.push({ ...base, recipientUserId: staffId, type: agency[0], title: agency[1], body: agency[2], dedupeKey: `${key}:${staffId}` });
    }
  }
  try {
    await createNotifications(items);
  } catch (error) {
    console.error('Phone payment notification could not be created:', error.message);
  }
}

// Applies the provider's answer to a claimed phone payment. Returns the updated payment.
async function settlePhonePayment(payment, result) {
  const updatedAt = nowIso();
  if (result.outcome === 'APPROVED') {
    let paidAfterCancellation = false;
    await runInTransaction(async () => {
      await lockBookingRow(payment.bookingId);
      await db.prepare(`UPDATE phone_payments SET status = 'APPROVED', transaction_id = ?, reference_id = ?, error_message = NULL, updated_at = ?
        WHERE id = ? AND status IN ('PENDING', 'UNKNOWN')`).run(result.transactionId, result.referenceId, updatedAt, payment.id);
      const paid = await db.prepare("UPDATE bookings SET state = 'PAYMENT_RECEIVED', updated_at = ? WHERE id = ? AND state = 'PAYMENT_PENDING'")
        .run(updatedAt, payment.bookingId);
      if (paid.changes !== 1) {
        paidAfterCancellation = true;
        await db.prepare("UPDATE bookings SET refund_status = 'NEEDED', updated_at = ? WHERE id = ? AND refund_status IS NULL").run(updatedAt, payment.bookingId);
      }
    });
    await audit(null, 'PHONE_PAYMENT_APPROVED', `${payment.bookingReference} ${payment.provider} ${result.transactionId || ''} (${payment.amountCents} cents)`);
    if (paidAfterCancellation) await audit(null, 'PAYMENT_RECEIVED_FOR_CANCELLED_BOOKING', `${payment.bookingReference} (phone ${payment.id})`);
    await notifyPhonePayment(payment, paidAfterCancellation ? 'PAID_AFTER_CANCELLATION' : 'APPROVED');
  } else if (result.outcome === 'FAILED') {
    let released = false;
    await runInTransaction(async () => {
      await lockBookingRow(payment.bookingId);
      await db.prepare(`UPDATE phone_payments SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ? AND status IN ('PENDING', 'UNKNOWN')`)
        .run(result.reason, updatedAt, payment.id);
      released = await releasePendingPaymentBooking(payment.bookingId, `Phone payment not completed: ${result.reason}`);
    });
    await audit(null, 'PHONE_PAYMENT_FAILED', `${payment.bookingReference} ${payment.provider}: ${result.errorCode || ''} ${result.reason}`);
    if (released) publishCatalogChange('availability');
    await notifyPhonePayment(payment, 'FAILED', result.reason);
  } else {
    const message = `${result.reason} Check the ${phonePay.providerPortal(payment.provider)} merchant portal before doing anything else.`;
    await db.prepare(`UPDATE phone_payments SET status = 'UNKNOWN', error_message = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`)
      .run(message, updatedAt, payment.id);
    await audit(null, 'PHONE_PAYMENT_UNKNOWN', `${payment.bookingReference} ${payment.provider}: ${result.errorCode || ''}`);
    await notifyPhonePayment(payment, 'UNKNOWN');
  }
  return loadPhonePayment(payment.bookingId);
}

// A charge that started but never finished (for example the server was stopped mid-call) is treated as UNKNOWN,
// so the agency checks it instead of the seats being held or released blindly.
async function markStuckPhonePaymentsUnknown() {
  const cutoff = new Date(Date.now() - phonePay.phonePaymentTimeoutMs() - 60_000).toISOString();
  const stuck = await db.prepare(`${phonePaymentSelect} WHERE p.status = 'PENDING' AND p.started_at IS NOT NULL AND p.started_at < ?`).all(cutoff);
  for (const payment of stuck) {
    const changed = await db.prepare(`UPDATE phone_payments SET status = 'UNKNOWN', error_message = ?, updated_at = ?
      WHERE id = ? AND status = 'PENDING' AND started_at IS NOT NULL`)
      .run(`The payment check did not finish. Check the ${phonePay.providerPortal(payment.provider)} merchant portal before doing anything else.`, nowIso(), payment.id);
    if (changed.changes !== 1) continue;
    await audit(null, 'PHONE_PAYMENT_UNKNOWN', `${payment.bookingReference} ${payment.provider}: stopped before an answer`);
    await notifyPhonePayment(payment, 'UNKNOWN');
  }
}

async function notifyRefundSent(booking, amountCents, currency, refundReference, refundNote) {
  if (!booking.customerId) return;
  const amount = Number.isFinite(Number(amountCents)) ? `${(Number(amountCents) / 100).toFixed(2)} ${currency || 'USD'}` : 'your payment';
  try {
    await createNotifications([{
      recipientUserId: booking.customerId, agencyId: booking.agencyId, bookingId: booking.id, type: 'PAYMENT_REFUNDED',
      title: 'Your refund was sent',
      body: `The agency sent back ${amount} for booking ${booking.ref} (${booking.offerTitle}). Refund reference: ${refundReference}.${refundNote ? ` Note: ${refundNote}` : ''}`,
      href: `/?booking=${encodeURIComponent(booking.id)}`, dedupeKey: `PAYMENT_REFUNDED:${booking.id}`
    }]);
  } catch (error) {
    console.error('Refund notification could not be created:', error.message);
  }
}

// ---------- Waitlist: notify travelers when seats open on a sold-out trip ----------
let waitlistCheckInFlight = null;
let lastWaitlistCheck = 0;
function scheduleWaitlistCheck() {
  if (!waitlistCheckInFlight) {
    lastWaitlistCheck = Date.now();
    waitlistCheckInFlight = notifyWaitlistedTravelers()
      .catch(error => console.error('Waitlist notifications could not be sent:', error.message))
      .finally(() => { waitlistCheckInFlight = null; });
  }
  return waitlistCheckInFlight;
}

async function notifyWaitlistedTravelers() {
  const today = new Date().toISOString().slice(0, 10);
  const ready = await db.prepare(`
    SELECT w.offer_id AS "offerId", w.user_id AS "userId", w.seat_count AS "seatCount", w.created_at AS "joinedAt",
           p.title, p.available, p.agency_id AS "agencyId", p.travel_date AS "travelDate"
    FROM trip_waitlist w
    JOIN catalog_products p ON p.id = w.offer_id
    JOIN agencies a ON a.id = p.agency_id
    WHERE w.notified_at IS NULL AND p.is_published = 1 AND p.available >= w.seat_count
      AND a.status = 'ACTIVE' AND a.is_approved = 1
      AND (p.travel_date IS NULL OR p.travel_date >= ?)
    ORDER BY w.created_at
    LIMIT 200`).all(today);
  for (const entry of ready) {
    const marked = await db.prepare('UPDATE trip_waitlist SET notified_at = ? WHERE offer_id = ? AND user_id = ? AND notified_at IS NULL')
      .run(nowIso(), entry.offerId, entry.userId);
    if (marked.changes !== 1) continue;
    const seats = Number(entry.available);
    await createNotifications([{
      recipientUserId: entry.userId, agencyId: entry.agencyId, type: 'WAITLIST_SEATS_OPEN',
      title: 'Seats are available again',
      body: `${entry.title}${entry.travelDate ? ` (${entry.travelDate})` : ''} has ${seats} ${seats === 1 ? 'seat' : 'seats'} free now. Book soon – seats go to whoever books first.`,
      href: `/?trip=${encodeURIComponent(entry.offerId)}`,
      dedupeKey: `WAITLIST_SEATS_OPEN:${entry.offerId}:${entry.userId}:${entry.joinedAt}`
    }]);
  }
  return ready.length;
}

// ---------- Trip reminders: the day before and the morning of departure ----------
let lastTripReminderSweep = 0;
const tripReminderIntervalMs = process.env.NODE_ENV === 'test' ? 0 : 10 * 60 * 1000;
async function sendTripReminders({ force = false } = {}) {
  if (!force && Date.now() - lastTripReminderSweep < tripReminderIntervalMs) return 0;
  lastTripReminderSweep = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const trips = await db.prepare(`
    SELECT b.id, b.reference, b.customer_id AS "customerId", b.agency_id AS "agencyId", b.offer_title AS "offerTitle",
           b.travel_date AS "travelDate", b.seat_count AS "seatCount", a.name AS "agencyName"
    FROM bookings b JOIN agencies a ON a.id = b.agency_id
    WHERE b.state = 'ACCEPTED' AND b.customer_id IS NOT NULL AND b.travel_date IN (?, ?)`).all(today, tomorrow);
  let sent = 0;
  for (const trip of trips) {
    const when = trip.travelDate === today ? 'today' : 'tomorrow';
    const created = await createNotifications([{
      recipientUserId: trip.customerId, agencyId: trip.agencyId, bookingId: trip.id, type: 'TRIP_REMINDER',
      title: when === 'today' ? 'Your trip is today' : 'Your trip is tomorrow',
      body: `${trip.offerTitle} with ${trip.agencyName} is ${when} (${trip.travelDate}). Booking ${trip.reference}, ${trip.seatCount} ${Number(trip.seatCount) === 1 ? 'seat' : 'seats'}. Bring your ID or passport and your booking confirmation.`,
      href: `/?booking=${encodeURIComponent(trip.id)}`,
      dedupeKey: `TRIP_REMINDER:${trip.id}:${trip.travelDate}:${when}`
    }]);
    sent += created.length;
  }
  return sent;
}

async function runBackgroundSweeps() {
  const tasks = [
    ['unpaid checkout holds', () => releaseStalePaymentHolds()],
    ['trip reminders', () => sendTripReminders()],
    ['waitlist', () => waitlistCheckInFlight || (Date.now() - lastWaitlistCheck > 30_000 ? scheduleWaitlistCheck() : null)]
  ];
  for (const [name, task] of tasks) {
    try {
      await task();
    } catch (error) {
      console.error(`Background task (${name}) failed:`, error);
    }
  }
}

const pendingPaymentHoldMs = 2 * 60 * 60 * 1000;
// How long after a phone charge starts before the agency may mark it "not received" (longer than any PIN prompt).
const phoneRejectWaitMs = 15 * 60 * 1000;
let lastPendingPaymentSweep = 0;
const pendingPaymentSweepIntervalMs = process.env.NODE_ENV === 'test' ? 0 : 60_000;
// Abandoned checkouts (the traveler never finishes paying) would otherwise hold seats forever.
// Release holds older than two hours; runs at most once a minute.
async function releaseStalePaymentHolds() {
  if (Date.now() - lastPendingPaymentSweep < pendingPaymentSweepIntervalMs) return;
  lastPendingPaymentSweep = Date.now();
  await markStuckPhonePaymentsUnknown();
  const cutoff = new Date(Date.now() - pendingPaymentHoldMs).toISOString();
  const stale = await db.prepare(`SELECT bookings.id, bookings.reference, bookings.customer_id AS "customerId",
      bookings.agency_id AS "agencyId", bookings.offer_title AS "offerTitle", waafi_payments.reference_id AS "paymentReference"
    FROM bookings LEFT JOIN waafi_payments ON waafi_payments.booking_id = bookings.id
    WHERE bookings.state = 'PAYMENT_PENDING' AND bookings.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM waafi_payments approved WHERE approved.booking_id = bookings.id AND approved.status = 'APPROVED')
      AND NOT EXISTS (SELECT 1 FROM phone_payments phone WHERE phone.booking_id = bookings.id
        AND (phone.status IN ('APPROVED', 'UNKNOWN') OR (phone.status = 'PENDING' AND phone.started_at IS NOT NULL)))`).all(cutoff);
  let released = 0;
  for (const booking of stale) {
    if (booking.paymentReference) {
      try {
        // Ask WaafiPay first: the traveler may have paid without returning to the app.
        const checked = await refreshWaafiPayment(booking.paymentReference);
        if (!checked || checked.status === 'APPROVED') continue;
        if (checked.status === 'DECLINED') continue; // refreshWaafiPayment already released the seats
      } catch (error) {
        console.warn(`Skipped releasing unpaid checkout ${booking.reference}: WaafiPay could not confirm its status.`, error.message);
        continue;
      }
    }
    if (await runInTransaction(() => releasePendingPaymentBooking(booking.id, 'Payment was not completed within 2 hours'))) {
      released += 1;
      await notifyReleasedPaymentHold(booking, 'the payment was not completed within 2 hours');
    }
  }
  if (released) {
    await audit(null, 'PAYMENT_HOLDS_RELEASED', `${released} unpaid checkout(s)`);
    publishCatalogChange('availability');
  }
}

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
      ['is_published', 'INTEGER NOT NULL DEFAULT 1 CHECK (is_published IN (0, 1))'],
      ['image_updated_at', 'TEXT']
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
    const statusColumns = new Set((await db.prepare('PRAGMA table_info(chat_statuses)').all()).map(column => column.name));
    if (!statusColumns.has('audience')) {
      await db.exec("ALTER TABLE chat_statuses ADD COLUMN audience TEXT NOT NULL DEFAULT 'EVERYONE' CHECK (audience IN ('EVERYONE', 'CONTACTS'))");
    }
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
      ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS image_updated_at TEXT;
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
      ALTER TABLE chat_statuses ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'EVERYONE';
    `);
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS booking_documents_reference_idx ON booking_documents(document_reference) WHERE document_reference IS NOT NULL');
  }

  const callColumns = [['caller_seen_at', 'TEXT'], ['callee_seen_at', 'TEXT'], ['caller_device', 'TEXT'], ['callee_device', 'TEXT'],
    ['ring_push_at', 'TEXT'], ['push_token', 'TEXT']];
  if (db.isPostgres) {
    for (const [column, definition] of callColumns) {
      await db.exec(`ALTER TABLE chat_calls ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    }
  } else {
    const existingCallColumns = new Set((await db.prepare('PRAGMA table_info(chat_calls)').all()).map(column => column.name));
    for (const [column, definition] of callColumns) {
      if (!existingCallColumns.has(column)) await db.exec(`ALTER TABLE chat_calls ADD COLUMN ${column} ${definition}`);
    }
  }

  // Columns added for refunds and sign-in codes.
  const addMissingColumns = async (table, columns) => {
    if (db.isPostgres) {
      for (const [column, definition] of columns) await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
      return;
    }
    const existing = new Set((await db.prepare(`PRAGMA table_info(${table})`).all()).map(column => column.name));
    for (const [column, definition] of columns) {
      if (!existing.has(column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  await addMissingColumns('bookings', [['refund_status', 'TEXT'], ['refund_reference', 'TEXT'], ['refund_note', 'TEXT'], ['refunded_at', 'TEXT']]);
  await addMissingColumns('users', [['login_code_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['theme_preference', 'TEXT']]);

  const preferenceColumns = [
    ['booking_alerts', 'INTEGER NOT NULL DEFAULT 1'],
    ['payment_notifications', 'INTEGER NOT NULL DEFAULT 1'],
    ['travel_news', 'INTEGER NOT NULL DEFAULT 1'],
    ['promotional_notifications', 'INTEGER NOT NULL DEFAULT 0'],
    ['status_updates', 'INTEGER NOT NULL DEFAULT 1'],
    ['lock_screen_previews', 'INTEGER NOT NULL DEFAULT 1'],
    ['quiet_hours_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['quiet_hours_start', "TEXT NOT NULL DEFAULT '22:00'"],
    ['quiet_hours_end', "TEXT NOT NULL DEFAULT '08:00'"],
    ['timezone', "TEXT NOT NULL DEFAULT 'UTC'"],
    ['muted_conversation_ids', "TEXT NOT NULL DEFAULT '[]'"]
  ];
  if (db.isPostgres) {
    for (const [column, definition] of preferenceColumns) {
      await db.exec(`ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    }
  } else {
    const existingPreferenceColumns = new Set((await db.prepare('PRAGMA table_info(notification_preferences)').all()).map(column => column.name));
    for (const [column, definition] of preferenceColumns) {
      if (!existingPreferenceColumns.has(column)) {
        await db.exec(`ALTER TABLE notification_preferences ADD COLUMN ${column} ${definition}`);
      }
    }
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

// Plugins (plugins/*/index.js), e.g. the ANFAC MEDIA Shop. They add their own tables, API routes and page scripts.
const plugins = require('./plugins/loader');
const dbReady = initializeDatabase().then(() => plugins.initPlugins({
  db, runInTransaction, nowIso, sendJson, readJson, requireRole, authorizeMutation, requireString, normalizeEmail,
  validatePassword, hashPassword, createNotifications, audit, validateImageData, maxImageBytes: maxCatalogImageBytes
}));

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
  lastSeenAt: user.last_seen_at || null,
  loginCodeEnabled: Number(user.login_code_enabled || 0) === 1,
  themePreference: ['light', 'dark', 'system'].includes(user.theme_preference) ? user.theme_preference : null
});

const agencyRatingColumns = agencyIdExpression => `
  (SELECT AVG(reviews.rating) FROM agency_reviews reviews WHERE reviews.agency_id = ${agencyIdExpression}) AS agencyRating,
  (SELECT COUNT(*) FROM agency_reviews reviews WHERE reviews.agency_id = ${agencyIdExpression}) AS agencyReviewCount`;

function normalizeAgencyRating(record) {
  const reviewCount = Number(record.agencyReviewCount || 0);
  return {
    ...record,
    agencyReviewCount: reviewCount,
    agencyRating: reviewCount && record.agencyRating !== null ? Math.round(Number(record.agencyRating) * 10) / 10 : null
  };
}

function reviewerDisplayName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Verified traveler';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

const chatStatusAudiences = ['EVERYONE', 'CONTACTS'];

function chatStatusOwnerKey(owner) {
  if (owner.userRole === 'SUPER_ADMIN') return 'ADMIN';
  if (owner.userRole === 'AGENCY') return `AGENCY:${owner.userAgencyId}`;
  return `USER:${owner.userId}`;
}

// People a user has a conversation with (plus colleagues at the same agency) count as contacts for status audiences.
async function statusContactKeys(user) {
  const keys = new Set();
  if (user.role === 'CLIENT') {
    const rows = await db.prepare('SELECT DISTINCT agency_id AS agencyId FROM conversations WHERE customer_id = ?').all(user.id);
    for (const row of rows) keys.add(row.agencyId ? `AGENCY:${row.agencyId}` : 'ADMIN');
  } else if (user.role === 'AGENCY') {
    keys.add(`AGENCY:${user.agency_id}`);
    const rows = await db.prepare('SELECT DISTINCT customer_id AS customerId FROM conversations WHERE agency_id = ?').all(user.agency_id);
    for (const row of rows) keys.add(row.customerId ? `USER:${row.customerId}` : 'ADMIN');
  } else if (user.role === 'SUPER_ADMIN') {
    keys.add('ADMIN');
    const rows = await db.prepare(`SELECT DISTINCT agency_id AS agencyId, customer_id AS customerId FROM conversations
      WHERE agency_id IS NULL OR customer_id IS NULL`).all();
    for (const row of rows) keys.add(row.customerId ? `USER:${row.customerId}` : `AGENCY:${row.agencyId}`);
  }
  return keys;
}

function canViewChatStatus(user, status, contactKeys, blocks = null) {
  if (status.userId === user.id) return true;
  if (blocks && (blocks.blockedKeys.has(chatStatusOwnerKey(status)) || blocks.blockerIds.has(status.userId) ||
    blocks.blockerKeys?.has(chatStatusOwnerKey(status)))) return false;
  if ((status.audience || 'EVERYONE') === 'EVERYONE') return true;
  return contactKeys.has(chatStatusOwnerKey(status));
}

async function getVisibleChatStatus(statusId, user) {
  const status = await db.prepare(`SELECT statuses.id, statuses.user_id AS userId, statuses.audience,
      users.role AS userRole, users.agency_id AS userAgencyId
    FROM chat_statuses statuses JOIN users ON users.id = statuses.user_id
    WHERE statuses.id = ? AND statuses.expires_at > ?`).get(statusId, nowIso());
  if (!status) return null;
  if (status.userId === user.id) return status;
  const blocks = await blockStateForUser(user);
  const contactKeys = (status.audience || 'EVERYONE') === 'EVERYONE' ? new Set() : await statusContactKeys(user);
  return canViewChatStatus(user, status, contactKeys, blocks) ? status : null;
}

// ---------- blocking ----------
// A block is stored against a "party": one traveler (USER:id), one agency (AGENCY:id, covering all its
// staff) or SAFAR KAABE support (ADMIN). Blocking stops messages, calls and status visibility both ways.
// When a connected call is closed by the abandoned-call cleanup, it ended when the first side stopped checking in.
const callLastSeenSql = `CASE WHEN COALESCE(caller_seen_at, accepted_at, created_at) < COALESCE(callee_seen_at, accepted_at, created_at)
  THEN COALESCE(caller_seen_at, accepted_at, created_at) ELSE COALESCE(callee_seen_at, accepted_at, created_at) END`;

function partyKeyForUser(user) {
  const role = user.role || user.userRole;
  if (role === 'SUPER_ADMIN') return 'ADMIN';
  if (role === 'AGENCY') return `AGENCY:${user.agency_id || user.agencyId || user.userAgencyId}`;
  return `USER:${user.id || user.userId}`;
}

function conversationPeerKey(conversation, user) {
  if (user.role === 'CLIENT') return conversation.agency_id ? `AGENCY:${conversation.agency_id}` : 'ADMIN';
  if (user.role === 'AGENCY') return conversation.customer_id ? `USER:${conversation.customer_id}` : 'ADMIN';
  return conversation.customer_id ? `USER:${conversation.customer_id}` : `AGENCY:${conversation.agency_id}`;
}

async function partyMemberIds(key) {
  if (key === 'ADMIN') return (await db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN'").all()).map(row => row.id);
  if (key.startsWith('AGENCY:')) return (await db.prepare("SELECT id FROM users WHERE role = 'AGENCY' AND agency_id = ?").all(key.slice(7))).map(row => row.id);
  if (key.startsWith('USER:')) return [key.slice(5)];
  return [];
}

// Everyone who shares this user's party: a block by one agency staff member applies to the whole agency.
async function myPartyIds(user) {
  const ids = await partyMemberIds(partyKeyForUser(user));
  return ids.length ? ids : [user.id];
}

async function blockStateForUser(user) {
  const party = await myPartyIds(user);
  const placeholders = party.map(() => '?').join(', ');
  const blockedKeys = new Set((await db.prepare(`SELECT blocked_key AS "blockedKey" FROM blocked_parties WHERE blocker_id IN (${placeholders})`)
    .all(...party)).map(row => row.blockedKey));
  const blockers = await db.prepare(`SELECT users.id, users.role, users.agency_id FROM blocked_parties
    JOIN users ON users.id = blocked_parties.blocker_id WHERE blocked_parties.blocked_key = ?`).all(partyKeyForUser(user));
  return { blockedKeys, blockerIds: new Set(blockers.map(row => row.id)), blockerKeys: new Set(blockers.map(row => partyKeyForUser(row))) };
}

// Returns 'BLOCKED_BY_ME', 'BLOCKED_BY_THEM' or null for messages/calls from user to the party peerKey.
async function blockBetween(user, peerKey) {
  const party = await myPartyIds(user);
  if (await db.prepare(`SELECT 1 AS present FROM blocked_parties WHERE blocked_key = ? AND blocker_id IN (${party.map(() => '?').join(', ')}) LIMIT 1`)
    .get(peerKey, ...party)) return 'BLOCKED_BY_ME';
  const members = await partyMemberIds(peerKey);
  if (!members.length) return null;
  const placeholders = members.map(() => '?').join(', ');
  const blocked = await db.prepare(`SELECT 1 AS present FROM blocked_parties WHERE blocked_key = ? AND blocker_id IN (${placeholders}) LIMIT 1`)
    .get(partyKeyForUser(user), ...members);
  return blocked ? 'BLOCKED_BY_THEM' : null;
}

async function isBlockedBetween(userId, otherUserId) {
  const user = await db.prepare('SELECT id, role, agency_id FROM users WHERE id = ?').get(userId);
  const other = await db.prepare('SELECT id, role, agency_id FROM users WHERE id = ?').get(otherUserId);
  if (!user || !other) return false;
  return Boolean(await blockBetween(user, partyKeyForUser(other)));
}

function canReviewBooking(booking, today = new Date().toISOString().slice(0, 10)) {
  return booking.state === 'ACCEPTED' && (!booking.travelDate || booking.travelDate <= today);
}

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function sendChatAttachment(response, attachment, request = null) {
  const bytes = Buffer.from(attachment.attachment_data, 'base64');
  const headers = {
    'Content-Type': attachment.attachment_mime,
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
  // Media players (notably iOS Safari and Android WebView) request audio in byte ranges
  // and refuse to play or seek when the server ignores the Range header.
  const range = request?.headers?.range;
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] || match[2])) {
    let start;
    let end;
    if (!match[1]) {
      start = Math.max(bytes.length - Number(match[2]), 0);
      end = bytes.length - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= bytes.length || end < start) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}` });
      response.end();
      return;
    }
    const chunk = bytes.subarray(start, end + 1);
    response.writeHead(206, { ...headers, 'Content-Length': chunk.length, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` });
    response.end(chunk);
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': bytes.length });
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
  // Seats may have opened up: tell travelers on the waitlist.
  if (change === 'availability' || change === 'updated') scheduleWaitlistCheck();
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
    sendJson(response, 403, { error: 'You were signed out for your safety. Sign in again to continue.' });
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
  const type = record.type;
  const category = type === 'MESSAGE' || type.startsWith('CALL') ? 'MESSAGES'
    : type.startsWith('PAYMENT') ? 'PAYMENTS'
      : type.startsWith('STATUS') ? 'STATUS'
        : type.startsWith('TRAVEL_NEWS') ? 'TRAVEL_NEWS'
          : type.startsWith('PROMOTION') ? 'PROMOTIONS' : 'BOOKINGS';
  return {
    id: record.id,
    recipientUserId: record.recipient_user_id || record.recipientUserId,
    agencyId: record.agency_id || record.agencyId || null,
    bookingId: record.booking_id || record.bookingId || null,
    conversationId: record.conversation_id || record.conversationId || null,
    type,
    category,
    title: record.title,
    body: record.body,
    href: record.href || null,
    createdAt: record.created_at || record.createdAt,
    readAt: record.read_at || record.readAt || null
  };
}

function notificationPreferenceEnabled(preferences, type) {
  if (!preferences) return true;
  if (type === 'MESSAGE' || type.startsWith('CALL')) return true;
  if (type.startsWith('PAYMENT')) return Number(preferences.payment_notifications) !== 0;
  if (type.startsWith('STATUS')) return Number(preferences.status_updates) !== 0;
  if (type.startsWith('TRAVEL_NEWS')) return Number(preferences.travel_news) !== 0;
  if (type.startsWith('PROMOTION')) return Number(preferences.promotional_notifications) !== 0;
  return Number(preferences.booking_alerts) !== 0;
}

function isWithinQuietHours(preferences, timestamp = new Date()) {
  if (!preferences || Number(preferences.quiet_hours_enabled) !== 1) return false;
  const start = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(preferences.quiet_hours_start || '');
  const end = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(preferences.quiet_hours_end || '');
  if (!start || !end || !preferences.timezone) return false;
  const timeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: preferences.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(timestamp);
  const currentMinutes = Number(timeParts.find(part => part.type === 'hour').value) * 60 +
    Number(timeParts.find(part => part.type === 'minute').value);
  const startMinutes = Number(start[1]) * 60 + Number(start[2]);
  const endMinutes = Number(end[1]) * 60 + Number(end[2]);
  if (startMinutes === endMinutes) return true;
  return startMinutes < endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes;
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

async function pushAllowed(userId, notification) {
  const preferences = await db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId);
  if (preferences && Number(preferences.desktop_push_enabled) === 0) return null;
  if (!notificationPreferenceEnabled(preferences, notification.type) || isWithinQuietHours(preferences)) return null;
  if (notification.conversationId && preferences) {
    const mutedIds = JSON.parse(preferences.muted_conversation_ids || '[]');
    if (Array.isArray(mutedIds) && mutedIds.includes(notification.conversationId)) return null;
  }
  return { preferences };
}

function pushText(preferences, notification) {
  const hidden = preferences && Number(preferences.lock_screen_previews) === 0;
  return {
    title: hidden ? 'SAFAR KAABE update' : notification.title,
    body: hidden ? 'You have a new notification.' : notification.body
  };
}

// extra.tag groups notifications (one per call); extra.data carries call details for the Answer/Decline buttons.
async function deliverWebPush(userId, notification, extra = {}, { skipChecks = false } = {}) {
  if (!webPushConfigured) return;
  const allowed = skipChecks ? { preferences: null } : await pushAllowed(userId, notification);
  if (!allowed) return;
  const subscriptions = await db.prepare('SELECT endpoint, subscription_json FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const subscription of subscriptions) {
    try {
      await webPush.sendNotification(JSON.parse(subscription.subscription_json), JSON.stringify({
        ...pushText(allowed.preferences, notification),
        url: notification.href || '/',
        notificationId: notification.id || null,
        type: notification.type,
        tag: extra.tag || null,
        data: extra.data || null
      }), { urgency: notification.type === 'CALL_INCOMING' ? 'high' : 'normal', TTL: notification.type === 'CALL_INCOMING' ? 60 : 86_400 });
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subscription.endpoint);
      } else {
        console.warn('Web push delivery failed:', error.message);
      }
    }
  }
}

// ---------- Native Android push (Firebase Cloud Messaging) ----------
// Set FIREBASE_SERVICE_ACCOUNT to the service-account JSON (plain or base64) from the Firebase console.
const fcmServiceAccount = (() => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(text);
    return parsed.client_email && parsed.private_key && parsed.project_id ? parsed : null;
  } catch {
    console.error('FIREBASE_SERVICE_ACCOUNT is not valid service-account JSON. Android call alerts are off.');
    return null;
  }
})();
let fcmAccess = null;

async function fcmAccessToken() {
  if (fcmAccess && fcmAccess.expiresAt > Date.now() + 60_000) return fcmAccess.token;
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: fcmServiceAccount.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(fcmServiceAccount.private_key, 'base64url');
  const response = await fetch(process.env.FCM_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(`Firebase sign-in failed (${response.status})`);
  fcmAccess = { token: payload.access_token, expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000 };
  return fcmAccess.token;
}

async function sendNativePushData(userId, data, { ttlSeconds = 86_400 } = {}) {
  if (!fcmServiceAccount) return;
  const tokens = await db.prepare('SELECT token FROM native_push_tokens WHERE user_id = ?').all(userId);
  if (!tokens.length) return;
  const accessToken = await fcmAccessToken();
  const stringData = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]));
  for (const { token } of tokens) {
    const response = await fetch(`${process.env.FCM_API_BASE || 'https://fcm.googleapis.com'}/v1/projects/${encodeURIComponent(fcmServiceAccount.project_id)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, data: stringData, android: { priority: 'HIGH', ttl: `${ttlSeconds}s` } } }),
      signal: AbortSignal.timeout(8000)
    }).catch(error => ({ ok: false, status: 0, error }));
    if (response.ok) continue;
    const detail = response.json ? await response.json().catch(() => ({})) : {};
    const errorCode = JSON.stringify(detail).match(/UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND/)?.[0];
    if (response.status === 404 || errorCode === 'UNREGISTERED' || errorCode === 'NOT_FOUND') {
      await db.prepare('DELETE FROM native_push_tokens WHERE token = ?').run(token);
    } else {
      console.warn(`Android push failed (${response.status || response.error?.message}).`);
    }
  }
}

async function deliverNativePush(userId, notification, extra = {}) {
  if (!fcmServiceAccount) return;
  const allowed = await pushAllowed(userId, notification);
  if (!allowed) return;
  await sendNativePushData(userId, {
    type: notification.type, ...pushText(allowed.preferences, notification), url: notification.href || '/',
    notificationId: notification.id, tag: extra.tag, ...(extra.data || {})
  }, { ttlSeconds: notification.type === 'CALL_INCOMING' ? 60 : 86_400 });
}

// Stops the ringing on every device of the person being called (answered elsewhere, declined, cancelled or missed).
async function pushCallEnded(call, reason) {
  const title = reason === 'MISSED' ? 'Missed call' : reason === 'ANSWERED' ? 'Call answered' : 'Call ended';
  const notification = { id: null, type: 'CALL_ENDED', title, body: reason === 'ANSWERED' ? 'You answered this call on another device.' : 'The call is no longer ringing.', href: `/?conversation=${encodeURIComponent(call.conversation_id)}` };
  const extra = { tag: `call-${call.id}`, data: { callId: call.id, reason } };
  await Promise.allSettled([
    deliverWebPush(call.callee_id, notification, extra, { skipChecks: true }),
    sendNativePushData(call.callee_id, { type: 'CALL_ENDED', callId: call.id, reason }, { ttlSeconds: 120 })
  ]).then(results => results.filter(result => result.status === 'rejected')
    .forEach(result => console.warn('Call-ended push failed:', result.reason?.message)));
}

async function createConversationMessageNotifications(conversation, sender, message) {
  const recipientIds = new Set();
  const addParty = async key => { for (const id of await partyMemberIds(key)) recipientIds.add(id); };
  if (sender.role === 'CLIENT') {
    await addParty(conversation.agency_id ? `AGENCY:${conversation.agency_id}` : 'ADMIN');
  } else if (sender.role === 'AGENCY') {
    await addParty(conversation.customer_id ? `USER:${conversation.customer_id}` : 'ADMIN');
  } else {
    if (conversation.customer_id) await addParty(`USER:${conversation.customer_id}`);
    if (conversation.agency_id) await addParty(`AGENCY:${conversation.agency_id}`);
  }
  recipientIds.delete(sender.id);
  const recipients = [...recipientIds].map(id => ({ id }));
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
  const deliveries = [];
  for (const notification of created) {
    publishNotification(notification.recipientUserId, notification);
    deliveries.push(deliverWebPush(notification.recipientUserId, notification).catch(error => console.warn('Web push message notification failed:', error.message)));
    deliveries.push(deliverNativePush(notification.recipientUserId, notification).catch(error => console.warn('Android message notification failed:', error.message)));
  }
  // Wait so the alerts are sent before a serverless request finishes.
  await Promise.allSettled(deliveries);
}

async function createNotifications(items) {
  const created = [];
  for (const item of items) {
    const notification = {
      id: crypto.randomUUID(), recipientUserId: item.recipientUserId, agencyId: item.agencyId || null,
      bookingId: item.bookingId || null, conversationId: item.conversationId || null, type: item.type,
      title: String(item.title).slice(0, 160), body: String(item.body).slice(0, 500), href: item.href || null,
      createdAt: item.createdAt || nowIso(), readAt: null, dedupeKey: item.dedupeKey, push: item.push || null
    };
    const inserted = await db.prepare(`
      INSERT INTO notifications (id, recipient_user_id, agency_id, booking_id, conversation_id, type, title, body, href, dedupe_key, created_at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (dedupe_key) DO NOTHING
    `).run(notification.id, notification.recipientUserId, notification.agencyId, notification.bookingId, notification.conversationId,
      notification.type, notification.title, notification.body, notification.href, notification.dedupeKey, notification.createdAt, notification.readAt);
    if (inserted.changes === 1) created.push(notification);
  }
  const deliveries = [];
  for (const { push, ...notification } of created) {
    publishNotification(notification.recipientUserId, notification);
    deliveries.push(deliverWebPush(notification.recipientUserId, notification, push || {}).catch(error => console.warn(`Web push ${notification.type} notification failed:`, error.message)));
    deliveries.push(deliverNativePush(notification.recipientUserId, notification, push || {}).catch(error => console.warn(`Android push ${notification.type} notification failed:`, error.message)));
  }
  // Wait so the alerts reach the phone before a serverless request finishes.
  await Promise.allSettled(deliveries);
  return created.map(({ push, ...notification }) => notification);
}

async function agencyStaffIds(agencyId) {
  return (await db.prepare("SELECT id FROM users WHERE agency_id = ? AND role = 'AGENCY'").all(agencyId)).map(row => row.id);
}

async function createPaymentNotifications(payment, status) {
  const amount = `${(payment.amountCents / 100).toFixed(2)} ${payment.currency}`;
  const href = `/?booking=${encodeURIComponent(payment.bookingId)}`;
  const base = { agencyId: payment.agencyId, bookingId: payment.bookingId, href };
  const items = [];
  const approved = status === 'APPROVED';
  if (payment.customerId) {
    items.push({
      ...base, recipientUserId: payment.customerId,
      type: approved ? 'PAYMENT_CONFIRMED' : 'PAYMENT_FAILED',
      title: approved ? 'Payment confirmed' : 'Payment not completed',
      body: approved
        ? `WaafiPay confirmed your payment of ${amount} for booking ${payment.bookingReference} (${payment.offerTitle}). The agency will finalize your trip.`
        : `WaafiPay did not confirm your payment for booking ${payment.bookingReference} (${payment.offerTitle}). You can try again or message the agency.`,
      dedupeKey: `PAYMENT:${payment.referenceId}:${status}:${payment.customerId}`
    });
  }
  for (const staffId of await agencyStaffIds(payment.agencyId)) {
    items.push({
      ...base, recipientUserId: staffId,
      type: approved ? 'PAYMENT_RECEIVED' : 'PAYMENT_FAILED',
      title: approved ? 'Payment received' : 'Customer payment not completed',
      body: approved
        ? `Booking ${payment.bookingReference} (${payment.offerTitle}) was paid: ${amount} via WaafiPay. Review and accept the booking.`
        : `WaafiPay did not confirm the payment for booking ${payment.bookingReference} (${payment.offerTitle}).`,
      dedupeKey: `PAYMENT:${payment.referenceId}:${status}:${staffId}`
    });
  }
  return createNotifications(items);
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
    await Promise.allSettled([
      deliverWebPush(notification.recipientUserId, notification).catch(error => console.warn('Ticket notification failed:', error.message)),
      deliverNativePush(notification.recipientUserId, notification).catch(error => console.warn('Android ticket notification failed:', error.message))
    ]);
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

const loginCodeTtlMs = 10 * 60 * 1000;
const loginCodeAttemptsLimit = 5;
function loginCodesAvailable() {
  try {
    return Boolean(passwordResetTransport());
  } catch {
    return false;
  }
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, name.length - 2)))}@${domain}`;
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

function nextIsoDate(isoDate) {
  return new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

// CSV cell with quoting; a leading = + - @ is neutralised so spreadsheet apps do not run it as a formula.
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Plain numbers such as +252 61 234 5678 or -5 are safe and stay unchanged.
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?[\d\s().-]+$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
  if (await plugins.handlePluginRequest(request, response, url, session)) return;
  if (method === 'GET' && pathname === '/api/payments/methods') {
    const config = getWaafiConfig();
    sendJson(response, 200, { waafiEnabled: Boolean(config), waafiEnvironment: config ? (config.sandbox ? 'sandbox' : 'production') : null,
      ...phonePay.phonePaymentAvailability() });
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

  if (method === 'GET' && pathname === '/api/catalog') await runBackgroundSweeps();

  // "Decline" button on a call notification. Works without a session: the secret token was only sent to the callee's devices.
  const pushDeclineMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/push-decline$/i);
  if (method === 'POST' && pushDeclineMatch) {
    const body = await readJson(request);
    const call = await db.prepare('SELECT * FROM chat_calls WHERE id = ?').get(pushDeclineMatch[1]);
    if (!call || !call.push_token || typeof body.token !== 'string' || !safeEqual(body.token, call.push_token)) {
      sendJson(response, 404, { error: 'Call not found.' });
      return;
    }
    const declined = await db.prepare("UPDATE chat_calls SET status = 'REJECTED', ended_at = ? WHERE id = ? AND status = 'RINGING' RETURNING id")
      .get(nowIso(), call.id);
    if (declined) await pushCallEnded(call, 'DECLINED');
    sendJson(response, 200, { ok: true, declined: Boolean(declined) });
    return;
  }

  // Daily job (Vercel Cron). Safe to run more than once: every task skips work already done.
  if (method === 'GET' && pathname === '/api/cron/daily') {
    const secret = process.env.CRON_SECRET;
    if (secret && !safeEqual(request.headers.authorization || '', `Bearer ${secret}`)) {
      sendJson(response, 401, { error: 'Not allowed.' });
      return;
    }
    await runBackgroundSweeps();
    const reminders = await sendTripReminders({ force: true });
    sendJson(response, 200, { ok: true, remindersSent: reminders });
    return;
  }

  if (!user && method === 'GET' && pathname === '/api/catalog') {
    const catalog = await db.prepare(`
      SELECT p.id, p.category, p.title AS titleEn, p.title_so AS titleSo, p.destination,
             p.route_badge AS routeBadge, p.specs, p.supplier_name AS supplierName,
             p.supplier_ref AS supplierRef, p.agency_id AS agencyId, p.base_cents AS baseUsdCents,
             p.tax_cents AS taxUsdCents, p.supplier_commission_pct AS supplierCommPct,
             p.available, p.travel_date AS travelDate, p.baggage, p.is_published AS published,
             CASE WHEN p.image_data IS NOT NULL THEN '/api/catalog/' || p.id || '/image?v=' || COALESCE(p.image_updated_at, '0') ELSE NULL END AS imageUrl,
             p.base_cents + p.tax_cents + CAST(ROUND(p.base_cents * a.markup_pct / 100.0) AS INTEGER) + 1200 AS estimatedTotalUsdCents,
             ${agencyRatingColumns('p.agency_id')}
      FROM catalog_products p
      JOIN agencies a ON a.id = p.agency_id
      WHERE p.is_published = 1 AND p.available > 0
        AND a.status = 'ACTIVE' AND a.is_approved = 1
        AND (p.travel_date IS NULL OR p.travel_date >= date('now'))
      ORDER BY p.title
    `).all();
    sendJson(response, 200, { catalog: catalog.map(normalizeAgencyRating) });
    return;
  }

  const agencyReviewsMatch = pathname.match(/^\/api\/agencies\/([0-9a-z_-]+)\/reviews$/i);
  if (method === 'GET' && agencyReviewsMatch) {
    const agency = await db.prepare('SELECT id, name, status, is_approved AS isApproved FROM agencies WHERE id = ?').get(agencyReviewsMatch[1]);
    const ownAgency = user?.role === 'AGENCY' && user.agency_id === agency?.id;
    if (!agency || (!(agency.status === 'ACTIVE' && Number(agency.isApproved) === 1) && !ownAgency && user?.role !== 'SUPER_ADMIN')) {
      sendJson(response, 404, { error: 'Agency not found.' });
      return;
    }
    const summary = await db.prepare(`SELECT COUNT(*) AS reviewCount, AVG(rating) AS averageRating,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS fiveCount, SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS fourCount,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS threeCount, SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS twoCount,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS oneCount
      FROM agency_reviews WHERE agency_id = ?`).get(agency.id);
    const reviews = await db.prepare(`SELECT r.id, r.rating, r.comment, r.agency_reply AS agencyReply,
        r.agency_reply_at AS agencyReplyAt, r.created_at AS createdAt, r.updated_at AS updatedAt,
        b.offer_title AS offerTitle, b.travel_date AS travelDate, COALESCE(u.name, b.traveler_name) AS reviewerName
      FROM agency_reviews r
      JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN users u ON u.id = r.customer_id
      WHERE r.agency_id = ?
      ORDER BY r.created_at DESC
      LIMIT 100`).all(agency.id);
    const count = Number(summary?.reviewCount || 0);
    sendJson(response, 200, {
      agency: { id: agency.id, name: agency.name },
      summary: {
        reviewCount: count,
        averageRating: count ? Math.round(Number(summary.averageRating) * 10) / 10 : null,
        distribution: { 5: Number(summary.fiveCount || 0), 4: Number(summary.fourCount || 0), 3: Number(summary.threeCount || 0), 2: Number(summary.twoCount || 0), 1: Number(summary.oneCount || 0) }
      },
      reviews: reviews.map(({ reviewerName, ...review }) => ({ ...review, rating: Number(review.rating), reviewerName: reviewerDisplayName(reviewerName) }))
    });
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
        console.error('Initial admin setup requested, but INITIAL_ADMIN_SETUP_TOKEN is not set in the hosting environment.');
        sendJson(response, 503, { error: 'First-time setup is not ready yet. The system administrator must add a one-time setup token in the hosting settings.' });
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
      sendJson(response, 503, { error: 'Password reset by email is not available right now. Contact SAFAR KAABE support for help.' });
      return;
    }
    if (!transport) {
      console.error('Password reset requested, but SMTP_HOST, SMTP_USER or SMTP_PASS is not configured.');
      sendJson(response, 503, { error: 'Password reset by email is not available right now. Contact SAFAR KAABE support for help.' });
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
    if (Number(account.login_code_enabled || 0) === 1) {
      let transport = null;
      try {
        transport = passwordResetTransport();
      } catch (error) {
        console.error('Sign-in code email settings are invalid.', error);
      }
      if (transport) {
        const code = String(crypto.randomInt(100000, 1000000));
        const credentials = await hashPassword(code);
        const challengeToken = crypto.randomBytes(24).toString('base64url');
        const createdAt = Date.now();
        await db.prepare('DELETE FROM login_challenges WHERE user_id = ? OR expires_at < ?').run(account.id, createdAt);
        await db.prepare(`INSERT INTO login_challenges (id, user_id, code_salt, code_hash, expires_at, attempts, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)`).run(crypto.createHash('sha256').update(challengeToken).digest('hex'), account.id,
          credentials.salt, credentials.hash, createdAt + loginCodeTtlMs, createdAt);
        try {
          await transport.sendMail({
            from: passwordResetSender,
            to: account.email,
            subject: 'Your SAFAR KAABE sign-in code',
            text: `Your SAFAR KAABE sign-in code is ${code}. It expires in 10 minutes. If you did not just try to sign in, change your password now.`,
            html: `<p>Your SAFAR KAABE sign-in code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not just try to sign in, change your password now.</p>`
          });
        } catch (error) {
          await db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(account.id);
          console.error('Unable to deliver sign-in code email.', error);
          sendJson(response, 503, { error: 'We could not email your sign-in code. Try again in a few minutes.' });
          return;
        }
        sendJson(response, 200, { loginCodeRequired: true, challengeId: challengeToken, emailHint: maskEmail(account.email) });
        return;
      }
      // Email stopped working after the code was turned on: let the owner in rather than lock them out, but record it.
      console.error(`Sign-in code skipped for ${account.email}: SMTP is not configured.`);
      await audit(account.id, 'LOGIN_CODE_SKIPPED', account.email);
    }
    await createSession(account, response);
    await audit(account.id, 'AUTHENTICATED', account.email);
    sendJson(response, 200, { user: publicUser(account) });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/login/verify') {
    const body = await readJson(request);
    const challengeToken = requireString(body.challengeId, 'Sign-in request', 200);
    const code = String(body.code ?? '').replace(/\s+/g, '');
    const challengeId = crypto.createHash('sha256').update(challengeToken).digest('hex');
    const challenge = await db.prepare('SELECT * FROM login_challenges WHERE id = ?').get(challengeId);
    if (!challenge || challenge.expires_at < Date.now()) {
      if (challenge) await db.prepare('DELETE FROM login_challenges WHERE id = ?').run(challengeId);
      sendJson(response, 400, { error: 'This code has expired. Sign in again to get a new code.' });
      return;
    }
    const counted = await db.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ? RETURNING attempts').get(challengeId);
    // Also cap guesses per account, so asking for new codes again and again does not allow unlimited guessing.
    const accountAllowed = await allowRateLimitRequest(`login-code:${challenge.user_id}`, 15 * 60 * 1000, 15);
    if (!accountAllowed) {
      await db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(challenge.user_id);
      sendJson(response, 429, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' }, { 'Retry-After': '900' });
      return;
    }
    if (!counted || counted.attempts > loginCodeAttemptsLimit) {
      await db.prepare('DELETE FROM login_challenges WHERE id = ?').run(challengeId);
      sendJson(response, 429, { error: 'Too many wrong codes. Sign in again to get a new code.' });
      return;
    }
    const supplied = /^\d{6}$/.test(code) ? await hashPassword(code, challenge.code_salt) : null;
    if (!supplied || !safeEqual(supplied.hash, challenge.code_hash)) {
      sendJson(response, 400, { error: 'That code is not correct. Check the email and try again.' });
      return;
    }
    await db.prepare('DELETE FROM login_challenges WHERE id = ?').run(challengeId);
    const account = await db.prepare('SELECT * FROM users WHERE id = ?').get(challenge.user_id);
    if (!account) {
      sendJson(response, 400, { error: 'This code has expired. Sign in again to get a new code.' });
      return;
    }
    if (account.role === 'AGENCY' &&
        !await db.prepare("SELECT id FROM agencies WHERE id = ? AND status = 'ACTIVE' AND is_approved = 1").get(account.agency_id)) {
      sendJson(response, 403, { error: 'This agency account is pending approval or suspended. Contact SAFAR KAABE support.' });
      return;
    }
    await createSession(account, response);
    await audit(account.id, 'AUTHENTICATED', `${account.email} (with sign-in code)`);
    sendJson(response, 200, { user: publicUser(account) });
    return;
  }

  if (method === 'PATCH' && pathname === '/api/auth/login-code') {
    if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
    if (!authorizeMutation(request, response, session)) return;
    const body = await readJson(request);
    if (typeof body.enabled !== 'boolean') {
      sendJson(response, 400, { error: 'Choose whether to turn sign-in codes on or off.' });
      return;
    }
    const password = requireString(body.password, 'Current password', 256);
    const credentials = await hashPassword(password, user.password_salt);
    if (!safeEqual(credentials.hash, user.password_hash)) {
      sendJson(response, 400, { error: 'Your current password is not correct.' });
      return;
    }
    if (body.enabled && !loginCodesAvailable()) {
      sendJson(response, 503, { error: 'Sign-in codes need email sending to be set up on the server first. Contact SAFAR KAABE support.' });
      return;
    }
    await db.prepare('UPDATE users SET login_code_enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, user.id);
    await audit(user.id, body.enabled ? 'LOGIN_CODES_ENABLED' : 'LOGIN_CODES_DISABLED', user.email);
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(response, 200, { user: publicUser(updated) });
    return;
  }

  if (method === 'PATCH' && pathname === '/api/auth/theme') {
    if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
    if (!authorizeMutation(request, response, session)) return;
    const body = await readJson(request);
    if (!['light', 'dark', 'system'].includes(body.theme)) {
      sendJson(response, 400, { error: 'Choose Light, Dark or Automatic.' });
      return;
    }
    await db.prepare('UPDATE users SET theme_preference = ? WHERE id = ?').run(body.theme, user.id);
    sendJson(response, 200, { user: publicUser({ ...user, theme_preference: body.theme }) });
    return;
  }

  if (method === 'GET' && pathname === '/api/auth/session') {
    sendJson(response, 200, { user: user ? publicUser(user) : null, loginCodesAvailable: loginCodesAvailable() });
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
      const publicNotifications = notifications.map(notificationPublic);
      const unread = publicNotifications.filter(item => !item.readAt).length;
      sendJson(response, 200, { notifications: publicNotifications, unreadCount: unread });
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

    if (method === 'DELETE' && pathname === '/api/notifications') {
      if (!authorizeMutation(request, response, session)) return;
      await db.prepare('DELETE FROM notifications WHERE recipient_user_id = ?').run(user.id);
      sendJson(response, 200, { ok: true });
      return;
    }

    if ((method === 'POST' || method === 'DELETE') && pathname === '/api/notification-mutes') {
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      if (typeof body.conversationId !== 'string' || !body.conversationId) {
        sendJson(response, 400, { error: 'A conversation is required.' });
        return;
      }
      const conversation = await getAccessibleConversation(body.conversationId, user);
      if (!conversation) {
        sendJson(response, 404, { error: 'Conversation not found.' });
        return;
      }
      const timestamp = nowIso();
      await db.prepare(`INSERT INTO notification_preferences (user_id, updated_at)
        VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING`).run(user.id, timestamp);
      const preferences = await db.prepare('SELECT muted_conversation_ids FROM notification_preferences WHERE user_id = ?').get(user.id);
      const mutedIds = JSON.parse(preferences.muted_conversation_ids || '[]');
      const nextMutedIds = method === 'POST'
        ? [...new Set([...mutedIds, conversation.id])]
        : mutedIds.filter(id => id !== conversation.id);
      await db.prepare('UPDATE notification_preferences SET muted_conversation_ids = ?, updated_at = ? WHERE user_id = ?')
        .run(JSON.stringify(nextMutedIds), timestamp, user.id);
      sendJson(response, 200, { ok: true, muted: method === 'POST' });
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

    if (pathname === '/api/push/native-tokens' && ['POST', 'DELETE'].includes(method)) {
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const token = requireString(body.token, 'Device token', 4096);
      if (method === 'DELETE') {
        await db.prepare('DELETE FROM native_push_tokens WHERE token = ? AND user_id = ?').run(token, user.id);
        sendJson(response, 200, { ok: true });
        return;
      }
      const platform = body.platform === 'ios' ? 'ios' : 'android';
      const stamp = nowIso();
      await db.prepare(`INSERT INTO native_push_tokens (token, user_id, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, updated_at = excluded.updated_at`)
        .run(token, user.id, platform, stamp, stamp);
      sendJson(response, 200, { ok: true, configured: Boolean(fcmServiceAccount) });
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
      const preferences = await db.prepare(`SELECT sound_enabled AS soundEnabled, desktop_push_enabled AS desktopPushEnabled,
        booking_alerts AS bookingAlerts, payment_notifications AS paymentNotifications, travel_news AS travelNews,
        promotional_notifications AS promotionalNotifications, status_updates AS statusUpdates,
        lock_screen_previews AS lockScreenPreviews, quiet_hours_enabled AS quietHoursEnabled,
        quiet_hours_start AS quietHoursStart, quiet_hours_end AS quietHoursEnd, timezone,
        muted_conversation_ids AS mutedConversationIds
        FROM notification_preferences WHERE user_id = ?`).get(user.id);
      const mutedConversationIds = JSON.parse(preferences.mutedConversationIds || '[]');
      sendJson(response, 200, {
        soundEnabled: Boolean(preferences.soundEnabled),
        desktopPushEnabled: Boolean(preferences.desktopPushEnabled),
        bookingAlerts: Boolean(preferences.bookingAlerts),
        paymentNotifications: Boolean(preferences.paymentNotifications),
        travelNews: Boolean(preferences.travelNews),
        promotionalNotifications: Boolean(preferences.promotionalNotifications),
        statusUpdates: Boolean(preferences.statusUpdates),
        lockScreenPreviews: Boolean(preferences.lockScreenPreviews),
        quietHoursEnabled: Boolean(preferences.quietHoursEnabled),
        quietHoursStart: preferences.quietHoursStart,
        quietHoursEnd: preferences.quietHoursEnd,
        timezone: preferences.timezone,
        mutedConversationIds
      });
      return;
    }

    if (method === 'PATCH' && pathname === '/api/notification-preferences') {
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const booleanFields = [
        'soundEnabled', 'desktopPushEnabled', 'bookingAlerts', 'paymentNotifications', 'travelNews',
        'promotionalNotifications', 'statusUpdates', 'lockScreenPreviews', 'quietHoursEnabled'
      ];
      if (booleanFields.some(field => typeof body[field] !== 'boolean') ||
          !/^([01]\d|2[0-3]):([0-5]\d)$/.test(body.quietHoursStart || '') ||
          !/^([01]\d|2[0-3]):([0-5]\d)$/.test(body.quietHoursEnd || '') ||
          typeof body.timezone !== 'string' || body.timezone.length > 100) {
        sendJson(response, 400, { error: 'Notification preferences are invalid.' });
        return;
      }
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
      } catch {
        sendJson(response, 400, { error: 'Choose a valid time zone for quiet hours.' });
        return;
      }
      await db.prepare(`
        INSERT INTO notification_preferences (
          user_id, sound_enabled, desktop_push_enabled, booking_alerts, payment_notifications, travel_news,
          promotional_notifications, status_updates, lock_screen_previews, quiet_hours_enabled,
          quiet_hours_start, quiet_hours_end, timezone, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET
          sound_enabled = excluded.sound_enabled, desktop_push_enabled = excluded.desktop_push_enabled,
          booking_alerts = excluded.booking_alerts, payment_notifications = excluded.payment_notifications,
          travel_news = excluded.travel_news, promotional_notifications = excluded.promotional_notifications,
          status_updates = excluded.status_updates, lock_screen_previews = excluded.lock_screen_previews,
          quiet_hours_enabled = excluded.quiet_hours_enabled, quiet_hours_start = excluded.quiet_hours_start,
          quiet_hours_end = excluded.quiet_hours_end, timezone = excluded.timezone, updated_at = excluded.updated_at
      `).run(user.id, ...booleanFields.map(field => body[field] ? 1 : 0),
        body.quietHoursStart, body.quietHoursEnd, body.timezone, nowIso());
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
               users.agency_id AS userAgencyId,
               CASE WHEN users.role = 'AGENCY' THEN agencies.logo_mime ELSE users.avatar_mime END AS avatarMime,
               CASE WHEN users.role = 'AGENCY' THEN agencies.logo_data ELSE users.avatar_data END AS avatarData,
               statuses.body, statuses.attachment_mime AS attachmentMime, statuses.audience,
               statuses.created_at AS createdAt, statuses.expires_at AS expiresAt,
               (SELECT COUNT(*) FROM chat_status_replies replies WHERE replies.status_id = statuses.id) AS replyCount,
               (SELECT COUNT(*) FROM chat_status_reactions reactions WHERE reactions.status_id = statuses.id) AS reactionCount,
               (SELECT COUNT(*) FROM chat_status_views views WHERE views.status_id = statuses.id) AS viewCount,
               (SELECT COUNT(*) FROM chat_status_views views WHERE views.status_id = statuses.id AND views.viewer_id = ?) AS viewedByMeCount,
               (SELECT reactions.emoji FROM chat_status_reactions reactions WHERE reactions.status_id = statuses.id AND reactions.user_id = ?) AS myReaction
        FROM chat_statuses statuses
        JOIN users ON users.id = statuses.user_id
        LEFT JOIN agencies ON agencies.id = users.agency_id
        WHERE statuses.expires_at > ?
        ORDER BY statuses.created_at DESC
      `).all(user.id, user.id, nowIso());
      const contactKeys = await statusContactKeys(user);
      const statusBlocks = await blockStateForUser(user);
      const visible = statuses
        .filter(status => canViewChatStatus(user, status, contactKeys, statusBlocks))
        .map(({ userAgencyId, viewedByMeCount, viewCount, ...status }) => ({
          ...status,
          audience: status.audience || 'EVERYONE',
          viewedByMe: status.userId === user.id || Number(viewedByMeCount) > 0,
          viewCount: status.userId === user.id ? Number(viewCount || 0) : null
        }));
      sendJson(response, 200, { statuses: visible });
      return;
    }

    const statusViewsMatch = pathname.match(/^\/api\/statuses\/([0-9a-f-]+)\/views$/i);
    if (statusViewsMatch && ['GET', 'POST'].includes(method)) {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      const status = await getVisibleChatStatus(statusViewsMatch[1], user);
      if (!status) { sendJson(response, 404, { error: 'Status not found or expired.' }); return; }
      if (method === 'POST') {
        if (!authorizeMutation(request, response, session)) return;
        if (status.userId !== user.id) {
          await db.prepare('INSERT INTO chat_status_views (status_id, viewer_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT (status_id, viewer_id) DO NOTHING')
            .run(status.id, user.id, nowIso());
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (status.userId !== user.id) { sendJson(response, 403, { error: 'Only the status owner can see who viewed it.' }); return; }
      const viewers = await db.prepare(`SELECT views.viewer_id AS userId, views.viewed_at AS viewedAt, users.name AS userName, users.role AS userRole,
          CASE WHEN users.role = 'AGENCY' THEN agencies.logo_mime ELSE users.avatar_mime END AS avatarMime,
          CASE WHEN users.role = 'AGENCY' THEN agencies.logo_data ELSE users.avatar_data END AS avatarData,
          (SELECT reactions.emoji FROM chat_status_reactions reactions WHERE reactions.status_id = views.status_id AND reactions.user_id = views.viewer_id) AS reaction
        FROM chat_status_views views
        JOIN users ON users.id = views.viewer_id
        LEFT JOIN agencies ON agencies.id = users.agency_id
        WHERE views.status_id = ?
        ORDER BY views.viewed_at DESC`).all(status.id);
      sendJson(response, 200, { audience: status.audience || 'EVERYONE', viewCount: viewers.length, viewers });
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
      const audience = body.audience === undefined ? 'EVERYONE' : body.audience;
      if (!chatStatusAudiences.includes(audience)) {
        sendJson(response, 400, { error: 'Choose who can see this status: everyone or your contacts.' });
        return;
      }
      const id = crypto.randomUUID();
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await db.prepare(`INSERT INTO chat_statuses (id, user_id, body, attachment_mime, attachment_data, created_at, expires_at, audience)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, user.id, text, attachment?.mime || null, attachment?.data || null, createdAt, expiresAt, audience);
      await audit(user.id, 'CHAT_STATUS_CREATED', id);
      sendJson(response, 201, { status: { id, userId: user.id, body: text, attachmentMime: attachment?.mime || null, audience, createdAt, expiresAt, viewCount: 0 } });
      return;
    }

    const statusRepliesMatch = pathname.match(/^\/api\/statuses\/([0-9a-f-]+)\/replies$/i);
    if (statusRepliesMatch && method === 'GET') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      const status = await getVisibleChatStatus(statusRepliesMatch[1], user);
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
      const status = await getVisibleChatStatus(statusRepliesMatch[1], user);
      if (!status) { sendJson(response, 404, { error: 'Status not found or expired.' }); return; }
      const payload = await readJson(request);
      const text = typeof payload.body === 'string' ? payload.body.trim() : '';
      if (!text || text.length > 500) { sendJson(response, 400, { error: 'A reply must be between 1 and 500 characters.' }); return; }
      if (status.userId === user.id) { sendJson(response, 400, { error: 'You cannot reply to your own status.' }); return; }
      const reply = { id: crypto.randomUUID(), statusId: status.id, userId: user.id, userName: user.name, body: text, createdAt: nowIso() };
      await db.prepare('INSERT INTO chat_status_replies (id, status_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(reply.id, reply.statusId, reply.userId, reply.body, reply.createdAt);
      await audit(user.id, 'CHAT_STATUS_REPLIED', status.id);
      try {
        await createNotifications([{ recipientUserId: status.userId, type: 'STATUS_REPLY', title: `${user.name} replied to your status`,
          body: text.slice(0, 220), dedupeKey: `STATUS_REPLY:${reply.id}` }]);
      } catch (error) {
        console.error('Status reply notification could not be created:', error.message);
      }
      sendJson(response, 201, { reply });
      return;
    }
    const statusReactionMatch = pathname.match(/^\/api\/statuses\/([0-9a-f-]+)\/reactions$/i);
    if (statusReactionMatch && method === 'POST') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const status = await getVisibleChatStatus(statusReactionMatch[1], user);
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
      if (reaction && status.userId !== user.id) {
        try {
          await createNotifications([{ recipientUserId: status.userId, type: 'STATUS_REACTION', title: `${user.name} reacted to your status`,
            body: `${user.name} reacted ${reaction} to your travel update.`, dedupeKey: `STATUS_REACTION:${status.id}:${user.id}:${reaction}` }]);
        } catch (error) {
          console.error('Status reaction notification could not be created:', error.message);
        }
      }
      sendJson(response, 200, { reaction });
      return;
    }

    const chatStatusAttachmentMatch = pathname.match(/^\/api\/statuses\/([0-9a-f-]+)\/attachment$/i);
    if (chatStatusAttachmentMatch && method === 'GET') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      const visibleStatus = await getVisibleChatStatus(chatStatusAttachmentMatch[1], user);
      const status = visibleStatus && await db.prepare(`SELECT attachment_mime, attachment_data FROM chat_statuses
        WHERE id = ? AND expires_at > ? AND attachment_data IS NOT NULL`).get(visibleStatus.id, nowIso());
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
        if (body.audience !== undefined) {
          if (!chatStatusAudiences.includes(body.audience)) {
            sendJson(response, 400, { error: 'Choose who can see this status: everyone or your contacts.' });
            return;
          }
          await db.prepare('UPDATE chat_statuses SET audience = ? WHERE id = ? AND user_id = ?').run(body.audience, status.id, user.id);
          await audit(user.id, 'CHAT_STATUS_AUDIENCE_UPDATED', `${status.id}: ${body.audience}`);
          if (body.body === undefined) {
            sendJson(response, 200, { ok: true, audience: body.audience });
            return;
          }
        }
        const text = typeof body.body === 'string' ? body.body.trim() : '';
        if (text.length > 500 || (!text && !status.attachmentData)) {
          sendJson(response, 400, { error: text.length > 500 ? 'Status text cannot be longer than 500 characters.' : 'A photo status must keep a caption or photo.' });
          return;
        }
        await db.prepare('UPDATE chat_statuses SET body = ? WHERE id = ? AND user_id = ?').run(text, status.id, user.id);
        await audit(user.id, 'CHAT_STATUS_UPDATED', status.id);
        sendJson(response, 200, { ok: true, body: text, ...(body.audience !== undefined ? { audience: body.audience } : {}) });
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

    if (pathname === '/api/blocks' && ['GET', 'POST', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY', 'CLIENT'])) return;
      if (method !== 'GET' && !authorizeMutation(request, response, session)) return;
      if (method === 'POST') {
        const body = await readJson(request);
        const conversation = await getAccessibleConversation(requireString(body.conversationId, 'Conversation', 80), user);
        if (!conversation) { sendJson(response, 404, { error: 'Conversation not found.' }); return; }
        const key = conversationPeerKey(conversation, user);
        if (key === partyKeyForUser(user)) { sendJson(response, 400, { error: 'You cannot block yourself.' }); return; }
        await db.prepare('INSERT INTO blocked_parties (blocker_id, blocked_key, created_at) VALUES (?, ?, ?) ON CONFLICT (blocker_id, blocked_key) DO NOTHING')
          .run(user.id, key, nowIso());
        // Hang up any call that is ringing or connected between the two sides.
        const mine = await myPartyIds(user);
        const theirs = await partyMemberIds(key);
        if (theirs.length) {
          const minePh = mine.map(() => '?').join(', ');
          const theirsPh = theirs.map(() => '?').join(', ');
          await db.prepare(`UPDATE chat_calls SET status = 'ENDED', ended_at = ? WHERE status IN ('RINGING', 'ACCEPTED')
            AND ((caller_id IN (${minePh}) AND callee_id IN (${theirsPh})) OR (caller_id IN (${theirsPh}) AND callee_id IN (${minePh})))`)
            .run(nowIso(), ...mine, ...theirs, ...theirs, ...mine);
        }
        await audit(user.id, 'CONTACT_BLOCKED', key);
        sendJson(response, 200, { ok: true, key });
        return;
      }
      if (method === 'DELETE') {
        const body = await readJson(request);
        const key = requireString(body.key, 'Blocked contact', 120);
        const party = await myPartyIds(user);
        await db.prepare(`DELETE FROM blocked_parties WHERE blocked_key = ? AND blocker_id IN (${party.map(() => '?').join(', ')})`).run(key, ...party);
        await audit(user.id, 'CONTACT_UNBLOCKED', key);
        sendJson(response, 200, { ok: true });
        return;
      }
      const party = await myPartyIds(user);
      const rows = await db.prepare(`SELECT blocked_key AS "key", MIN(created_at) AS "createdAt" FROM blocked_parties
        WHERE blocker_id IN (${party.map(() => '?').join(', ')}) GROUP BY blocked_key ORDER BY MIN(created_at) DESC`).all(...party);
      const blocks = [];
      for (const row of rows) {
        let name = 'SAFAR KAABE support';
        if (row.key.startsWith('AGENCY:')) name = (await db.prepare('SELECT name FROM agencies WHERE id = ?').get(row.key.slice(7)))?.name || 'Travel agency';
        else if (row.key.startsWith('USER:')) name = (await db.prepare('SELECT name FROM users WHERE id = ?').get(row.key.slice(5)))?.name || 'Traveler';
        blocks.push({ ...row, name });
      }
      sendJson(response, 200, { blocks });
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
      const myBlocks = await blockStateForUser(user);
      sendJson(response, 200, { conversations: conversations.map(conversation => {
        const peerKey = conversationPeerKey({ agency_id: conversation.agencyId, customer_id: conversation.customerId }, user);
        return { ...conversation, peerKey, blockedByMe: myBlocks.blockedKeys.has(peerKey) };
      }) });
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
      const newConversationBlock = await blockBetween(user, conversationPeerKey({ agency_id: agencyId, customer_id: customerId }, user));
      if (newConversationBlock) {
        sendJson(response, 403, { error: newConversationBlock === 'BLOCKED_BY_ME'
          ? 'You blocked this contact. Unblock them in My profile to start a chat.'
          : 'You cannot start a chat with this contact right now.' });
        return;
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
      if (await isBlockedBetween(user.id, callee.id)) {
        sendJson(response, 403, { error: 'You cannot call this person because one of you has blocked the other.' });
        return;
      }
      const staleCallBefore = new Date(Date.now() - 90_000).toISOString();
      await db.prepare(`UPDATE chat_calls SET status = 'ENDED', ended_at = ${callLastSeenSql} WHERE status = 'ACCEPTED'
        AND (caller_id IN (?, ?) OR callee_id IN (?, ?))
        AND (COALESCE(caller_seen_at, accepted_at, created_at) < ? OR COALESCE(callee_seen_at, accepted_at, created_at) < ?)`)
        .run(user.id, callee.id, user.id, callee.id, staleCallBefore, staleCallBefore);
      const busyQuery = `SELECT id, created_at AS "createdAt" FROM chat_calls WHERE status IN ('RINGING', 'ACCEPTED')
        AND (caller_id IN (?, ?) OR callee_id IN (?, ?))`;
      if (await db.prepare(`${busyQuery} LIMIT 1`).get(user.id, callee.id, user.id, callee.id)) {
        sendJson(response, 409, { error: 'This participant is already in another call. Try again shortly.' });
        return;
      }
      const callId = crypto.randomUUID();
      const createdAt = nowIso();
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null;
      const declineToken = crypto.randomBytes(18).toString('base64url');
      await db.prepare(`INSERT INTO chat_calls (id, conversation_id, caller_id, callee_id, call_type, status, created_at, caller_device, push_token, ring_push_at)
        VALUES (?, ?, ?, ?, ?, 'RINGING', ?, ?, ?, ?)`).run(callId, conversation.id, user.id, callee.id, callType, createdAt, deviceId, declineToken, createdAt);
      // Two people may call the same person at the same moment. Both inserts are now visible, so keep only
      // the earliest call and withdraw this one if another call got there first.
      const competing = (await db.prepare(busyQuery).all(user.id, callee.id, user.id, callee.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (competing.length > 1 && competing[0].id !== callId) {
        await db.prepare('DELETE FROM chat_calls WHERE id = ?').run(callId);
        sendJson(response, 409, { error: 'This participant is already in another call. Try again shortly.' });
        return;
      }
      try {
        await createNotifications([{
          recipientUserId: callee.id, agencyId: conversation.agency_id, conversationId: conversation.id, type: 'CALL_INCOMING',
          title: `Incoming ${callType === 'VIDEO' ? 'video' : 'voice'} call`, body: `${user.name} is calling you. Open SAFAR KAABE to answer.`,
          href: `/?conversation=${encodeURIComponent(conversation.id)}`, createdAt, dedupeKey: `CALL_INCOMING:${callId}`,
          push: { tag: `call-${callId}`, data: { callId, conversationId: conversation.id, callType, callerName: user.name, declineToken } }
        }]);
      } catch (error) {
        console.error('Incoming call notification could not be created:', error.message);
      }
      sendJson(response, 201, { call: { id: callId, conversationId: conversation.id, callerId: user.id,
        calleeId: callee.id, peerName: callee.name, callType, status: 'RINGING', createdAt } });
      return;
    }

    const callSignalsMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/signals$/i);
    const chatCallMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)$/i);
    if (method === 'GET' && pathname === '/api/calls/history') {
      const history = await db.prepare(`SELECT calls.id, calls.conversation_id AS "conversationId", calls.caller_id AS "callerId",
          calls.callee_id AS "calleeId", calls.call_type AS "callType", calls.status, calls.created_at AS "createdAt",
          calls.accepted_at AS "acceptedAt", calls.ended_at AS "endedAt",
          caller.name AS "callerName", caller.avatar_mime AS "callerAvatarMime", caller.avatar_data AS "callerAvatarData",
          callee.name AS "calleeName", callee.avatar_mime AS "calleeAvatarMime", callee.avatar_data AS "calleeAvatarData"
        FROM chat_calls calls JOIN users caller ON caller.id = calls.caller_id JOIN users callee ON callee.id = calls.callee_id
        WHERE calls.caller_id = ? OR calls.callee_id = ?
        ORDER BY calls.created_at DESC LIMIT 100`).all(user.id, user.id);
      sendJson(response, 200, { calls: history.map(call => {
        const outgoing = call.callerId === user.id;
        const durationSeconds = call.acceptedAt && call.endedAt
          ? Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.acceptedAt)) / 1000)) : null;
        return {
          id: call.id, conversationId: call.conversationId, callType: call.callType, status: call.status,
          direction: outgoing ? 'OUTGOING' : 'INCOMING', createdAt: call.createdAt, durationSeconds,
          peerName: outgoing ? call.calleeName : call.callerName,
          peerAvatarMime: outgoing ? call.calleeAvatarMime : call.callerAvatarMime,
          peerAvatarData: outgoing ? call.calleeAvatarData : call.callerAvatarData
        };
      }) });
      return;
    }
    if (method === 'GET' && pathname === '/api/calls/active') {
      const now = nowIso();
      await db.prepare("UPDATE chat_calls SET caller_seen_at = ? WHERE caller_id = ? AND status IN ('RINGING', 'ACCEPTED')").run(now, user.id);
      await db.prepare("UPDATE chat_calls SET callee_seen_at = ? WHERE callee_id = ? AND status IN ('RINGING', 'ACCEPTED')").run(now, user.id);
      const cutoff = new Date(Date.now() - 60_000).toISOString();
      const missed = await db.prepare(`UPDATE chat_calls SET status = 'MISSED', ended_at = ? WHERE status = 'RINGING' AND created_at < ?
        RETURNING id, conversation_id AS "conversationId", caller_id AS "callerId", callee_id AS "calleeId", call_type AS "callType"`)
        .all(now, cutoff);
      for (const call of missed) {
        await pushCallEnded({ id: call.id, conversation_id: call.conversationId, callee_id: call.calleeId }, 'MISSED');
        try {
          const caller = await db.prepare('SELECT name FROM users WHERE id = ?').get(call.callerId);
          await createNotifications([{
            recipientUserId: call.calleeId, conversationId: call.conversationId, type: 'CALL_MISSED',
            title: `Missed ${call.callType === 'VIDEO' ? 'video' : 'voice'} call`,
            body: `You missed a call from ${caller?.name || 'a SAFAR KAABE contact'}. Open the chat to call back.`,
            href: `/?conversation=${encodeURIComponent(call.conversationId)}`, dedupeKey: `CALL_MISSED:${call.id}`
          }]);
        } catch (error) {
          console.error('Missed call notification could not be created:', error.message);
        }
      }
      // A call whose participant closed the app without hanging up would block both people
      // from new calls. End connected calls when either side has not checked in for 90 seconds.
      // While the caller waits, ring the other person's browser again every few seconds (a web notification
      // only sounds once). The Android app rings continuously by itself.
      if (webPushConfigured) {
        const ringAgainBefore = new Date(Date.now() - 6_000).toISOString();
        const ringing = await db.prepare(`UPDATE chat_calls SET ring_push_at = ? WHERE caller_id = ? AND status = 'RINGING'
            AND created_at >= ? AND (ring_push_at IS NULL OR ring_push_at < ?)
          RETURNING id, conversation_id AS "conversationId", callee_id AS "calleeId", call_type AS "callType", push_token AS "pushToken"`)
          .all(now, user.id, cutoff, ringAgainBefore);
        for (const call of ringing) {
          await deliverWebPush(call.calleeId, {
            id: null, type: 'CALL_INCOMING', conversationId: call.conversationId,
            title: `Incoming ${call.callType === 'VIDEO' ? 'video' : 'voice'} call`, body: `${user.name} is calling you. Open SAFAR KAABE to answer.`,
            href: `/?conversation=${encodeURIComponent(call.conversationId)}`
          }, { tag: `call-${call.id}`, data: { callId: call.id, conversationId: call.conversationId, callType: call.callType, callerName: user.name, declineToken: call.pushToken } })
            .catch(error => console.warn('Repeat call ring failed:', error.message));
        }
      }
      const abandonedBefore = new Date(Date.now() - 90_000).toISOString();
      await db.prepare(`UPDATE chat_calls SET status = 'ENDED', ended_at = ${callLastSeenSql} WHERE status = 'ACCEPTED'
        AND (COALESCE(caller_seen_at, accepted_at, created_at) < ? OR COALESCE(callee_seen_at, accepted_at, created_at) < ?)`)
        .run(abandonedBefore, abandonedBefore);
      const calls = await db.prepare(`SELECT calls.id, calls.conversation_id AS conversationId,
        calls.caller_id AS callerId, caller.name AS callerName, caller.avatar_mime AS callerAvatarMime,
        caller.avatar_data AS callerAvatarData, calls.callee_id AS calleeId, callee.name AS calleeName,
        callee.avatar_mime AS calleeAvatarMime, callee.avatar_data AS calleeAvatarData,
        calls.call_type AS callType, calls.status, calls.created_at AS createdAt,
        CASE WHEN calls.caller_id = ? THEN calls.caller_device ELSE calls.callee_device END AS myDeviceId
        FROM chat_calls calls JOIN users caller ON caller.id = calls.caller_id
        JOIN users callee ON callee.id = calls.callee_id
        WHERE (calls.caller_id = ? OR calls.callee_id = ?) AND calls.status IN ('RINGING', 'ACCEPTED')
        ORDER BY calls.created_at DESC LIMIT 10`).all(user.id, user.id, user.id);
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
      if (await isBlockedBetween(call.caller_id, call.callee_id)) {
        await db.prepare("UPDATE chat_calls SET status = 'ENDED', ended_at = ? WHERE id = ? AND status IN ('RINGING', 'ACCEPTED')").run(nowIso(), call.id);
        sendJson(response, 403, { error: 'This call was ended because one of you has blocked the other.' });
        return;
      }
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
        if (await isBlockedBetween(call.caller_id, call.callee_id)) {
          await db.prepare("UPDATE chat_calls SET status = 'ENDED', ended_at = ? WHERE id = ? AND status = 'RINGING'").run(nowIso(), call.id);
          sendJson(response, 403, { error: 'This call was ended because one of you has blocked the other.' });
          return;
        }
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null;
        await db.prepare("UPDATE chat_calls SET status = 'ACCEPTED', accepted_at = ?, callee_device = ? WHERE id = ? AND status = 'RINGING'")
          .run(nowIso(), deviceId, call.id);
        await pushCallEnded(call, 'ANSWERED');
      } else if (action === 'REJECT' && call.callee_id === user.id && call.status === 'RINGING') {
        await db.prepare("UPDATE chat_calls SET status = 'REJECTED', ended_at = ? WHERE id = ? AND status = 'RINGING'").run(nowIso(), call.id);
        await pushCallEnded(call, 'DECLINED');
      } else if (action === 'END' && call.status === 'RINGING') {
        // Hanging up before an answer: for the caller it is a missed call for the other person; for the callee it is a decline.
        const endedStatus = call.caller_id === user.id ? 'MISSED' : 'REJECTED';
        const ended = await db.prepare(`UPDATE chat_calls SET status = ?, ended_at = ? WHERE id = ? AND status = 'RINGING'
          RETURNING id`).get(endedStatus, nowIso(), call.id);
        if (ended) await pushCallEnded(call, endedStatus === 'MISSED' ? 'MISSED' : 'DECLINED');
        if (ended && endedStatus === 'MISSED') {
          try {
            await createNotifications([{
              recipientUserId: call.callee_id, conversationId: call.conversation_id, type: 'CALL_MISSED',
              title: `Missed ${call.call_type === 'VIDEO' ? 'video' : 'voice'} call`,
              body: `You missed a call from ${user.name}. Open the chat to call back.`,
              href: `/?conversation=${encodeURIComponent(call.conversation_id)}`, dedupeKey: `CALL_MISSED:${call.id}`
            }]);
          } catch (error) {
            console.error('Missed call notification could not be created:', error.message);
          }
        }
      } else if (action === 'END' && call.status === 'ACCEPTED') {
        await db.prepare("UPDATE chat_calls SET status = 'ENDED', ended_at = ? WHERE id = ? AND status = 'ACCEPTED'").run(nowIso(), call.id);
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
      if (method === 'PATCH' && await blockBetween(user, conversationPeerKey(conversation, user))) {
        sendJson(response, 403, { error: 'You cannot edit messages in this chat because one of you has blocked the other.' });
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
      sendChatAttachment(response, attachment, request);
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
        WHERE messages.conversation_id = ? ORDER BY messages.created_at DESC, messages.id DESC LIMIT 200
      `).all(conversation.id);
      messages.reverse();
      const peerKey = conversationPeerKey(conversation, user);
      sendJson(response, 200, { messages, block: await blockBetween(user, peerKey) });
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
      const isParticipant = user.role === 'CLIENT' ? conversation.customer_id === user.id
        : user.role === 'AGENCY' ? conversation.agency_id === user.agency_id
          : !conversation.agency_id || !conversation.customer_id;
      if (isParticipant) {
        await db.prepare('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL')
          .run(nowIso(), conversation.id, user.id);
      }
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
      const block = await blockBetween(user, conversationPeerKey(conversation, user));
      if (block) {
        sendJson(response, 403, { error: block === 'BLOCKED_BY_ME'
          ? 'You blocked this contact. Unblock them from their profile to send messages again.'
          : 'You cannot send messages in this chat right now.' });
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
                 CASE WHEN image_data IS NOT NULL THEN '/api/catalog/' || id || '/image?v=' || COALESCE(image_updated_at, '0') ELSE NULL END AS imageUrl,
                 base_cents + tax_cents + CAST(ROUND(base_cents * (SELECT markup_pct FROM agencies WHERE agencies.id = catalog_products.agency_id) / 100.0) AS INTEGER) + 1200 AS estimatedTotalUsdCents,
                 ${agencyRatingColumns('catalog_products.agency_id')}
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
      sendJson(response, 200, { catalog: products.map(normalizeAgencyRating) });
      return;
    }

    if (pathname === '/api/saved-offers' && method === 'GET') {
      if (!requireRole(response, user, ['CLIENT'])) return;
      const saved = await db.prepare(`
        SELECT s.offer_id AS offerId, s.created_at AS savedAt,
               p.id, p.category, p.title AS titleEn, p.title_so AS titleSo, p.destination, p.route_badge AS routeBadge,
               p.specs, p.supplier_name AS supplierName, p.supplier_ref AS supplierRef, p.agency_id AS agencyId,
               p.base_cents AS baseUsdCents, p.tax_cents AS taxUsdCents, p.supplier_commission_pct AS supplierCommPct,
               p.available, p.travel_date AS travelDate, p.baggage, p.is_published AS published,
               CASE WHEN p.image_data IS NOT NULL THEN '/api/catalog/' || p.id || '/image?v=' || COALESCE(p.image_updated_at, '0') ELSE NULL END AS imageUrl,
               p.base_cents + p.tax_cents + CAST(ROUND(p.base_cents * a.markup_pct / 100.0) AS INTEGER) + 1200 AS estimatedTotalUsdCents,
               a.name AS agencyName,
               CASE WHEN p.is_published = 1 AND p.available > 0 AND a.status = 'ACTIVE' AND a.is_approved = 1
                 AND (p.travel_date IS NULL OR p.travel_date >= date('now')) THEN 1 ELSE 0 END AS bookable,
               CASE WHEN p.is_published = 1 AND p.available <= 0 AND a.status = 'ACTIVE' AND a.is_approved = 1
                 AND (p.travel_date IS NULL OR p.travel_date >= date('now')) THEN 1 ELSE 0 END AS soldOut,
               ${agencyRatingColumns('p.agency_id')}
        FROM saved_offers s
        JOIN catalog_products p ON p.id = s.offer_id
        JOIN agencies a ON a.id = p.agency_id
        WHERE s.user_id = ?
        ORDER BY s.created_at DESC
      `).all(user.id);
      const waitlisted = new Set((await db.prepare('SELECT offer_id AS "offerId" FROM trip_waitlist WHERE user_id = ?').all(user.id)).map(row => row.offerId));
      sendJson(response, 200, {
        savedOffers: saved.map(record => {
          const bookable = Number(record.bookable) === 1;
          if (bookable) return { ...normalizeAgencyRating(record), bookable: true, waitlisted: waitlisted.has(record.id) };
          return { offerId: record.offerId, savedAt: record.savedAt, id: record.id, titleEn: record.titleEn, titleSo: record.titleSo,
            agencyId: record.agencyId, agencyName: record.agencyName, bookable: false,
            soldOut: Number(record.soldOut) === 1, travelDate: record.soldOut ? record.travelDate : undefined,
            waitlisted: waitlisted.has(record.id) };
        })
      });
      return;
    }

    if (pathname === '/api/waitlist' && method === 'GET') {
      if (!requireRole(response, user, ['CLIENT'])) return;
      const entries = await db.prepare(`
        SELECT w.offer_id AS "offerId", w.seat_count AS "seatCount", w.created_at AS "joinedAt", w.notified_at AS "notifiedAt",
               p.title, p.travel_date AS "travelDate", p.available, a.name AS "agencyName"
        FROM trip_waitlist w JOIN catalog_products p ON p.id = w.offer_id JOIN agencies a ON a.id = p.agency_id
        WHERE w.user_id = ? ORDER BY w.created_at DESC`).all(user.id);
      sendJson(response, 200, { waitlist: entries });
      return;
    }

    const waitlistMatch = pathname.match(/^\/api\/offers\/([0-9a-z_-]+)\/waitlist$/i);
    if (waitlistMatch && ['POST', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const offerId = waitlistMatch[1];
      if (method === 'DELETE') {
        await db.prepare('DELETE FROM trip_waitlist WHERE offer_id = ? AND user_id = ?').run(offerId, user.id);
        sendJson(response, 200, { ok: true, waitlisted: false, message: 'You left the waitlist for this trip.' });
        return;
      }
      const body = await readJson(request);
      const seatCount = body.seatCount === undefined ? 1 : Number(body.seatCount);
      if (!Number.isSafeInteger(seatCount) || seatCount < 1 || seatCount > 50) {
        sendJson(response, 400, { error: 'Choose between 1 and 50 seats.' });
        return;
      }
      const offer = await db.prepare(`SELECT p.id, p.title, p.available FROM catalog_products p JOIN agencies a ON a.id = p.agency_id
        WHERE p.id = ? AND p.is_published = 1 AND a.status = 'ACTIVE' AND a.is_approved = 1
          AND (p.travel_date IS NULL OR p.travel_date >= ?)`).get(offerId, new Date().toISOString().slice(0, 10));
      if (!offer) {
        sendJson(response, 404, { error: 'This trip is no longer offered, so you cannot join its waitlist.' });
        return;
      }
      if (Number(offer.available) >= seatCount) {
        sendJson(response, 409, { error: `${offer.available} ${Number(offer.available) === 1 ? 'seat is' : 'seats are'} available now. Book the trip instead of joining the waitlist.`, available: Number(offer.available) });
        return;
      }
      const waitlistCount = await db.prepare('SELECT COUNT(*) AS "count" FROM trip_waitlist WHERE user_id = ?').get(user.id);
      const already = await db.prepare('SELECT 1 AS present FROM trip_waitlist WHERE offer_id = ? AND user_id = ?').get(offer.id, user.id);
      if (!already && Number(waitlistCount?.count || 0) >= 50) {
        sendJson(response, 409, { error: 'You can wait for up to 50 trips at once. Leave some waitlists first.' });
        return;
      }
      await db.prepare(`INSERT INTO trip_waitlist (offer_id, user_id, seat_count, created_at, notified_at) VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT (offer_id, user_id) DO UPDATE SET seat_count = excluded.seat_count, created_at = excluded.created_at, notified_at = NULL`)
        .run(offer.id, user.id, seatCount, nowIso());
      sendJson(response, 200, { ok: true, waitlisted: true,
        message: `You are on the waitlist for ${offer.title}. We will notify you when ${seatCount === 1 ? 'a seat opens' : `${seatCount} seats open`}.` });
      return;
    }

    const savedOfferMatch = pathname.match(/^\/api\/saved-offers\/([0-9a-z_-]+)$/i);
    if (savedOfferMatch && ['PUT', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const offerId = savedOfferMatch[1];
      if (method === 'DELETE') {
        const removed = await db.prepare('DELETE FROM saved_offers WHERE user_id = ? AND offer_id = ?').run(user.id, offerId);
        sendJson(response, 200, { ok: true, saved: false, removed: removed.changes === 1 });
        return;
      }
      const offer = await db.prepare(`SELECT p.id FROM catalog_products p JOIN agencies a ON a.id = p.agency_id
        WHERE p.id = ? AND p.is_published = 1 AND p.available > 0 AND a.status = 'ACTIVE' AND a.is_approved = 1
          AND (p.travel_date IS NULL OR p.travel_date >= date('now'))`).get(offerId);
      if (!offer) {
        sendJson(response, 404, { error: 'This trip is no longer available to save.' });
        return;
      }
      const savedCount = await db.prepare('SELECT COUNT(*) AS savedCount FROM saved_offers WHERE user_id = ?').get(user.id);
      const alreadySaved = await db.prepare('SELECT 1 AS present FROM saved_offers WHERE user_id = ? AND offer_id = ?').get(user.id, offer.id);
      if (!alreadySaved && Number(savedCount?.savedCount || 0) >= 200) {
        sendJson(response, 409, { error: 'You can save up to 200 trips. Remove some saved trips first.' });
        return;
      }
      await db.prepare('INSERT INTO saved_offers (user_id, offer_id, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id, offer_id) DO NOTHING')
        .run(user.id, offer.id, nowIso());
      sendJson(response, 200, { ok: true, saved: true });
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
        INSERT INTO catalog_products (id, agency_id, title, title_so, category, destination, route_badge, specs, supplier_name, supplier_ref, base_cents, tax_cents, supplier_commission_pct, available, travel_date, baggage, image_mime, image_data, is_published, image_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(product.id, product.agencyId, product.titleEn, product.titleSo, product.category, product.destination, product.routeBadge, product.specs, product.supplierName, product.supplierRef, product.baseUsdCents, product.taxUsdCents, product.supplierCommPct, product.available, product.travelDate, product.baggage, imageData ? imageMime : null, imageData, published, imageData ? String(Date.now()) : null);
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
            image_mime = ?, image_data = ?, is_published = ?,
            image_updated_at = CASE WHEN ? = 1 THEN ? ELSE image_updated_at END
        WHERE id = ?
      `).run(title, title, category, destination, routeBadge, specs, Math.round(price * 100), Math.round(price * 12), available, travelDate, baggage, imageData ? imageMime : null, imageData, published,
        body.imageData === undefined ? 0 : 1, String(Date.now()), existing.id);
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

    // Pay by phone: asks the traveler's wallet provider to charge their number. The traveler approves with their PIN.
    const phoneChargeMatch = pathname.match(/^\/api\/payments\/phone\/([0-9a-f-]+)\/charge$/i);
    if (phoneChargeMatch && method === 'POST') {
      if (!requireRole(response, user, ['CLIENT'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const payment = await loadPhonePayment(phoneChargeMatch[1]);
      if (!payment || payment.customerId !== user.id) {
        sendJson(response, 404, { error: 'Payment not found.' });
        return;
      }
      if (payment.status !== 'PENDING') {
        sendJson(response, 200, { payment: publicPhonePayment(payment), alreadyFinished: true });
        return;
      }
      if (payment.startedAt) {
        sendJson(response, 409, { error: 'This payment is already in progress. Check your phone and enter your PIN.', payment: publicPhonePayment(payment) });
        return;
      }
      if (payment.bookingState !== 'PAYMENT_PENDING') {
        sendJson(response, 409, { error: 'This booking is no longer waiting for payment. Refresh your trips.', payment: publicPhonePayment(payment) });
        return;
      }
      if (!phonePay.providerConfig(payment.provider)) {
        sendJson(response, 503, { error: `${phonePay.providerLabel(payment.provider)} payments are not available right now. Message the agency or try again later.` });
        return;
      }
      // Claim the payment first so two taps (or two devices) can never charge twice.
      if (!await allowRateLimitRequest(`phone-charge-user:${user.id}`, 60 * 60 * 1000, 12) ||
          !await allowRateLimitRequest(`phone-charge-number:${payment.accountNumber}`, 60 * 60 * 1000, 5)) {
        sendJson(response, 429, { error: 'Too many payment requests were sent. Wait an hour and try again, or message the agency.' }, { 'Retry-After': '3600' });
        return;
      }
      const startedAt = nowIso();
      const claimed = await runInTransaction(async () => {
        await lockBookingRow(payment.bookingId);
        return db.prepare(`UPDATE phone_payments SET started_at = ?, updated_at = ?
          WHERE id = ? AND status = 'PENDING' AND started_at IS NULL
            AND EXISTS (SELECT 1 FROM bookings WHERE bookings.id = phone_payments.booking_id AND bookings.state = 'PAYMENT_PENDING')`)
          .run(startedAt, startedAt, payment.id);
      });
      if (claimed.changes !== 1) {
        sendJson(response, 409, { error: 'This payment is already in progress. Check your phone and enter your PIN.', payment: publicPhonePayment(await loadPhonePayment(payment.bookingId)) });
        return;
      }
      await audit(user.id, 'PHONE_PAYMENT_STARTED', `${payment.bookingReference} ${payment.provider} ${payment.accountNumber} (${payment.amountCents} cents)`);
      let result;
      try {
        result = await phonePay.chargePhone({
          provider: payment.provider, accountNumber: payment.accountNumber, amountCents: payment.amountCents,
          currency: payment.currency, description: `SAFAR KAABE booking ${payment.bookingReference}`
        });
      } catch (error) {
        // Thrown only before anything was sent to the provider, so it is safe to let the traveler try again.
        await db.prepare("UPDATE phone_payments SET started_at = NULL, updated_at = ? WHERE id = ? AND status = 'PENDING'").run(nowIso(), payment.id);
        throw error;
      }
      const settled = await settlePhonePayment(payment, result);
      sendJson(response, 200, { payment: publicPhonePayment(settled) });
      return;
    }

    const bookingReviewMatch = pathname.match(/^\/api\/bookings\/([0-9a-f-]+)\/review$/i);
    if (bookingReviewMatch && ['PUT', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, method === 'PUT' ? ['CLIENT'] : ['CLIENT', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const booking = await db.prepare(`SELECT id, reference, agency_id AS agencyId, customer_id AS customerId, state,
          travel_date AS travelDate, offer_title AS offerTitle FROM bookings WHERE id = ?`).get(bookingReviewMatch[1]);
      if (!booking || (user.role === 'CLIENT' && booking.customerId !== user.id)) {
        sendJson(response, 404, { error: 'Booking not found.' });
        return;
      }
      const existing = await db.prepare('SELECT id, rating, comment FROM agency_reviews WHERE booking_id = ?').get(booking.id);
      if (method === 'DELETE') {
        if (!existing) { sendJson(response, 404, { error: 'This booking has no review.' }); return; }
        await db.prepare('DELETE FROM agency_reviews WHERE id = ?').run(existing.id);
        await audit(user.id, 'AGENCY_REVIEW_DELETED', `${booking.reference} (${booking.agencyId})`);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (!canReviewBooking(booking)) {
        sendJson(response, 409, { error: booking.state === 'ACCEPTED'
          ? `You can review this agency after your trip on ${booking.travelDate}.`
          : 'Only approved trips can be reviewed.' });
        return;
      }
      const body = await readJson(request);
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        sendJson(response, 400, { error: 'Choose a rating from 1 to 5 stars.' });
        return;
      }
      if (body.comment !== undefined && body.comment !== null && typeof body.comment !== 'string') {
        sendJson(response, 400, { error: 'Enter your review as text.' });
        return;
      }
      const comment = (body.comment || '').trim().replace(/\r\n/g, '\n');
      if (comment.length > 1000) {
        sendJson(response, 400, { error: 'Reviews cannot be longer than 1,000 characters.' });
        return;
      }
      const timestamp = nowIso();
      const reviewId = existing?.id || crypto.randomUUID();
      if (existing) {
        await db.prepare('UPDATE agency_reviews SET rating = ?, comment = ?, updated_at = ? WHERE id = ?')
          .run(rating, comment, timestamp, reviewId);
      } else {
        await db.prepare(`INSERT INTO agency_reviews (id, booking_id, agency_id, customer_id, rating, comment, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(reviewId, booking.id, booking.agencyId, user.id, rating, comment, timestamp, timestamp);
      }
      await audit(user.id, existing ? 'AGENCY_REVIEW_UPDATED' : 'AGENCY_REVIEW_CREATED', `${booking.reference} (${booking.agencyId}): ${rating}/5`);
      if (!existing) {
        const staffIds = await agencyStaffIds(booking.agencyId);
        await createNotifications(staffIds.map(staffId => ({
          recipientUserId: staffId, agencyId: booking.agencyId, bookingId: booking.id, type: 'REVIEW_RECEIVED',
          title: `New ${rating}-star review`,
          body: `${reviewerDisplayName(user.name)} reviewed booking ${booking.reference} (${booking.offerTitle})${comment ? `: “${comment.slice(0, 160)}”` : '.'}`,
          href: '/?agencyTab=REVIEWS', dedupeKey: `REVIEW_RECEIVED:${reviewId}:${staffId}`
        })));
      }
      publishCatalogChange('reviews');
      sendJson(response, existing ? 200 : 201, { review: { id: reviewId, bookingId: booking.id, rating, comment, updatedAt: timestamp } });
      return;
    }

    const reviewReplyMatch = pathname.match(/^\/api\/reviews\/([0-9a-f-]+)\/reply$/i);
    if (reviewReplyMatch && method === 'PUT') {
      if (!requireRole(response, user, ['AGENCY'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const review = await db.prepare(`SELECT r.id, r.agency_id AS agencyId, r.customer_id AS customerId, r.booking_id AS bookingId,
          r.agency_reply AS agencyReply, b.reference FROM agency_reviews r JOIN bookings b ON b.id = r.booking_id WHERE r.id = ?`).get(reviewReplyMatch[1]);
      if (!review || review.agencyId !== user.agency_id) {
        sendJson(response, 404, { error: 'Review not found.' });
        return;
      }
      const body = await readJson(request);
      const reply = typeof body.reply === 'string' ? body.reply.trim().replace(/\r\n/g, '\n') : '';
      if (reply.length > 1000) {
        sendJson(response, 400, { error: 'Replies cannot be longer than 1,000 characters.' });
        return;
      }
      const replyAt = reply ? nowIso() : null;
      await db.prepare('UPDATE agency_reviews SET agency_reply = ?, agency_reply_at = ? WHERE id = ?').run(reply || null, replyAt, review.id);
      await audit(user.id, reply ? 'AGENCY_REVIEW_REPLIED' : 'AGENCY_REVIEW_REPLY_REMOVED', `${review.reference} (${review.agencyId})`);
      if (reply && reply !== review.agencyReply && review.customerId) {
        const agency = await db.prepare('SELECT name FROM agencies WHERE id = ?').get(review.agencyId);
        await createNotifications([{
          recipientUserId: review.customerId, agencyId: review.agencyId, bookingId: review.bookingId, type: 'REVIEW_REPLY',
          title: `${agency?.name || 'The agency'} replied to your review`, body: reply.slice(0, 220),
          href: `/?booking=${encodeURIComponent(review.bookingId)}`, dedupeKey: `REVIEW_REPLY:${review.id}:${replyAt}`
        }]);
      }
      sendJson(response, 200, { review: { id: review.id, agencyReply: reply || null, agencyReplyAt: replyAt } });
      return;
    }

    const bookingActionMatch = pathname.match(/^\/api\/bookings\/([0-9a-f-]+)$/i);
    if (bookingActionMatch && ['PATCH', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['CLIENT', 'AGENCY', 'SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const bookingId = bookingActionMatch[1];
      const selectBooking = `SELECT id, reference AS ref, pnr, agency_id AS agencyId, offer_id AS offerId,
        cancellation_reason AS cancellationReason, customer_id AS customerId, traveler_name AS travelerName, traveler_email AS travelerEmail, phone,
        offer_title AS offerTitle, category, payment_provider AS paymentProvider, state, financials_json,
        seat_count AS seatCount, travel_date AS travelDate, created_at AS createdAtUtc, updated_at AS updatedAtUtc,
        refund_status AS refundStatus, refund_reference AS refundReference, refund_note AS refundNote, refunded_at AS refundedAt,
        (SELECT amount_cents FROM waafi_payments WHERE booking_id = bookings.id) AS paymentAmountCents,
        (SELECT currency FROM waafi_payments WHERE booking_id = bookings.id) AS paymentCurrency,
        (SELECT status FROM waafi_payments WHERE booking_id = bookings.id) AS paymentStatus,
        (SELECT transaction_id FROM waafi_payments WHERE booking_id = bookings.id) AS paymentTransactionId,
        (SELECT reference_id FROM waafi_payments WHERE booking_id = bookings.id) AS paymentReference,
        (SELECT status FROM phone_payments WHERE booking_id = bookings.id) AS phonePaymentStatus,
        (SELECT provider FROM phone_payments WHERE booking_id = bookings.id) AS phonePaymentProvider,
        (SELECT account_number FROM phone_payments WHERE booking_id = bookings.id) AS phonePaymentAccount,
        (SELECT amount_cents FROM phone_payments WHERE booking_id = bookings.id) AS phonePaymentAmountCents,
        (SELECT currency FROM phone_payments WHERE booking_id = bookings.id) AS phonePaymentCurrency,
        (SELECT transaction_id FROM phone_payments WHERE booking_id = bookings.id) AS phonePaymentTransactionId,
        (SELECT reference_id FROM phone_payments WHERE booking_id = bookings.id) AS phonePaymentReference,
        (SELECT CASE WHEN status = 'APPROVED' AND reference_id IS NOT NULL THEN 1 ELSE 0 END FROM phone_payments WHERE booking_id = bookings.id) AS phonePaymentVerified,
        (SELECT error_message FROM phone_payments WHERE booking_id = bookings.id) AS phonePaymentMessage,
        (SELECT started_at FROM phone_payments WHERE booking_id = bookings.id) AS phonePaymentStartedAt
        FROM bookings WHERE id = ?`;
      // A refund send that never finished (the server stopped mid-call) must be checked by hand, never resent blindly.
      await db.prepare(`UPDATE bookings SET refund_status = 'UNCONFIRMED',
          refund_note = 'The automatic refund did not finish. Check the merchant portal before sending again.'
        WHERE id = ? AND refund_status = 'SENDING' AND updated_at < ?`)
        .run(bookingId, new Date(Date.now() - phonePay.phonePaymentTimeoutMs() - 60_000).toISOString());
      const existing = await db.prepare(selectBooking).get(bookingId);
      if (!existing || (user.role === 'AGENCY' && existing.agencyId !== user.agency_id) ||
          (user.role === 'CLIENT' && existing.customerId !== user.id)) {
        sendJson(response, 404, { error: 'Booking request not found.' });
        return;
      }

      if (method === 'PATCH') {
        const body = await readJson(request);
        if (user.role === 'CLIENT' && body.action !== 'EDIT') {
          sendJson(response, 403, { error: 'Travelers can only edit their own pending booking details.' });
          return;
        }
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
            sendJson(response, 409, { error: 'Booking details can only be edited before the request is accepted or paid.' });
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
          const seatCount = body.seatCount === undefined ? existing.seatCount : Number(body.seatCount);
          if (!Number.isSafeInteger(seatCount) || seatCount < 1 || seatCount > 100000) {
            sendJson(response, 400, { error: 'Enter a number of seats from 1 to 100,000.' });
            return;
          }
          const travelDate = body.travelDate === undefined
            ? existing.travelDate
            : body.travelDate === '' ? null : requireString(body.travelDate, 'Travel date', 10);
          if (travelDate && (!isValidIsoDate(travelDate) || travelDate < new Date().toISOString().slice(0, 10))) {
            sendJson(response, 400, { error: 'Choose a valid future travel date.' });
            return;
          }
          const offer = existing.offerId
            ? await db.prepare(`SELECT p.agency_id AS agencyId, p.travel_date AS listedTravelDate,
                p.base_cents AS baseCents, p.tax_cents AS taxCents,
                p.supplier_commission_pct AS supplierCommissionPct, a.markup_pct AS agencyMarkupPct
              FROM catalog_products p JOIN agencies a ON a.id = p.agency_id WHERE p.id = ?`)
              .get(existing.offerId)
            : null;
          if (offer?.listedTravelDate && travelDate !== offer.listedTravelDate) {
            sendJson(response, 400, { error: 'Choose the travel date available for this listing.' });
            return;
          }
          if (seatCount !== existing.seatCount && !offer) {
            sendJson(response, 409, { error: 'Passenger count cannot be changed because this booking is not linked to an active trip listing.' });
            return;
          }
          let financials = JSON.parse(existing.financials_json);
          if (seatCount !== existing.seatCount) {
            const supplierCommissionCents = Math.round(offer.baseCents * offer.supplierCommissionPct / 100);
            const agencyCommissionCents = Math.round(offer.baseCents * offer.agencyMarkupPct / 100);
            const safarKaabeFeeCents = 1200;
            const subtotalCents = offer.baseCents + offer.taxCents + agencyCommissionCents + safarKaabeFeeCents;
            financials = {
              ...financials,
              supplierBaseCents: offer.baseCents * seatCount,
              supplierTaxesCents: offer.taxCents * seatCount,
              supplierCommissionCents: supplierCommissionCents * seatCount,
              agencyCommissionCents: agencyCommissionCents * seatCount,
              safarKaabeFeeCents: safarKaabeFeeCents * seatCount,
              paymentFeeCents: 0,
              customerGrandTotalCents: subtotalCents * seatCount,
              netPayableToSupplierCents: (offer.baseCents + offer.taxCents - supplierCommissionCents) * seatCount,
              recognizedPlatformRevenueCents: (safarKaabeFeeCents + supplierCommissionCents) * seatCount,
              agencyMarkupPct: offer.agencyMarkupPct
            };
          }
          const updated = await runInTransaction(async () => {
            const seatDelta = seatCount - existing.seatCount;
            if (seatDelta > 0) {
              const inventory = await db.prepare(`UPDATE catalog_products SET available = available - ?
                WHERE id = ? AND agency_id = ? AND available >= ? AND is_published = 1
                  AND (travel_date IS NULL OR travel_date >= date('now'))
                  AND EXISTS (SELECT 1 FROM agencies WHERE agencies.id = catalog_products.agency_id
                    AND agencies.status = 'ACTIVE' AND agencies.is_approved = 1)`)
                .run(seatDelta, existing.offerId, existing.agencyId, seatDelta);
              if (inventory.changes !== 1) return null;
            } else if (seatDelta < 0) {
              const inventory = await db.prepare('UPDATE catalog_products SET available = available + ? WHERE id = ? AND agency_id = ?')
                .run(-seatDelta, existing.offerId, existing.agencyId);
              if (inventory.changes !== 1) return null;
            }
            const changed = await db.prepare(`UPDATE bookings SET traveler_name = ?, traveler_email = ?, phone = ?,
              seat_count = ?, travel_date = ?, financials_json = ?, updated_at = ?
              WHERE id = ? AND state = 'REQUESTED' AND payment_provider = 'REQUEST_ONLY'`)
              .run(travelerName, travelerEmail, phone, seatCount, travelDate, JSON.stringify(financials), nowIso(), bookingId);
            if (changed.changes !== 1) {
              throw Object.assign(new Error('This request has changed. Refresh the bookings list and try again.'), { statusCode: 409 });
            }
            return true;
          });
          if (!updated) {
            sendJson(response, 409, { error: 'This request has changed. Refresh the bookings list and try again.' });
            return;
          }
          await audit(user.id, 'BOOKING_UPDATED', `${existing.ref} (${existing.agencyId})`);
          if (seatCount !== existing.seatCount) publishCatalogChange('availability');
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
        } else if (body.action === 'CONFIRM_PHONE_PAYMENT' || body.action === 'REJECT_PHONE_PAYMENT') {
          if (existing.phonePaymentStatus !== 'UNKNOWN' || existing.state !== 'PAYMENT_PENDING') {
            sendJson(response, 409, { error: 'This booking has no phone payment waiting to be checked.' });
            return;
          }
          const payment = await loadPhonePayment(bookingId);
          const confirm = body.action === 'CONFIRM_PHONE_PAYMENT';
          // The PIN prompt can still be live on the traveler's phone after we stop waiting, so a payment can only be
          // marked "not received" once any provider prompt has certainly expired.
          const startedMs = Date.parse(payment.startedAt || payment.updatedAt || '');
          const waitLeftMs = Number.isFinite(startedMs) ? startedMs + phoneRejectWaitMs - Date.now() : 0;
          if (!confirm && waitLeftMs > 0) {
            const minutes = Math.max(1, Math.ceil(waitLeftMs / 60_000));
            sendJson(response, 409, { error: `The traveler may still be approving this payment. Check the merchant portal again in ${minutes} minute${minutes === 1 ? '' : 's'} before marking it as not received.`, retryAfterMinutes: minutes });
            return;
          }
          const transactionId = typeof body.transactionId === 'string' && body.transactionId.trim()
            ? body.transactionId.trim().slice(0, 80) : payment.transactionId || null;
          const updatedAt = nowIso();
          const resolved = await runInTransaction(async () => {
            await lockBookingRow(bookingId);
            const changed = await db.prepare(`UPDATE phone_payments SET status = ?, transaction_id = ?, reference_id = NULL, error_message = ?, updated_at = ?
              WHERE booking_id = ? AND status = 'UNKNOWN'`)
              .run(confirm ? 'APPROVED' : 'FAILED', transactionId, confirm ? null : 'The agency found no payment in the merchant portal.', updatedAt, bookingId);
            if (changed.changes !== 1) return false;
            if (confirm) {
              const paid = await db.prepare("UPDATE bookings SET state = 'PAYMENT_RECEIVED', updated_at = ? WHERE id = ? AND state = 'PAYMENT_PENDING'")
                .run(updatedAt, bookingId);
              if (paid.changes !== 1) throw Object.assign(new Error('This booking has changed. Refresh the bookings list and try again.'), { statusCode: 409 });
              return true;
            }
            if (!await releasePendingPaymentBooking(bookingId, 'The agency found no phone payment for this booking')) {
              throw Object.assign(new Error('This booking has changed. Refresh the bookings list and try again.'), { statusCode: 409 });
            }
            return true;
          });
          if (!resolved) {
            sendJson(response, 409, { error: 'This payment was already checked. Refresh the bookings list.' });
            return;
          }
          await audit(user.id, confirm ? 'PHONE_PAYMENT_CONFIRMED_BY_AGENCY' : 'PHONE_PAYMENT_REJECTED_BY_AGENCY',
            `${existing.ref} (${existing.agencyId}) ${payment.provider} ${transactionId || ''}`);
          if (!confirm) publishCatalogChange('availability');
          await notifyPhonePayment(payment, confirm ? 'APPROVED' : 'AGENCY_REJECTED');
        } else if (body.action === 'SEND_REFUND') {
          if (existing.refundStatus !== 'NEEDED') {
            sendJson(response, 409, { error: existing.refundStatus === 'SENDING'
              ? 'This refund is being sent right now. Refresh the bookings list in a minute.'
              : 'This booking has no refund waiting to be sent.' });
            return;
          }
          // Refunds are paid from the platform's merchant wallet, so they only go back to the number that paid,
          // and only for a payment the provider itself confirmed. Anything else is sent by hand and recorded.
          if (existing.phonePaymentStatus !== 'APPROVED' || !existing.phonePaymentReference) {
            sendJson(response, 409, { error: existing.phonePaymentStatus === 'APPROVED'
              ? 'This payment was confirmed by hand, not by the payment provider, so it cannot be refunded automatically. Send the refund yourself and record its reference.'
              : 'Only a phone payment can be refunded automatically. Send the refund yourself and record its reference.' });
            return;
          }
          const paidPhone = phonePay.normalizeSomaliPhone(existing.phonePaymentAccount || '');
          const phoneSupplied = typeof body.phoneNumber === 'string' && body.phoneNumber.trim() !== '';
          const requestedPhone = phoneSupplied ? phonePay.normalizeSomaliPhone(body.phoneNumber) : paidPhone;
          const requestedProvider = typeof body.provider === 'string' && body.provider ? body.provider.toUpperCase() : existing.phonePaymentProvider;
          if (!requestedPhone) {
            sendJson(response, 400, { error: 'Enter the mobile money number to send the refund to, for example 61 234 5678.' });
            return;
          }
          if (user.role !== 'SUPER_ADMIN' && (requestedPhone !== paidPhone || requestedProvider !== existing.phonePaymentProvider)) {
            sendJson(response, 403, { error: `Automatic refunds can only go back to the number that paid (${paidPhone}). To refund a different number, send it yourself and record its reference, or ask SAFAR KAABE support.` });
            return;
          }
          const rawProvider = requestedProvider || 'WAAFI';
          const provider = ['WAAFI', 'EDAHAB'].includes(rawProvider) ? rawProvider : null;
          if (!provider) {
            sendJson(response, 400, { error: 'Choose EVC Plus, Zaad, Sahal or eDahab for the refund.' });
            return;
          }
          if (!phonePay.providerConfig(provider)) {
            sendJson(response, 503, { error: `Automatic refunds with ${phonePay.providerLabel(provider)} are not set up. Send the refund yourself and record its reference.` });
            return;
          }
          const refundPhone = requestedPhone;
          if (!refundPhone) {
            sendJson(response, 400, { error: 'Enter the mobile money number to send the refund to, for example 61 234 5678.' });
            return;
          }
          const financials = JSON.parse(existing.financials_json || '{}');
          const amountCents = Number(existing.phonePaymentAmountCents ?? existing.paymentAmountCents ?? financials.customerGrandTotalCents);
          const currency = existing.phonePaymentCurrency || existing.paymentCurrency || 'USD';
          if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
            sendJson(response, 409, { error: 'The refund amount could not be worked out. Send it yourself and record its reference.' });
            return;
          }
          // Claim the refund first so it can never be sent twice.
          const claimed = await db.prepare(`UPDATE bookings SET refund_status = 'SENDING', refund_note = NULL, updated_at = ?
            WHERE id = ? AND agency_id = ? AND refund_status = 'NEEDED'`).run(nowIso(), bookingId, existing.agencyId);
          if (claimed.changes !== 1) {
            sendJson(response, 409, { error: 'This refund is already being sent or was recorded. Refresh the bookings list.' });
            return;
          }
          const amountText = `${(amountCents / 100).toFixed(2)} ${currency}`;
          await audit(user.id, 'BOOKING_REFUND_SEND_STARTED', `${existing.ref} (${existing.agencyId}): ${amountText} to ${refundPhone} via ${provider}`);
          let result;
          try {
            result = await phonePay.creditPhone({ provider, accountNumber: refundPhone, amountCents, currency, description: `SAFAR KAABE refund ${existing.ref}` });
          } catch (error) {
            await db.prepare("UPDATE bookings SET refund_status = 'NEEDED', updated_at = ? WHERE id = ? AND refund_status = 'SENDING'").run(nowIso(), bookingId);
            throw error;
          }
          const finishedAt = nowIso();
          let refundMessage;
          if (result.outcome === 'APPROVED') {
            const refundReference = result.transactionId || result.referenceId || 'Sent automatically';
            const refundNote = `Sent automatically to ${refundPhone} (${phonePay.providerLabel(provider)}).`;
            await db.prepare(`UPDATE bookings SET refund_status = 'REFUNDED', refund_reference = ?, refund_note = ?, refunded_at = ?, updated_at = ?
              WHERE id = ? AND refund_status = 'SENDING'`).run(refundReference, refundNote, finishedAt, finishedAt, bookingId);
            await audit(user.id, 'BOOKING_REFUND_SENT', `${existing.ref} (${existing.agencyId}): ${amountText} to ${refundPhone} via ${provider}, ${refundReference}`);
            await notifyRefundSent({ ...existing, id: bookingId }, amountCents, currency, refundReference, refundNote);
            refundMessage = `Refund of ${amountText} sent to ${refundPhone}. Reference: ${refundReference}.`;
          } else if (result.outcome === 'FAILED') {
            const refundNote = `Automatic refund failed: ${result.reason}`;
            await db.prepare(`UPDATE bookings SET refund_status = 'NEEDED', refund_note = ?, updated_at = ? WHERE id = ? AND refund_status = 'SENDING'`)
              .run(refundNote, finishedAt, bookingId);
            await audit(user.id, 'BOOKING_REFUND_SEND_FAILED', `${existing.ref} (${existing.agencyId}): ${result.errorCode || ''} ${result.reason}`);
            refundMessage = `The refund was not sent: ${result.reason} No money left your account. You can try again or send it yourself.`;
          } else {
            const refundNote = `${result.reason} Check the ${phonePay.providerPortal(provider)} merchant portal to see if ${amountText} reached ${refundPhone}, then record the refund.`;
            await db.prepare(`UPDATE bookings SET refund_status = 'UNCONFIRMED', refund_note = ?, updated_at = ? WHERE id = ? AND refund_status = 'SENDING'`)
              .run(refundNote, finishedAt, bookingId);
            await audit(user.id, 'BOOKING_REFUND_SEND_UNCONFIRMED', `${existing.ref} (${existing.agencyId}): ${result.errorCode || ''}`);
            refundMessage = `We could not confirm the refund. ${refundNote} Do not send it again until you have checked.`;
          }
          const refundedBooking = await db.prepare(selectBooking).get(bookingId);
          const { financials_json: refundedFinancials, ...refundedRest } = refundedBooking;
          sendJson(response, 200, { booking: { ...refundedRest, financials: JSON.parse(refundedFinancials) },
            refund: { outcome: result.outcome, message: refundMessage } });
          return;
        } else if (body.action === 'MARK_REFUNDED') {
          if (!['NEEDED', 'UNCONFIRMED'].includes(existing.refundStatus)) {
            sendJson(response, 409, { error: existing.refundStatus === 'SENDING'
              ? 'This refund is being sent right now. Refresh the bookings list in a minute.'
              : 'This booking has no refund waiting to be sent.' });
            return;
          }
          const refundReference = requireString(body.refundReference, 'Refund reference', 80);
          const refundNote = typeof body.refundNote === 'string' ? body.refundNote.trim().replace(/\s+/g, ' ').slice(0, 300) : '';
          const refundedAt = nowIso();
          const refunded = await db.prepare(`UPDATE bookings SET refund_status = 'REFUNDED', refund_reference = ?, refund_note = ?, refunded_at = ?, updated_at = ?
            WHERE id = ? AND agency_id = ? AND refund_status IN ('NEEDED', 'UNCONFIRMED')`)
            .run(refundReference, refundNote || null, refundedAt, refundedAt, bookingId, existing.agencyId);
          if (refunded.changes !== 1) {
            sendJson(response, 409, { error: 'This refund was already recorded. Refresh the bookings list.' });
            return;
          }
          await audit(user.id, 'BOOKING_REFUND_RECORDED', `${existing.ref} (${existing.agencyId}): ${refundReference}`);
          const financials = JSON.parse(existing.financials_json || '{}');
          await notifyRefundSent({ ...existing, id: bookingId }, existing.phonePaymentAmountCents ?? existing.paymentAmountCents ?? financials.customerGrandTotalCents,
            existing.phonePaymentCurrency || existing.paymentCurrency || 'USD', refundReference, refundNote);
        } else {
          sendJson(response, 400, { error: 'Choose accept, undo acceptance, edit, reject, restore, check a phone payment, or record a refund for this booking.' });
          return;
        }

        const updatedBooking = await db.prepare(selectBooking).get(bookingId);
        const { financials_json, ...booking } = updatedBooking;
        sendJson(response, 200, { booking: { ...booking, financials: JSON.parse(financials_json) }, ticket: generatedTicket, ticketError });
        return;
      }

      const phonePaymentOpen = existing.phonePaymentStatus === 'UNKNOWN' ||
        (existing.phonePaymentStatus === 'PENDING' && Boolean(existing.phonePaymentStartedAt));
      if (existing.state === 'PAYMENT_PENDING' && phonePaymentOpen) {
        sendJson(response, 409, { error: user.role === 'CLIENT'
          ? 'Your phone payment is still being checked, so this booking cannot be deleted yet. Message the agency if you need help.'
          : 'This phone payment has not been checked yet. Use "Payment received" or "Payment not received" first.' });
        return;
      }
      const phonePaid = existing.phonePaymentStatus === 'APPROVED';
      const isNewUnpaidRequest = (existing.state === 'REQUESTED' && existing.paymentProvider === 'REQUEST_ONLY') ||
        (existing.state === 'PAYMENT_PENDING' && existing.paymentStatus !== 'APPROVED' && !phonePaid);
      const isAcceptedBooking = existing.state === 'ACCEPTED' || (existing.state === 'PAYMENT_RECEIVED' && phonePaid);
      if (user.role === 'CLIENT' && !isNewUnpaidRequest) {
        sendJson(response, 409, { error: 'Only a pending unpaid booking request can be deleted. Contact the agency to cancel an approved or paid trip.' });
        return;
      }
      if (!isNewUnpaidRequest && !isAcceptedBooking) {
        sendJson(response, 409, { error: 'Only an open request or an accepted booking can be canceled here.' });
        return;
      }
      const body = await readJson(request);
      const reason = requireString(body.reason, 'Cancellation reason', 500).replace(/\s+/g, ' ');
      if (existing.state === 'PAYMENT_PENDING' && existing.paymentReference) {
        let checked;
        try {
          checked = await refreshWaafiPayment(existing.paymentReference);
        } catch {
          sendJson(response, 409, { error: 'We could not confirm with WaafiPay whether this payment went through. Try again in a few minutes.' });
          return;
        }
        if (checked?.status === 'APPROVED') {
          sendJson(response, 409, { error: 'WaafiPay has confirmed this payment, so the booking cannot be deleted here. Refresh the bookings list.' });
          return;
        }
        if (checked?.status === 'DECLINED') {
          sendJson(response, 200, { ok: true, message: 'The payment was not completed, so this request was cancelled and its seats are available again.', seatsReturned: true });
          return;
        }
      }
      if (body.returnSeats !== undefined && typeof body.returnSeats !== 'boolean') {
        sendJson(response, 400, { error: 'Choose whether the seats can return to inventory.' });
        return;
      }
      const paymentReceived = existing.paymentStatus === 'APPROVED' || phonePaid;
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
        await lockBookingRow(bookingId);
        const canceledBooking = await db.prepare(`UPDATE bookings SET state = 'CANCELLED', cancellation_reason = ?, updated_at = ?,
            refund_status = CASE WHEN ? = 1 THEN 'NEEDED' ELSE refund_status END
          WHERE id = ? AND agency_id = ? AND state = ? AND payment_provider = ?
            AND (? = 1 OR NOT EXISTS (SELECT 1 FROM waafi_payments WHERE booking_id = bookings.id AND status = 'APPROVED'))
            AND (? = 1 OR NOT EXISTS (SELECT 1 FROM phone_payments WHERE booking_id = bookings.id
              AND (status IN ('APPROVED', 'UNKNOWN') OR (status = 'PENDING' AND started_at IS NOT NULL))))
          RETURNING seat_count AS seatCount`)
          .get(reason, nowIso(), paymentReceived ? 1 : 0, bookingId, existing.agencyId, existing.state, existing.paymentProvider, paymentReceived ? 1 : 0, paymentReceived ? 1 : 0);
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
          ? 'Booking canceled and seats returned. Send the refund to the traveler, then tap "Record refund" on this booking.'
          : 'Booking canceled and the seats stay reserved. Send the refund to the traveler, then tap "Record refund" on this booking.'
        : 'Request canceled. Its seats are available again.';
      sendJson(response, 200, { ok: true, message, ...canceled });
      return;
    }

    if (pathname === '/api/reports/sales' && method === 'GET') {
      if (!requireRole(response, user, ['SUPER_ADMIN', 'AGENCY'])) return;
      const today = new Date().toISOString().slice(0, 10);
      const defaultFrom = new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);
      const from = url.searchParams.get('from') || defaultFrom;
      const to = url.searchParams.get('to') || today;
      if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) {
        sendJson(response, 400, { error: 'Choose a valid start and end date. The start date must be before the end date.' });
        return;
      }
      const agencyFilter = user.role === 'AGENCY' ? user.agency_id : (url.searchParams.get('agencyId') || null);
      const rows = await db.prepare(`
        SELECT b.reference, b.created_at AS "createdAt", b.travel_date AS "travelDate", b.offer_title AS "offerTitle",
               b.category, b.traveler_name AS "travelerName", b.phone, b.seat_count AS "seatCount", b.state,
               b.payment_provider AS "paymentProvider", b.financials_json AS "financialsJson",
               b.refund_status AS "refundStatus", b.refund_reference AS "refundReference", a.name AS "agencyName",
               COALESCE(w.status, pp.status) AS "paymentStatus", COALESCE(w.amount_cents, pp.amount_cents) AS "paidCents",
               pp.provider AS "phoneProvider"
        FROM bookings b
        JOIN agencies a ON a.id = b.agency_id
        LEFT JOIN waafi_payments w ON w.booking_id = b.id
        LEFT JOIN phone_payments pp ON pp.booking_id = b.id
        WHERE b.created_at >= ? AND b.created_at < ? ${agencyFilter ? 'AND b.agency_id = ?' : ''}
        ORDER BY b.created_at DESC`).all(`${from}T00:00:00.000Z`, `${nextIsoDate(to)}T00:00:00.000Z`, ...(agencyFilter ? [agencyFilter] : []));
      const stateLabels = { REQUESTED: 'New request', PAYMENT_PENDING: 'Waiting for payment', PAYMENT_RECEIVED: 'Paid - needs confirmation',
        ACCEPTED: 'Confirmed', REJECTED: 'Declined', CANCELLED: 'Cancelled' };
      const sold = new Set(['ACCEPTED', 'PAYMENT_RECEIVED']);
      const bookings = rows.map(row => {
        let totalCents = 0;
        try { totalCents = Number(JSON.parse(row.financialsJson).customerGrandTotalCents) || 0; } catch {}
        const { financialsJson, ...rest } = row;
        return { ...rest, seatCount: Number(row.seatCount), totalCents, paidOnline: row.paymentStatus === 'APPROVED' };
      });
      const refundLabels = { NEEDED: 'Refund needed', SENDING: 'Refund being sent', UNCONFIRMED: 'Refund to check', REFUNDED: 'Refunded' };
      const paymentLabel = item => item.paymentProvider === 'WAAFI' ? `WaafiPay (${item.paymentStatus || 'not started'})`
        : item.paymentProvider === 'PHONE' ? `Pay by phone - ${phonePay.providerLabel(item.phoneProvider)} (${item.paymentStatus || 'not started'})`
        : 'Pay the agency directly';
      bookings.forEach(item => {
        if (!item.phoneProvider) delete item.phoneProvider;
      });
      if (url.searchParams.get('format') === 'csv') {
        const header = ['Booking number', 'Booked on', 'Travel date', 'Trip', 'Type', 'Agency', 'Traveler', 'Phone', 'Seats', 'Status',
          'Payment', 'Total (USD)', 'Paid online (USD)', 'Refund', 'Refund reference'];
        const lines = [header, ...bookings.map(item => [item.reference, item.createdAt.slice(0, 10), item.travelDate || '', item.offerTitle, item.category,
          item.agencyName, item.travelerName, item.phone, item.seatCount, stateLabels[item.state] || item.state,
          paymentLabel(item),
          (item.totalCents / 100).toFixed(2), item.paidOnline ? (Number(item.paidCents) / 100).toFixed(2) : '0.00',
          refundLabels[item.refundStatus] || '', item.refundReference || ''])];
        const csv = '﻿' + lines.map(line => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="safar-kaabe-sales-${from}-to-${to}.csv"`,
          'Cache-Control': 'no-store'
        }).end(csv);
        return;
      }
      const emptyTotals = () => ({ requests: 0, confirmed: 0, cancelled: 0, seatsSold: 0, salesCents: 0, paidOnlineCents: 0 });
      const add = (totals, item) => {
        totals.requests += 1;
        if (sold.has(item.state)) { totals.confirmed += 1; totals.seatsSold += item.seatCount; totals.salesCents += item.totalCents; }
        if (item.state === 'CANCELLED' || item.state === 'REJECTED') totals.cancelled += 1;
        if (item.paidOnline) totals.paidOnlineCents += Number(item.paidCents) || 0;
        return totals;
      };
      const totals = emptyTotals();
      const byTrip = new Map();
      const byMonth = new Map();
      for (const item of bookings) {
        add(totals, item);
        if (!byTrip.has(item.offerTitle)) byTrip.set(item.offerTitle, { trip: item.offerTitle, ...emptyTotals() });
        add(byTrip.get(item.offerTitle), item);
        const month = item.createdAt.slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, { month, ...emptyTotals() });
        add(byMonth.get(month), item);
      }
      sendJson(response, 200, {
        from, to, totals,
        refundsNeeded: bookings.filter(item => ['NEEDED', 'UNCONFIRMED'].includes(item.refundStatus)).length,
        byTrip: [...byTrip.values()].sort((a, b) => b.salesCents - a.salesCents || b.requests - a.requests),
        byMonth: [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month))
      });
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
          b.refund_status AS refundStatus, b.refund_reference AS refundReference, b.refund_note AS refundNote, b.refunded_at AS refundedAt,
          (SELECT status FROM waafi_payments WHERE booking_id = b.id) AS paymentStatus,
          (SELECT transaction_id FROM waafi_payments WHERE booking_id = b.id) AS paymentTransactionId,
          (SELECT reference_id FROM waafi_payments WHERE booking_id = b.id) AS paymentReference,
          pp.status AS phonePaymentStatus, pp.provider AS phonePaymentProvider, pp.account_number AS phonePaymentAccount,
          pp.amount_cents AS phonePaymentAmountCents, pp.transaction_id AS phonePaymentTransactionId,
          pp.error_message AS phonePaymentMessage, pp.started_at AS phonePaymentStartedAt,
          CASE WHEN pp.status = 'APPROVED' AND pp.reference_id IS NOT NULL THEN 1 ELSE 0 END AS phonePaymentVerified,
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
          d.email_delivery_status AS ticketEmailStatus, d.email_sent_at AS ticketEmailSentAt,
          r.id AS reviewId, r.rating AS reviewRating, r.comment AS reviewComment,
          r.agency_reply AS reviewReply, r.agency_reply_at AS reviewReplyAt, r.updated_at AS reviewUpdatedAt
        FROM bookings b
        JOIN agencies a ON a.id = b.agency_id
        LEFT JOIN catalog_products c ON c.id = b.offer_id
        LEFT JOIN booking_documents d ON d.booking_id = b.id AND d.document_type = 'BOOKING_CONFIRMATION'
        LEFT JOIN agency_reviews r ON r.booking_id = b.id
        LEFT JOIN phone_payments pp ON pp.booking_id = b.id
        ${bookingScope}
        ORDER BY b.created_at DESC
      `).all(...bookingScopeValue);
      const today = new Date().toISOString().slice(0, 10);
      sendJson(response, 200, { bookings: records.map(({ financials_json, ...booking }) => ({
        ...booking,
        reviewRating: booking.reviewRating === null || booking.reviewRating === undefined ? null : Number(booking.reviewRating),
        reviewEligible: user.role === 'CLIENT' && booking.customerId === user.id && canReviewBooking(booking, today),
        financials: JSON.parse(financials_json)
      })) });
      return;
    }

    if (pathname === '/api/bookings' && method === 'POST') {
      if (user) {
        if (!requireRole(response, user, ['CLIENT', 'AGENCY', 'SUPER_ADMIN'])) return;
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
      const adminCustomer = user?.role === 'SUPER_ADMIN'
        ? await db.prepare("SELECT id, name, email, phone FROM users WHERE id = ? AND role = 'CLIENT'").get(requireString(body.customerId, 'Traveler'))
        : null;
      if (user?.role === 'SUPER_ADMIN' && !adminCustomer) {
        sendJson(response, 404, { error: 'Choose an existing traveler account for this booking.' });
        return;
      }
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
        sendJson(response, 409, { error: `Only ${offer.available} ${offer.available === 1 ? 'seat is' : 'seats are'} left for this trip. Choose fewer seats or another trip.`,
          availableSeats: Number(offer.available), waitlistAvailable: user?.role === 'CLIENT' });
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
      if (!['REQUEST_ONLY', 'WAAFI', 'PHONE'].includes(paymentMethod)) {
        sendJson(response, 400, { error: 'Choose a valid booking request option.' });
        return;
      }
      let phoneWallet = null;
      let phoneAccount = null;
      if (paymentMethod === 'PHONE') {
        const rawWallet = String(body.wallet || 'WAAFI').toUpperCase();
        phoneWallet = ['EDAHAB'].includes(rawWallet) ? 'EDAHAB' : ['WAAFI', 'EVC', 'EVC_PLUS', 'ZAAD', 'SAHAL'].includes(rawWallet) ? 'WAAFI' : null;
        if (!phoneWallet) {
          sendJson(response, 400, { error: 'Choose EVC Plus, Zaad, Sahal or eDahab.' });
          return;
        }
        if (user?.role !== 'CLIENT' || !phonePay.providerConfig(phoneWallet)) {
          sendJson(response, 503, { error: `Paying with ${phonePay.providerLabel(phoneWallet)} is not available right now. Choose another option.` });
          return;
        }
        phoneAccount = phonePay.normalizeSomaliPhone(body.paymentPhone ?? body.phone);
        if (!phoneAccount) {
          sendJson(response, 400, { error: 'Enter the mobile money number that will pay, for example 61 234 5678 or +252 61 234 5678.' });
          return;
        }
        if (!await allowRateLimitRequest(`phone-booking:${user.id}`, 60 * 60 * 1000, 12)) {
          sendJson(response, 429, { error: 'Too many pay-by-phone bookings were started. Wait an hour, or finish or cancel an earlier booking first.' }, { 'Retry-After': '3600' });
          return;
        }
      }
      if (paymentMethod === 'WAAFI' && (user?.role !== 'CLIENT' || !getWaafiConfig())) {
        sendJson(response, 503, { error: 'Online checkout is unavailable for this account. Choose a booking request or contact support.' });
        return;
      }
      const travelerName = requireString(body.travelerName || adminCustomer?.name, 'Traveler name');
      const travelerEmail = user?.role === 'CLIENT'
        ? normalizeEmail(body.travelerEmail || user.email)
        : normalizeEmail(body.travelerEmail || adminCustomer?.email || '');
      const phone = requireString(body.phone || adminCustomer?.phone, 'Phone', 40);
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
        customerId: user?.role === 'CLIENT' ? user.id : user?.role === 'SUPER_ADMIN' ? adminCustomer.id : null,
        travelerName,
        travelerEmail,
        phone,
        offerTitle: offer.title,
        category: offer.category,
        paymentProvider: paymentMethod === 'WAAFI' ? 'WAAFI' : paymentMethod === 'PHONE' ? 'PHONE' : 'REQUEST_ONLY',
        state: ['WAAFI', 'PHONE'].includes(paymentMethod) ? 'PAYMENT_PENDING' : 'REQUESTED',
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
        sendJson(response, 409, { error: `Only ${availableSeats} ${availableSeats === 1 ? 'seat is' : 'seats are'} left for this trip. Choose fewer seats or another trip.`,
          availableSeats, waitlistAvailable: user?.role === 'CLIENT' });
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
          publishCatalogChange('availability');
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
        if (phoneWallet) {
          await db.prepare(`INSERT INTO phone_payments (id, booking_id, provider, account_number, amount_cents, currency, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'USD', 'PENDING', ?, ?)`)
            .run(crypto.randomUUID(), booking.id, phoneWallet, phoneAccount, booking.financials.customerGrandTotalCents, createdAtUtc, createdAtUtc);
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
        publishCatalogChange('availability');
        throw error;
      }
      const bookingDeliveries = [];
      for (const notification of bookingNotifications) {
        publishNotification(notification.recipientUserId, notification);
        bookingDeliveries.push(deliverWebPush(notification.recipientUserId, notification).catch(error => console.warn('Web push notification failed:', error.message)));
        bookingDeliveries.push(deliverNativePush(notification.recipientUserId, notification).catch(error => console.warn('Android push notification failed:', error.message)));
      }
      await Promise.allSettled(bookingDeliveries);
      await audit(user?.id || null, paymentStart ? 'WAAFI_CHECKOUT_STARTED' : phoneWallet ? 'PHONE_CHECKOUT_STARTED' : 'BOOKING_REQUESTED', `${booking.reference} (${booking.agencyId})`);
      if (user?.role === 'CLIENT') await db.prepare('DELETE FROM trip_waitlist WHERE offer_id = ? AND user_id = ?').run(offer.id, user.id);
      publishCatalogChange('availability');
      sendJson(response, 201, { booking: { ...booking, ref: booking.reference, createdAtUtc,
        paymentStatus: paymentStart ? 'PENDING' : null, paymentReference: paymentStart?.referenceId || null,
        phonePaymentStatus: phoneWallet ? 'PENDING' : null, phonePaymentProvider: phoneWallet, phonePaymentAccount: phoneAccount,
        conversationId: bookingConversationId },
        phonePayment: phoneWallet ? { provider: phoneWallet, providerLabel: phonePay.providerLabel(phoneWallet), accountNumber: phoneAccount,
          amountCents: booking.financials.customerGrandTotalCents, currency: 'USD', status: 'PENDING' } : null,
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

    if (pathname === '/api/admin/customers' && method === 'POST') {
      if (!requireRole(response, user, ['SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const body = await readJson(request);
      const name = requireString(body.name, 'Traveler name');
      const email = normalizeEmail(body.email);
      const phone = requireString(body.phone, 'Phone number', 40);
      const password = validatePassword(body.password || '');
      const credentials = await hashPassword(password);
      const customer = { id: crypto.randomUUID(), name, email, phone, createdAt: nowIso() };
      try {
        await db.prepare('INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(customer.id, customer.email, customer.name, customer.phone, credentials.salt, credentials.hash, 'CLIENT', customer.createdAt);
      } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed')) {
          sendJson(response, 409, { error: 'A traveler account with that email already exists.' });
          return;
        }
        throw error;
      }
      await audit(user.id, 'CLIENT_ACCOUNT_CREATED', `${name} (${email})`);
      sendJson(response, 201, { customer });
      return;
    }

    const adminCustomerMatch = pathname.match(/^\/api\/admin\/customers\/([0-9a-f-]+)$/i);
    if (adminCustomerMatch && ['PATCH', 'DELETE'].includes(method)) {
      if (!requireRole(response, user, ['SUPER_ADMIN'])) return;
      if (!authorizeMutation(request, response, session)) return;
      const customer = await db.prepare("SELECT id, name, email, phone, password_hash, password_salt FROM users WHERE id = ? AND role = 'CLIENT'").get(adminCustomerMatch[1]);
      if (!customer) {
        sendJson(response, 404, { error: 'Traveler account not found.' });
        return;
      }
      if (method === 'PATCH') {
        const body = await readJson(request);
        const name = body.name === undefined ? customer.name : requireString(body.name, 'Traveler name');
        const phone = body.phone === undefined ? customer.phone : requireString(body.phone, 'Phone number', 40);
        const email = body.email === undefined ? customer.email : normalizeEmail(body.email);
        const password = body.password === undefined ? null : validatePassword(body.password);
        const currentEmail = customer.email;
        try {
          if (password) {
            const credentials = await hashPassword(password);
            await db.prepare('UPDATE users SET email = ?, name = ?, phone = ?, password_salt = ?, password_hash = ? WHERE id = ?')
              .run(email, name, phone, credentials.salt, credentials.hash, customer.id);
          } else {
            await db.prepare('UPDATE users SET email = ?, name = ?, phone = ? WHERE id = ?')
              .run(email, name, phone, customer.id);
          }
        } catch (error) {
          if (String(error.message).includes('UNIQUE constraint failed')) {
            sendJson(response, 409, { error: 'A traveler account with that email already exists.' });
            return;
          }
          throw error;
        }
        await audit(user.id, 'CLIENT_ACCOUNT_UPDATED', `${name} (${currentEmail} → ${email})`);
        const updated = await db.prepare("SELECT id, name, email, phone, avatar_mime AS avatarMime, avatar_data AS avatarData, created_at AS createdAt FROM users WHERE id = ? AND role = 'CLIENT'").get(customer.id);
        sendJson(response, 200, { customer: updated });
        return;
      }
      await db.prepare("DELETE FROM users WHERE id = ? AND role = 'CLIENT'").run(customer.id);
      await audit(user.id, 'CLIENT_ACCOUNT_DELETED', `${customer.name} (${customer.email})`);
      sendJson(response, 200, { ok: true });
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

    sendJson(response, 404, { error: 'This page or action is not available. Refresh the app and try again.' });
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
    const headers = {
      'Content-Type': mimeType(filePath),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ['the style.html', 'sw.js'].includes(path.basename(filePath)) ? 'no-cache' : 'public, max-age=3600'
    };
    const isVideo = path.extname(filePath).toLowerCase() === '.mp4';
    const range = isVideo ? request.headers.range : null;
    if (isVideo) headers['Accept-Ranges'] = 'bytes';
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start;
      let end;
      if (match && (match[1] || match[2])) {
        if (!match[1]) {
          const suffixLength = Number(match[2]);
          if (Number.isSafeInteger(suffixLength) && suffixLength > 0) {
            start = Math.max(stats.size - suffixLength, 0);
            end = stats.size - 1;
          }
        } else {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : stats.size - 1;
        }
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= stats.size || end < start) {
        response.writeHead(416, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${stats.size}` }).end();
        return;
      }
      end = Math.min(end, stats.size - 1);
      response.writeHead(206, {
        ...headers,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stats.size}`
      });
      fs.createReadStream(filePath, { start, end }).pipe(response);
      return;
    }
    if (isVideo) headers['Content-Length'] = stats.size;
    response.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(response);
  });
}

const appFrameAncestors = (process.env.APP_FRAME_ANCESTORS || "'self' https://anfacmedia.com https://*.anfacmedia.com")
  .replace(/[;\r\n]/g, ' ').trim();

async function handleRequest(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  // Only the app itself and the ANFAC Media website may show the app inside a page (stops clickjacking elsewhere).
  response.setHeader('Content-Security-Policy', `frame-ancestors ${appFrameAncestors}`);
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
