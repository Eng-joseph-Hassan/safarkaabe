const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { SMTPServer } = require('smtp-server');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function cookieJar(response) {
  return (response.headers.getSetCookie?.() || [])
    .map(cookie => cookie.split(';', 1)[0])
    .join('; ');
}

function csrfToken(cookie) {
  const value = cookie.split('; ').find(part => part.startsWith('sk_csrf='));
  return value ? value.slice('sk_csrf='.length) : '';
}

test('server authentication, role boundaries, agency CRM and booking ownership', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safar-kaabe-test-'));
  const deliveredEmails = [];
  let failNextEmail = false;
  const waafiProviderRequests = [];
  const waafiPurchases = new Map();
  let waafiPaymentStatus = 'PENDING';
  let waafiPaymentCurrency = null;
  const waafiServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    waafiProviderRequests.push(body);
    const params = body.serviceParams;
    if (body.serviceName === 'HPP_PURCHASE') {
      waafiPurchases.set(params.transactionInfo.referenceId, params.transactionInfo);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        responseCode: '2001',
        params: { referenceId: params.transactionInfo.referenceId, hppUrl: 'https://checkout.example.test/session', orderId: 'test-order' }
      }));
      return;
    }
    if (body.serviceName === 'HPP_GETTRANINFO') {
      const transaction = waafiPurchases.get(params.referenceId);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        responseCode: '2001',
        params: {
          referenceId: params.referenceId,
          transactionId: 'test-transaction',
          status: waafiPaymentStatus,
          tranAmount: transaction.amount,
          currency: waafiPaymentCurrency || transaction.currency
        }
      }));
      return;
    }
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ responseCode: '4000' }));
  });
  await new Promise((resolve, reject) => waafiServer.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const waafiTestEndpoint = `http://127.0.0.1:${waafiServer.address().port}/asm`;
  const smtpServer = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, session, callback) {
      if (auth.username !== 'smtp-test-user' || auth.password !== 'smtp-test-password') {
        callback(new Error('Invalid test SMTP credentials'));
        return;
      }
      callback(null, { user: auth.username });
    },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        if (failNextEmail) {
          failNextEmail = false;
          callback(new Error('Simulated SMTP delivery failure'));
          return;
        }
        deliveredEmails.push({ envelope: session.envelope, body: Buffer.concat(chunks).toString('utf8') });
        callback();
      });
    }
  });
  await new Promise((resolve, reject) => smtpServer.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const smtpPort = smtpServer.server.address().port;
  const legacyDb = new DatabaseSync(path.join(dataDir, 'safar-kaabe.sqlite'));
  legacyDb.exec(`
    CREATE TABLE agencies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tier TEXT NOT NULL,
      markup_pct REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      is_approved INTEGER NOT NULL DEFAULT 1,
      logo_mime TEXT,
      logo_data TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE catalog_products (
      id TEXT PRIMARY KEY,
      agency_id TEXT NOT NULL,
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
      supplier_commission_pct REAL NOT NULL
    );
    INSERT INTO agencies (id, name, tier, markup_pct, created_at)
    VALUES ('migration-agency', 'Migration Test Agency', 'PROFESSIONAL', 4, '2025-01-01T00:00:00.000Z');
    INSERT INTO catalog_products (
      id, agency_id, title, title_so, category, destination, route_badge, specs,
      supplier_name, supplier_ref, base_cents, tax_cents, supplier_commission_pct
    ) VALUES (
      'legacy-flight-available', 'migration-agency', 'Migration Flight Offer', 'Duulimaad Tijaabo',
      'FLIGHT', 'MGQ', 'BXX → MGQ', 'Test fixture for legacy inventory migration',
      'Test Airline', 'MIGRATION-FLIGHT-01', 12000, 2500, 8
    );
    CREATE TABLE bookings (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      pnr TEXT NOT NULL,
      agency_id TEXT NOT NULL,
      customer_id TEXT,
      traveler_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      offer_title TEXT NOT NULL,
      category TEXT NOT NULL,
      payment_provider TEXT NOT NULL,
      state TEXT NOT NULL,
      financials_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE booking_documents (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      document_type TEXT NOT NULL,
      status TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/pdf',
      pdf_data TEXT,
      document_hash TEXT,
      verification_token_hash TEXT NOT NULL,
      error_message TEXT,
      issued_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (booking_id, document_type)
    );
    CREATE TABLE booking_document_deliveries (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (document_id, recipient_email)
    );
  `);
  legacyDb.close();
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverErrors = '';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      VERCEL_ENV: 'production',
      VERCEL_DEPLOYMENT_ID: 'test-deployment',
      HOST: '127.0.0.1',
      PORT: String(port),
      SAFAR_KAABE_DATA_DIR: dataDir,
      WAAFI_MERCHANT_UID: 'TESTMERCHANT',
      WAAFI_STORE_ID: '12345',
      WAAFI_HPP_KEY: '01234567890123456789012345678901',
      WAAFI_TEST_ENDPOINT: waafiTestEndpoint,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtpPort),
      SMTP_USER: 'smtp-test-user',
      SMTP_PASS: 'smtp-test-password',
      SMTP_FROM: 'engjoseph250@gmail.com'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { serverErrors += chunk; });

  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => waafiServer.close(resolve));
    await new Promise(resolve => smtpServer.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
    const headers = { Origin: baseUrl };
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new Error(`Request ${method} ${route} failed: ${error.message}\n${serverErrors}`, { cause: error });
    }
  }

  let ready = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) assert.fail(`server exited with ${child.exitCode}`);
    try {
      const response = await request('/api/setup/status');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `server should start and expose setup status: ${serverErrors}`);
  const appVersionResponse = await request('/api/app-version');
  assert.equal(appVersionResponse.status, 200);
  assert.equal(appVersionResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await appVersionResponse.json(), { releaseId: 'test-deployment' });

  const guestCatalogResponse = await request('/api/catalog');
  assert.equal(guestCatalogResponse.status, 200, 'travelers can browse without an account');
  const guestCatalog = await guestCatalogResponse.json();
  assert.deepEqual(guestCatalog.catalog.map(offer => offer.id), ['legacy-flight-available']);
  assert.equal(guestCatalog.catalog[0].estimatedTotalUsdCents, 16180);
  const guestConversationsResponse = await request('/api/conversations');
  assert.equal(guestConversationsResponse.status, 401, 'private chat requires a signed-in account');
  const guestIceConfig = await request('/api/calls/ice-config');
  assert.equal(guestIceConfig.status, 401, 'call relay configuration is available only to signed-in users');
  const publicAgencies = await (await request('/api/agencies/active')).json();
  assert.deepEqual(publicAgencies.agencies, [{ id: 'migration-agency', name: 'Migration Test Agency' }]);
  const guestBookingWithoutOrigin = await fetch(`${baseUrl}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offerId: 'legacy-flight-available' })
  });
  assert.equal(guestBookingWithoutOrigin.status, 403, 'guest booking mutations require a same-origin browser request');

  const unauthorized = await request('/api/portal/summary');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('cache-control'), 'no-store');

  const initialStatus = await (await request('/api/setup/status')).json();
  assert.deepEqual(initialStatus, { configured: false });
  const unregisteredReset = await request('/api/auth/password-reset/request', {
    method: 'POST',
    body: { email: 'not-registered@example.com' }
  });
  assert.equal(unregisteredReset.status, 200, 'password reset does not disclose whether an account exists');
  assert.equal(deliveredEmails.length, 0);

  const setupResponse = await request('/api/setup/admin', {
    method: 'POST',
    body: { name: 'First Admin', email: 'admin@example.com', password: 'long-enough-admin-password' }
  });
  assert.equal(setupResponse.status, 201);
  const adminCookie = cookieJar(setupResponse);
  const adminCsrf = csrfToken(adminCookie);
  assert.ok(adminCookie.includes('sk_session='));
  assert.ok(adminCsrf);
  assert.match(setupResponse.headers.get('set-cookie'), /HttpOnly/);

  const repeatedSetup = await request('/api/setup/admin', {
    method: 'POST',
    body: { name: 'Intruder', email: 'intruder@example.com', password: 'another-long-password' }
  });
  assert.equal(repeatedSetup.status, 409);

  const adminSummaryResponse = await request('/api/portal/summary', { cookie: adminCookie });
  const adminSummary = await adminSummaryResponse.json();
  assert.equal(adminSummary.user.role, 'SUPER_ADMIN');
  assert.equal(adminSummary.agencies.length, 1);
  assert.equal(adminSummary.customers.length, 0);
  assert.equal(adminSummary.agencies[0].id, 'migration-agency', 'server startup does not repopulate sample agencies');

  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'ADMIN@example.com', password: 'long-enough-admin-password' }
  });
  assert.equal(adminLogin.status, 200, 'Super Admin can sign in after initial setup');
  const signedInAdminCookie = cookieJar(adminLogin);
  const signedInAdminCsrf = csrfToken(signedInAdminCookie);
  const signedInAdminSummary = await (await request('/api/portal/summary', { cookie: signedInAdminCookie })).json();
  assert.equal(signedInAdminSummary.user.role, 'SUPER_ADMIN', 'signed-in admins receive the admin dashboard data');
  const adminProfile = await request('/api/auth/profile', {
    method: 'PATCH',
    cookie: signedInAdminCookie,
    csrf: signedInAdminCsrf,
    body: { name: 'Updated Admin', phone: '+252611234567' }
  });
  assert.equal(adminProfile.status, 200, 'Super Admin can update their own profile');
  assert.equal((await adminProfile.json()).user.name, 'Updated Admin');
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/jKcAAAAASUVORK5CYII=';
  const adminAvatarUpload = await request('/api/auth/avatar', {
    method: 'PUT',
    cookie: signedInAdminCookie,
    csrf: signedInAdminCsrf,
    body: { mime: 'image/png', data: tinyPng }
  });
  assert.equal(adminAvatarUpload.status, 200);
  assert.equal((await adminAvatarUpload.json()).user.avatarData, tinyPng);
  const malformedAvatar = await request('/api/auth/avatar', {
    method: 'PUT',
    cookie: signedInAdminCookie,
    csrf: signedInAdminCsrf,
    body: { mime: 'image/png', data: Buffer.from('not an image').toString('base64') }
  });
  assert.equal(malformedAvatar.status, 400, 'image MIME types must match the uploaded file signature');
  const oversizedAvatar = await request('/api/auth/avatar', {
    method: 'PUT',
    cookie: signedInAdminCookie,
    csrf: signedInAdminCsrf,
    body: { mime: 'image/png', data: Buffer.alloc(262_145).toString('base64') }
  });
  assert.equal(oversizedAvatar.status, 400, 'images above the storage limit are rejected');
  const badAdminProfileCsrf = await request('/api/auth/profile', {
    method: 'PATCH',
    cookie: signedInAdminCookie,
    body: { name: 'Forged Profile', phone: '' }
  });
  assert.equal(badAdminProfileCsrf.status, 403, 'profile updates require CSRF protection');
  const invalidAdminProfile = await request('/api/auth/profile', {
    method: 'PATCH',
    cookie: signedInAdminCookie,
    csrf: signedInAdminCsrf,
    body: { name: '', phone: '' }
  });
  assert.equal(invalidAdminProfile.status, 400, 'validation errors return their intended client response');

  const missingCsrf = await request('/api/agencies', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: 'Travel Partner',
      tier: 'PROFESSIONAL',
      markupPct: 5,
      ownerName: 'Agency Owner',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'long-enough-owner-password'
    }
  });
  assert.equal(missingCsrf.status, 403);

  const agencyResponse = await request('/api/agencies', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: {
      name: 'Travel Partner',
      tier: 'PROFESSIONAL',
      markupPct: 5,
      ownerName: 'Agency Owner',
      ownerEmail: 'owner@example.com',
      ownerPassword: 'long-enough-owner-password'
    }
  });
  assert.equal(agencyResponse.status, 201);
  const agency = (await agencyResponse.json()).agency;
  assert.equal(agency.status, 'PENDING', 'new agencies await Super Admin approval');
  const pendingOwnerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@example.com', password: 'long-enough-owner-password' }
  });
  assert.equal(pendingOwnerLogin.status, 403, 'pending agencies cannot sign in before approval');
  const agencyApproval = await request(`/api/agencies/${agency.id}/status`, {
    method: 'PATCH',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { action: 'APPROVE' }
  });
  assert.equal(agencyApproval.status, 200);
  assert.equal((await agencyApproval.json()).agency.status, 'ACTIVE');

  const repeatedOwnerEmail = await request('/api/agencies', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { name: 'Invalid', tier: 'BASIC', markupPct: 3, ownerName: 'Owner', ownerEmail: 'owner@example.com', ownerPassword: 'long-enough-owner-password' }
  });
  assert.equal(repeatedOwnerEmail.status, 409, 'duplicate agency owner emails cannot be reused');

  const customerRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Traveler One', email: 'traveler@example.com', phone: '+252611234567', password: 'long-enough-customer-password' }
  });
  assert.equal(customerRegistration.status, 201);
  const customerCookie = cookieJar(customerRegistration);
  const customerCsrf = csrfToken(customerCookie);
  const realtimeStatusResponse = await request('/api/catalog/realtime');
  assert.deepEqual(await realtimeStatusResponse.json(), { supported: false }, 'serverless deployments use the periodic refresh fallback');
  const notificationStreamResponse = await request('/api/notifications/stream', { cookie: customerCookie });
  assert.equal(notificationStreamResponse.status, 404, 'serverless deployments never hold a function open for notification events');
  assert.match((await notificationStreamResponse.json()).error, /not available/);
  const iceConfigResponse = await request('/api/calls/ice-config', { cookie: customerCookie });
  assert.equal(iceConfigResponse.status, 200);
  assert.equal(iceConfigResponse.headers.get('cache-control'), 'no-store');
  const iceConfig = await iceConfigResponse.json();
  assert.ok(iceConfig.iceServers.some(server => server.urls.includes('stun:stun.l.google.com:19302')));
  assert.equal(typeof iceConfig.turnAvailable, 'boolean');
  assert.equal(JSON.stringify(iceConfig).includes('TURN_SHARED_SECRET'), false);
  const customerAvatarUpload = await request('/api/auth/avatar', {
    method: 'PUT',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { mime: 'image/png', data: tinyPng }
  });
  assert.equal(customerAvatarUpload.status, 200);
  const customerAvatarRemoval = await request('/api/auth/avatar', {
    method: 'PUT',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { mime: 'image/png', data: null }
  });
  assert.equal(customerAvatarRemoval.status, 200);
  assert.equal((await customerAvatarRemoval.json()).user.avatarData, null);
  await request('/api/auth/avatar', {
    method: 'PUT',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { mime: 'image/png', data: tinyPng }
  });
  const customerSummary = await (await request('/api/portal/summary', { cookie: customerCookie })).json();
  assert.equal(customerSummary.user.role, 'CLIENT');
  assert.equal(customerSummary.user.avatarData, tinyPng);
  const activeAgencies = await (await request('/api/agencies/active', { cookie: customerCookie })).json();
  assert.ok(activeAgencies.agencies.some(item => item.id === agency.id), 'customers can discover active agencies to contact');
  const migratedCatalog = await (await request('/api/catalog', { cookie: customerCookie })).json();
  assert.equal(migratedCatalog.catalog[0].available, 1, 'existing catalog rows receive safe inventory defaults');
  assert.equal(migratedCatalog.catalog[0].published, 1, 'existing catalog rows remain published after migration');

  const customerAgencyCreate = await request('/api/agencies', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { name: 'Forbidden', tier: 'BASIC', markupPct: 1, ownerName: 'Bad', ownerEmail: 'bad@example.com', ownerPassword: 'long-enough-owner-password' }
  });
  assert.equal(customerAgencyCreate.status, 403);

  const agencyLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'OWNER@example.com', password: 'long-enough-owner-password' }
  });
  assert.equal(agencyLogin.status, 200);
  const agencyUser = (await agencyLogin.json()).user;
  const agencyCookie = cookieJar(agencyLogin);
  const agencyCsrf = csrfToken(agencyCookie);
  const agencyLogoUpload = await request('/api/agency/logo', {
    method: 'PUT',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { mime: 'image/png', data: tinyPng }
  });
  assert.equal(agencyLogoUpload.status, 200);
  assert.equal((await agencyLogoUpload.json()).agency.logoData, tinyPng);
  const agencyAvatarUpload = await request('/api/auth/avatar', {
    method: 'PUT',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { mime: 'image/png', data: tinyPng }
  });
  assert.equal(agencyAvatarUpload.status, 200);
  const customerLogoUpdate = await request('/api/agency/logo', {
    method: 'PUT',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { mime: 'image/png', data: tinyPng }
  });
  assert.equal(customerLogoUpdate.status, 403, 'customers cannot modify agency branding');
  const refreshedAdminSummary = await (await request('/api/portal/summary', { cookie: signedInAdminCookie })).json();
  assert.equal(refreshedAdminSummary.customers[0].avatarData, tinyPng);
  assert.equal(refreshedAdminSummary.agencies.find(item => item.id === agency.id).logoData, tinyPng);
  assert.equal(refreshedAdminSummary.agencyStaff.find(item => item.id === agencyUser.id)?.avatarData, tinyPng);
  const agencySummaryWithBranding = await (await request('/api/portal/summary', { cookie: agencyCookie })).json();
  assert.equal(agencySummaryWithBranding.agency.logoData, tinyPng);
  const agencySummary = await (await request('/api/portal/summary', { cookie: agencyCookie })).json();
  assert.equal(agencySummary.agency.id, agency.id);
  assert.equal(agencySummary.agencies, undefined, 'agency accounts cannot list all agencies');

  const agencyProductResponse = await request('/api/catalog', {
    method: 'POST',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: {
      agencyId: 'ag_sky_team',
      category: 'FLIGHT',
      title: 'Agency Flight to Nairobi',
      origin: 'BXX',
      destination: 'NBO',
      price: 250,
      available: 2,
      travelDate: '2099-03-20',
      baggage: '20 kg checked',
      specs: 'Direct service',
      imageMime: 'image/png',
      imageData: tinyPng,
      published: true
    }
  });
  assert.equal(agencyProductResponse.status, 201);
  const agencyProduct = (await agencyProductResponse.json()).product;
  assert.equal(agencyProduct.agencyId, agency.id, 'agency listings are always assigned to the signed-in agency');
  assert.equal(agencyProduct.available, 2);
  assert.equal(agencyProduct.travelDate, '2099-03-20');
  assert.equal(agencyProduct.published, true);
  const agencyImageListing = (await (await request('/api/catalog', { cookie: agencyCookie })).json())
    .catalog.find(product => product.id === agencyProduct.id);
  assert.ok(agencyImageListing.imageUrl);
  const agencyProductImage = await request(agencyImageListing.imageUrl, { cookie: agencyCookie });
  assert.equal(agencyProductImage.status, 200);
  assert.equal(agencyProductImage.headers.get('content-type'), 'image/png');
  assert.equal(agencyProductImage.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await agencyProductImage.arrayBuffer()), Buffer.from(tinyPng, 'base64'));
  const oversizedListingImage = await request('/api/catalog', {
    method: 'POST',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: {
      category: 'FLIGHT',
      title: 'Oversized image listing',
      origin: 'BXX',
      destination: 'NBO',
      price: 250,
      imageMime: 'image/png',
      imageData: 'A'.repeat(350_000)
    }
  });
  assert.equal(oversizedListingImage.status, 400, 'catalog images are limited to 256 KB');
  const invalidListing = await request('/api/catalog', {
    method: 'POST',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { category: 'FLIGHT', title: 'Invalid date', destination: 'NBO', price: 100, available: 2, travelDate: '2099-02-31' }
  });
  assert.equal(invalidListing.status, 400, 'impossible travel dates are rejected');

  const customerCatalog = await (await request('/api/catalog', { cookie: customerCookie })).json();
  assert.ok(customerCatalog.catalog.some(product => product.id === agencyProduct.id));
  const unpublishedProduct = await request(`/api/catalog/${agencyProduct.id}`, {
    method: 'PATCH',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { published: false }
  });
  assert.equal(unpublishedProduct.status, 200);
  const privateCatalog = await (await request('/api/catalog', { cookie: customerCookie })).json();
  assert.ok(!privateCatalog.catalog.some(product => product.id === agencyProduct.id), 'draft listings stay private');
  assert.equal((await request(agencyImageListing.imageUrl)).status, 404, 'draft images stay private to travelers');
  assert.equal((await request(agencyImageListing.imageUrl, { cookie: agencyCookie })).status, 200, 'agencies can access their own draft images');
  const republishedProduct = await request(`/api/catalog/${agencyProduct.id}`, {
    method: 'PATCH',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { title: 'Updated Agency Flight', available: 3, published: true }
  });
  assert.equal(republishedProduct.status, 200);

  const firstClient = await request('/api/agency/clients', {
    method: 'POST',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { agencyId: 'ag_sky_team', name: 'Agency CRM Client', phone: '+252611111111', email: 'crm@example.com' }
  });
  assert.equal(firstClient.status, 201);
  const clientId = (await firstClient.json()).client.id;
  const agencyClients = await (await request('/api/agency/clients', { cookie: agencyCookie })).json();
  assert.equal(agencyClients.clients.length, 1);

  const adminClients = await (await request(`/api/agency/clients?agencyId=${encodeURIComponent(agency.id)}`, { cookie: adminCookie })).json();
  assert.equal(adminClients.clients.length, 1);
  const otherAgencyResponse = await request('/api/agencies', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { name: 'Other Agency', tier: 'BASIC', markupPct: 4, ownerName: 'Other Owner', ownerEmail: 'other@example.com', ownerPassword: 'long-enough-other-password' }
  });
  assert.equal(otherAgencyResponse.status, 201);
  const otherAgency = (await otherAgencyResponse.json()).agency;
  const pendingAgencyDirectory = await (await request('/api/agencies/active', { cookie: customerCookie })).json();
  assert.ok(!pendingAgencyDirectory.agencies.some(item => item.id === otherAgency.id), 'pending agencies stay out of customer contact lists');
  const customerAgencyApproval = await request(`/api/agencies/${otherAgency.id}/status`, {
    method: 'PATCH',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { action: 'APPROVE' }
  });
  assert.equal(customerAgencyApproval.status, 403, 'customers cannot approve agencies');
  const otherAgencyApproval = await request(`/api/agencies/${otherAgency.id}/status`, {
    method: 'PATCH',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { action: 'APPROVE' }
  });
  assert.equal(otherAgencyApproval.status, 200);
  const unauthorizedAgencyEdit = await request(`/api/agencies/${otherAgency.id}`, {
    method: 'PATCH',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { name: 'Unauthorized Agency Edit', tier: 'BASIC', markupPct: 1 }
  });
  assert.equal(unauthorizedAgencyEdit.status, 403, 'customers cannot edit agencies');
  const agencyEditWithoutCsrf = await request(`/api/agencies/${otherAgency.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { name: 'Missing CSRF', tier: 'BASIC', markupPct: 1 }
  });
  assert.equal(agencyEditWithoutCsrf.status, 403, 'agency edits require CSRF protection');
  const invalidAgencyEdit = await request(`/api/agencies/${otherAgency.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { name: 'Invalid Plan', tier: 'UNLIMITED', markupPct: 101 }
  });
  assert.equal(invalidAgencyEdit.status, 400, 'invalid plan and markup values are rejected');
  const agencyEdit = await request(`/api/agencies/${otherAgency.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { name: 'Updated Other Agency', tier: 'ENTERPRISE', markupPct: 7.5 }
  });
  assert.equal(agencyEdit.status, 200);
  assert.deepEqual((await agencyEdit.json()).agency, {
    id: otherAgency.id,
    name: 'Updated Other Agency',
    tier: 'ENTERPRISE',
    markupPct: 7.5
  });
  const otherLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'other@example.com', password: 'long-enough-other-password' }
  });
  const otherAgencyCookie = cookieJar(otherLogin);
  const otherAgencyCsrf = csrfToken(otherAgencyCookie);
  const otherAgencyCatalog = await (await request('/api/catalog', { cookie: otherAgencyCookie })).json();
  assert.ok(!otherAgencyCatalog.catalog.some(product => product.id === agencyProduct.id), 'agency inventory is tenant-scoped');
  const crossTenantListingEdit = await request(`/api/catalog/${agencyProduct.id}`, {
    method: 'PATCH',
    cookie: otherAgencyCookie,
    csrf: otherAgencyCsrf,
    body: { title: 'Unauthorized change' }
  });
  assert.equal(crossTenantListingEdit.status, 404, 'an agency cannot view or edit another agency listing');
  const crossTenantListingDelete = await request(`/api/catalog/${agencyProduct.id}`, {
    method: 'DELETE',
    cookie: otherAgencyCookie,
    csrf: otherAgencyCsrf
  });
  assert.equal(crossTenantListingDelete.status, 404, 'an agency cannot remove another agency listing');
  const customerListingEdit = await request(`/api/catalog/${agencyProduct.id}`, {
    method: 'PATCH',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { title: 'Customer edit' }
  });
  assert.equal(customerListingEdit.status, 403, 'customers cannot manage agency inventory');
  const agencyWithInventoryDelete = await request(`/api/agencies/${agency.id}`, {
    method: 'DELETE',
    cookie: adminCookie,
    csrf: adminCsrf
  });
  assert.equal(agencyWithInventoryDelete.status, 409, 'agencies with travel listings cannot be deleted');
  const agencyListingDelete = await request(`/api/catalog/${agencyProduct.id}`, {
    method: 'DELETE',
    cookie: agencyCookie,
    csrf: agencyCsrf
  });
  assert.equal(agencyListingDelete.status, 200, 'an agency can remove its own inventory');
  const wrongTenantDelete = await request(`/api/agency/clients/${clientId}`, {
    method: 'DELETE',
    cookie: otherAgencyCookie,
    csrf: otherAgencyCsrf
  });
  assert.equal(wrongTenantDelete.status, 404);
  const customerConversationResponse = await request('/api/conversations', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {
      agencyId: agency.id,
      subject: 'Question about my trip',
      message: 'Can you confirm the departure time?'
    }
  });
  assert.equal(customerConversationResponse.status, 201);
  const conversationId = (await customerConversationResponse.json()).conversation.id;
  const videoCallResponse = await request(`/api/conversations/${conversationId}/calls`, {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { callType: 'VIDEO' }
  });
  assert.equal(videoCallResponse.status, 201);
  const videoCall = (await videoCallResponse.json()).call;
  assert.equal(videoCall.callType, 'VIDEO');
  const agencyActiveCalls = await (await request('/api/calls/active', { cookie: agencyCookie })).json();
  assert.ok(agencyActiveCalls.calls.some(call => call.id === videoCall.id && call.callerId === customerSummary.user.id));
  const unauthorizedCallSignal = await request(`/api/calls/${videoCall.id}/signals`, { cookie: otherAgencyCookie });
  assert.equal(unauthorizedCallSignal.status, 404, 'other agencies cannot inspect call signals');
  const callOffer = await request(`/api/calls/${videoCall.id}/signals`, {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { signalType: 'OFFER', payload: { type: 'offer', sdp: 'test-offer' } }
  });
  assert.equal(callOffer.status, 201);
  const agencyCallSignals = await (await request(`/api/calls/${videoCall.id}/signals`, { cookie: agencyCookie })).json();
  assert.equal(agencyCallSignals.signals[0].signalType, 'OFFER');
  const callAccept = await request(`/api/calls/${videoCall.id}`, {
    method: 'PATCH',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { action: 'ACCEPT' }
  });
  assert.equal(callAccept.status, 200);
  assert.equal((await callAccept.json()).status, 'ACCEPTED');
  const callAnswer = await request(`/api/calls/${videoCall.id}/signals`, {
    method: 'POST',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { signalType: 'ANSWER', payload: { type: 'answer', sdp: 'test-answer' } }
  });
  assert.equal(callAnswer.status, 201);
  const customerCallSignals = await (await request(`/api/calls/${videoCall.id}/signals`, { cookie: customerCookie })).json();
  assert.ok(customerCallSignals.signals.some(signal => signal.signalType === 'ANSWER'));
  const callEnd = await request(`/api/calls/${videoCall.id}`, {
    method: 'PATCH',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { action: 'END' }
  });
  assert.equal((await callEnd.json()).status, 'ENDED');
  const agencyConversations = await (await request('/api/conversations', { cookie: agencyCookie })).json();
  assert.equal(agencyConversations.conversations.length, 1);
  assert.equal(agencyConversations.conversations[0].unreadCount, 1);
  assert.equal(agencyConversations.conversations[0].agencyLogoData, tinyPng);
  assert.equal(agencyConversations.conversations[0].customerAvatarData, tinyPng);
  const otherAgencyConversations = await (await request('/api/conversations', { cookie: otherAgencyCookie })).json();
  assert.equal(otherAgencyConversations.conversations.length, 0, 'agency messages are tenant-isolated');
  const crossTenantConversation = await request(`/api/conversations/${conversationId}/messages`, { cookie: otherAgencyCookie });
  assert.equal(crossTenantConversation.status, 404, 'other agencies cannot read a conversation');
  const customerAgencyDelete = await request(`/api/agencies/${otherAgency.id}`, {
    method: 'DELETE',
    cookie: customerCookie,
    csrf: customerCsrf
  });
  assert.equal(customerAgencyDelete.status, 403, 'customers cannot delete agencies');
  const otherAgencyDelete = await request(`/api/agencies/${otherAgency.id}`, {
    method: 'DELETE',
    cookie: adminCookie,
    csrf: adminCsrf
  });
  assert.equal(otherAgencyDelete.status, 200, 'Super Admins can delete agencies without booking or inventory history');
  assert.equal((await request('/api/portal/summary', { cookie: otherAgencyCookie })).status, 401, 'deleting an agency revokes its staff sessions');
  const agenciesAfterDelete = await (await request('/api/portal/summary', { cookie: adminCookie })).json();
  assert.ok(!agenciesAfterDelete.agencies.some(item => item.id === otherAgency.id));
  const agencyRead = await request(`/api/conversations/${conversationId}/read`, {
    method: 'POST',
    cookie: agencyCookie,
    csrf: agencyCsrf
  });
  assert.equal(agencyRead.status, 200);
  const agencyReply = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { message: 'Your flight departs at 10:30 AM.' }
  });
  assert.equal(agencyReply.status, 201);
  const customerMessages = await (await request(`/api/conversations/${conversationId}/messages`, { cookie: customerCookie })).json();
  assert.equal(customerMessages.messages.length, 2);
  assert.ok(customerMessages.messages[0].readAt, 'read receipts are recorded for the other participant');
  assert.equal(customerMessages.messages[0].senderImageData, tinyPng);
  assert.equal(customerMessages.messages[1].senderImageData, tinyPng);
  assert.equal(customerMessages.messages[1].body, 'Your flight departs at 10:30 AM.');
  const supportConversation = await request('/api/conversations', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { support: true, subject: 'Platform help', message: 'I need account support.' }
  });
  assert.equal(supportConversation.status, 201);
  const adminConversations = await (await request('/api/conversations', { cookie: adminCookie })).json();
  assert.equal(adminConversations.conversations.length, 2, 'support can access and handle all conversations');
  assert.equal(adminConversations.conversations.find(item => item.id === conversationId).agencyLogoData, tinyPng);
  assert.equal(adminConversations.conversations.find(item => item.id === conversationId).customerAvatarData, tinyPng);
  const supportConversationId = (await supportConversation.json()).conversation.id;
  const adminSupportReply = await request(`/api/conversations/${supportConversationId}/messages`, {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { message: 'A support specialist will help you shortly.' }
  });
  assert.equal(adminSupportReply.status, 201, 'Super Admin can reply to traveler support conversations');
  const travelerSupportMessages = await (await request(`/api/conversations/${supportConversationId}/messages`, { cookie: customerCookie })).json();
  assert.equal(travelerSupportMessages.messages[1].body, 'A support specialist will help you shortly.');

  const adminTravelerConversationResponse = await request('/api/conversations', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: {
      recipientType: 'CLIENT',
      recipientId: customerSummary.user.id,
      subject: 'Traveler account assistance',
      message: 'Can I help with your account?'
    }
  });
  assert.equal(adminTravelerConversationResponse.status, 201, 'Super Admin can start a conversation with a traveler');
  const adminTravelerConversationId = (await adminTravelerConversationResponse.json()).conversation.id;
  const travelerConversations = await (await request('/api/conversations', { cookie: customerCookie })).json();
  assert.ok(travelerConversations.conversations.some(item => item.id === adminTravelerConversationId));
  const travelerReply = await request(`/api/conversations/${adminTravelerConversationId}/messages`, {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { message: 'Thank you for contacting me.' }
  });
  assert.equal(travelerReply.status, 201, 'travelers can reply to Super Admin conversations');

  const adminAgencyConversationResponse = await request('/api/conversations', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: {
      recipientType: 'AGENCY',
      recipientId: agency.id,
      subject: 'Agency service update',
      message: 'Please review the latest service update.'
    }
  });
  assert.equal(adminAgencyConversationResponse.status, 201, 'Super Admin can start a conversation with an agency');
  const adminAgencyConversationId = (await adminAgencyConversationResponse.json()).conversation.id;
  const agencyConversationList = await (await request('/api/conversations', { cookie: agencyCookie })).json();
  assert.ok(agencyConversationList.conversations.some(item => item.id === adminAgencyConversationId));
  const agencyConversationReply = await request(`/api/conversations/${adminAgencyConversationId}/messages`, {
    method: 'POST',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { message: 'We have reviewed the update.' }
  });
  assert.equal(agencyConversationReply.status, 201, 'agencies can reply to Super Admin conversations');

  const agencySupportConversation = await request('/api/conversations', {
    method: 'POST',
    cookie: agencyCookie,
    csrf: agencyCsrf,
    body: { subject: 'Agency support request', message: 'We need assistance with our account.' }
  });
  assert.equal(agencySupportConversation.status, 201, 'agencies can open a private support conversation');
  const agencySupportConversationId = (await agencySupportConversation.json()).conversation.id;
  const adminAgencySupportReply = await request(`/api/conversations/${agencySupportConversationId}/messages`, {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { message: 'We will assist your agency.' }
  });
  assert.equal(adminAgencySupportReply.status, 201, 'Super Admin can reply to agency support conversations');
  const agencySupportMessages = await (await request(`/api/conversations/${agencySupportConversationId}/messages`, { cookie: agencyCookie })).json();
  assert.equal(agencySupportMessages.messages[1].body, 'We will assist your agency.');

  const invalidAdminRecipient = await request('/api/conversations', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: {
      recipientType: 'AGENCY',
      recipientId: 'missing-agency',
      subject: 'Invalid recipient',
      message: 'This should not create a conversation.'
    }
  });
  assert.equal(invalidAdminRecipient.status, 404, 'Super Admin can only start conversations with existing recipients');

  const flightWithoutOrigin = await request('/api/catalog', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: {
      agencyId: 'migration-agency',
      category: 'FLIGHT',
      title: 'Incomplete Flight',
      destination: 'NBO',
      price: 200,
      available: 1
    }
  });
  assert.equal(flightWithoutOrigin.status, 400, 'new flight listings require an origin airport code');

  const guestOfferResponse = await request('/api/catalog', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: {
      agencyId: 'migration-agency',
      category: 'FLIGHT',
      title: 'Guest Booking Flight',
      origin: 'BXX',
      destination: 'NBO',
      price: 200,
      available: 6,
      travelDate: '',
      baggage: '',
      specs: 'Guest request rate limit test',
      published: true
    }
  });
  assert.equal(guestOfferResponse.status, 201);
  const guestOffer = await guestOfferResponse.json();
  const guestOfferId = guestOffer.product.id;
  assert.match(guestOffer.product.routeBadge, /^BXX .* NBO$/);
  const guestBookings = [];
  for (let index = 0; index < 5; index += 1) {
    const guestBookingResponse = await request('/api/bookings', {
      method: 'POST',
      body: {
        offerId: guestOfferId,
        travelerName: `Guest Traveler ${index + 1}`,
        travelerEmail: `guest${index + 1}@example.com`,
        phone: '+252611234568',
        paymentMethod: 'REQUEST_ONLY'
      }
    });
    assert.equal(guestBookingResponse.status, 201, 'guest requests are accepted up to the per-IP limit');
    const { booking: guestBooking } = await guestBookingResponse.json();
    assert.equal(guestBooking.customerId, null);
    assert.equal(guestBooking.travelerEmail, `guest${index + 1}@example.com`);
    assert.equal(guestBooking.state, 'REQUESTED');
    assert.equal(guestBooking.paymentProvider, 'REQUEST_ONLY');
    assert.equal(guestBooking.ref, guestBooking.reference, 'new bookings expose the same reference field as booking lists');
    assert.match(guestBooking.pnr, /^REQ-SK-/);
    assert.equal(guestBooking.financials.customerGrandTotalCents, 24400, 'guest request price is calculated on the server without a payment fee');
    guestBookings.push(guestBooking);
  }
  const guestRateLimited = await request('/api/bookings', {
    method: 'POST',
    body: {
      offerId: guestOfferId,
      travelerName: 'Rate Limited Guest',
      travelerEmail: 'limited@example.com',
      phone: '+252611234569',
      paymentMethod: 'REQUEST_ONLY'
    }
  });
  assert.equal(guestRateLimited.status, 429, 'guest booking requests are rate-limited per IP');
  const guestInventory = await (await request('/api/catalog')).json();
  assert.equal(guestInventory.catalog.find(offer => offer.id === guestOfferId).available, 1);

  const seatCountOfferResponse = await request('/api/catalog', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: {
      agencyId: 'migration-agency',
      category: 'FLIGHT',
      title: 'Seat Count Booking Flight',
      origin: 'BXX',
      destination: 'NBO',
      price: 200,
      available: 3,
      travelDate: '',
      baggage: '',
      specs: 'Seat availability validation test',
      published: true
    }
  });
  assert.equal(seatCountOfferResponse.status, 201);
  const seatCountOffer = (await seatCountOfferResponse.json()).product;
  const waafiOfferResponse = await request('/api/catalog', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: {
      agencyId: 'migration-agency',
      category: 'FLIGHT',
      title: 'Verified Wallet Checkout Test',
      origin: 'BXX',
      destination: 'NBO',
      price: 200,
      available: 2,
      travelDate: '',
      baggage: '',
      specs: 'Provider-confirmed receipt test',
      published: true
    }
  });
  assert.equal(waafiOfferResponse.status, 201);
  const waafiOffer = (await waafiOfferResponse.json()).product;
  const waafiBookingResponse = await request('/api/bookings', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {
      offerId: waafiOffer.id,
      travelerName: 'Traveler One',
      phone: '+252611234567',
      paymentMethod: 'WAAFI'
    }
  });
  assert.equal(waafiBookingResponse.status, 201);
  const waafiBookingResult = await waafiBookingResponse.json();
  assert.equal(waafiBookingResult.booking.paymentStatus, 'PENDING');
  assert.equal(waafiBookingResult.booking.state, 'PAYMENT_PENDING');
  assert.equal(waafiBookingResult.paymentUrl, 'https://checkout.example.test/session');
  assert.ok(waafiProviderRequests.every(providerRequest => !JSON.stringify(providerRequest).toLowerCase().includes('"pin"')),
    'wallet PIN credentials are never sent to the provider by the app');
  const pendingPaymentRefresh = await request('/api/payments/waafi/refresh', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { referenceId: waafiBookingResult.booking.paymentReference }
  });
  const pendingPaymentResult = await pendingPaymentRefresh.json();
  assert.equal(pendingPaymentRefresh.status, 200, `${JSON.stringify(pendingPaymentResult)} ${serverErrors}`);
  assert.equal(pendingPaymentResult.payment.status, 'PENDING');
  let customerConversations = await (await request('/api/conversations', { cookie: customerCookie })).json();
  const bookingConversationSubject = `Booking ${waafiBookingResult.booking.ref} payment receipt`;
  assert.ok(!customerConversations.conversations.some(conversation => conversation.subject === bookingConversationSubject),
    'pending payments do not create a verified-receipt conversation');
  waafiPaymentStatus = 'APPROVED';
  waafiPaymentCurrency = 'EUR';
  const mismatchedCurrencyRefresh = await request('/api/payments/waafi/refresh', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { referenceId: waafiBookingResult.booking.paymentReference }
  });
  assert.equal((await mismatchedCurrencyRefresh.json()).payment.status, 'PENDING');
  customerConversations = await (await request('/api/conversations', { cookie: customerCookie })).json();
  assert.ok(!customerConversations.conversations.some(conversation => conversation.subject === bookingConversationSubject),
    'provider approval with the wrong currency is not treated as paid');
  waafiPaymentCurrency = 'USD';
  const approvedPaymentRefresh = await request('/api/payments/waafi/refresh', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { referenceId: waafiBookingResult.booking.paymentReference }
  });
  const approvedPaymentResult = await approvedPaymentRefresh.json();
  assert.equal(approvedPaymentRefresh.status, 200, `${JSON.stringify(approvedPaymentResult)} ${serverErrors}`);
  assert.deepEqual(approvedPaymentResult.payment, {
    referenceId: waafiBookingResult.booking.paymentReference,
    status: 'APPROVED',
    transactionId: 'test-transaction'
  });
  customerConversations = await (await request('/api/conversations', { cookie: customerCookie })).json();
  const bookingConversation = customerConversations.conversations.find(conversation => conversation.subject === bookingConversationSubject);
  assert.ok(bookingConversation, 'provider-confirmed payment creates a booking conversation');
  const receiptMessagesResponse = await request(`/api/conversations/${bookingConversation.id}/messages`, { cookie: customerCookie });
  const receiptMessages = (await receiptMessagesResponse.json()).messages;
  assert.equal(receiptMessages.length, 1, 'one receipt message is shared after provider confirmation');
  assert.match(receiptMessages[0].body, /WaafiPay payment confirmed by the provider/);
  assert.match(receiptMessages[0].body, new RegExp(`Receipt: ${waafiBookingResult.booking.paymentReference}`));
  assert.match(receiptMessages[0].body, /Transaction: test-transaction/);
  assert.match(receiptMessages[0].body, /Amount: 244\.00 USD/);
  for (const method of ['PATCH', 'DELETE']) {
    const modifyReceipt = await request(`/api/conversations/${bookingConversation.id}/messages/${receiptMessages[0].id}`, {
      method,
      cookie: customerCookie,
      csrf: customerCsrf,
      body: method === 'PATCH' ? { message: 'Edited receipt' } : undefined
    });
    assert.equal(modifyReceipt.status, 403, 'provider-confirmed receipts cannot be edited or deleted');
  }
  const duplicatePaymentRefresh = await request('/api/payments/waafi/refresh', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: { referenceId: waafiBookingResult.booking.paymentReference }
  });
  assert.equal((await duplicatePaymentRefresh.json()).payment.status, 'APPROVED');
  const duplicateReceiptMessages = await (await request(`/api/conversations/${bookingConversation.id}/messages`, { cookie: customerCookie })).json();
  assert.equal(duplicateReceiptMessages.messages.length, 1, 'repeat provider refreshes do not duplicate the receipt');
  const confirmedBooking = (await (await request('/api/bookings', { cookie: customerCookie })).json())
    .bookings.find(item => item.ref === waafiBookingResult.booking.ref);
  assert.equal(confirmedBooking.paymentStatus, 'APPROVED');
  assert.equal(confirmedBooking.state, 'PAYMENT_RECEIVED');
  const tooManySeats = await request('/api/bookings', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {
      offerId: seatCountOffer.id,
      travelerName: 'Traveler One',
      phone: '+252611234567',
      seatCount: 4,
      paymentMethod: 'REQUEST_ONLY'
    }
  });
  assert.equal(tooManySeats.status, 409);
  assert.match((await tooManySeats.json()).error, /Only 3 seats are left/);
  const invalidSeatCount = await request('/api/bookings', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {
      offerId: seatCountOffer.id,
      travelerName: 'Traveler One',
      phone: '+252611234567',
      seatCount: 0,
      paymentMethod: 'REQUEST_ONLY'
    }
  });
  assert.equal(invalidSeatCount.status, 400);
  const multiSeatBookingResponse = await request('/api/bookings', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {
      offerId: seatCountOffer.id,
      travelerName: 'Traveler One',
      phone: '+252611234567',
      seatCount: 2,
      paymentMethod: 'REQUEST_ONLY'
    }
  });
  assert.equal(multiSeatBookingResponse.status, 201);
  const multiSeatBooking = (await multiSeatBookingResponse.json()).booking;
  assert.equal(multiSeatBooking.seatCount, 2);
  assert.equal(multiSeatBooking.financials.customerGrandTotalCents, 48800, 'server prices every requested seat');
  const competingBookings = await Promise.all([1, 2].map(() => request('/api/bookings', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {
      offerId: seatCountOffer.id,
      travelerName: 'Traveler One',
      phone: '+252611234567',
      seatCount: 1,
      paymentMethod: 'REQUEST_ONLY'
    }
  })));
  assert.equal(competingBookings.filter(response => response.status === 201).length, 1, 'only one request can reserve the one remaining seat');
  assert.equal(competingBookings.filter(response => response.status === 409).length, 1, 'a concurrent request cannot overbook the last seat');
  const seatCountInventory = await (await request('/api/catalog', { cookie: customerCookie })).json();
  assert.ok(!seatCountInventory.catalog.some(offer => offer.id === seatCountOffer.id), 'the offer disappears from traveler search once all seats are booked');

  const customerBooking = await request('/api/bookings', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {
      offerId: 'legacy-flight-available',
      travelerName: 'Traveler One',
      phone: '+252611234567',
      paymentMethod: 'EVC_PLUS',
      financials: { customerGrandTotalCents: 1 }
    }
  });
  assert.equal(customerBooking.status, 201);
  const booking = (await customerBooking.json()).booking;
  assert.equal(booking.seatCount, 1, 'existing booking requests default to one seat');
  assert.equal(booking.financials.customerGrandTotalCents, 16180, 'server computes prices from its own catalog without collecting payment');
  assert.equal(booking.travelDate, null);
  assert.match(booking.pnr, /^REQ-SK-/);
  assert.equal(booking.state, 'REQUESTED');
  assert.equal(booking.paymentProvider, 'REQUEST_ONLY');
  assert.equal(booking.travelerEmail, 'traveler@example.com');
  const customerBookings = await (await request('/api/bookings', { cookie: customerCookie })).json();
  assert.equal(customerBookings.bookings.length, 4);
  assert.equal(customerBookings.bookings.find(item => item.id === multiSeatBooking.id).seatCount, 2);
  const inventoryAfterBooking = await (await request('/api/catalog', { cookie: customerCookie })).json();
  assert.ok(!inventoryAfterBooking.catalog.some(product => product.id === 'legacy-flight-available'), 'sold-out inventory is removed from traveler search');

  const secondCustomerResponse = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Traveler Two', email: 'traveler2@example.com', phone: '+252622222222', password: 'long-enough-second-password' }
  });
  const secondCustomerCookie = cookieJar(secondCustomerResponse);
  const unauthorizedPaymentRefresh = await request('/api/payments/waafi/refresh', {
    method: 'POST',
    cookie: secondCustomerCookie,
    csrf: csrfToken(secondCustomerCookie),
    body: { referenceId: waafiBookingResult.booking.paymentReference }
  });
  assert.equal(unauthorizedPaymentRefresh.status, 404, 'another traveler cannot access a payment reference');
  const secondBookings = await (await request('/api/bookings', { cookie: secondCustomerCookie })).json();
  assert.equal(secondBookings.bookings.length, 0);

  const adminBookings = await (await request('/api/bookings', { cookie: adminCookie })).json();
  assert.equal(adminBookings.bookings.length, 9);
  assert.ok(adminBookings.bookings.some(item => item.ref === booking.reference));
  assert.equal(adminBookings.bookings.filter(item => item.travelerEmail?.startsWith('guest')).length, 5);

  const agencySuspension = await request(`/api/agencies/${agency.id}/status`, {
    method: 'PATCH',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { action: 'SUSPEND' }
  });
  assert.equal(agencySuspension.status, 200);
  const suspendedAgencySession = await request('/api/portal/summary', { cookie: agencyCookie });
  assert.equal(suspendedAgencySession.status, 401, 'suspension immediately revokes agency sessions');
  const suspendedAgencyLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@example.com', password: 'long-enough-owner-password' }
  });
  assert.equal(suspendedAgencyLogin.status, 403);
  const agencyReactivation = await request(`/api/agencies/${agency.id}/status`, {
    method: 'PATCH',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { action: 'ACTIVATE' }
  });
  assert.equal(agencyReactivation.status, 200);
  const reactivatedAgencyLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@example.com', password: 'long-enough-owner-password' }
  });
  assert.equal(reactivatedAgencyLogin.status, 200);

  const badCurrentPassword = await request('/api/auth/password', {
    method: 'POST',
    cookie: signedInAdminCookie,
    csrf: signedInAdminCsrf,
    body: { currentPassword: 'incorrect-admin-password', newPassword: 'a-new-secure-admin-password' }
  });
  assert.equal(badCurrentPassword.status, 401, 'password updates verify the current password');
  const adminPasswordChange = await request('/api/auth/password', {
    method: 'POST',
    cookie: signedInAdminCookie,
    csrf: signedInAdminCsrf,
    body: { currentPassword: 'long-enough-admin-password', newPassword: 'a-new-secure-admin-password' }
  });
  assert.equal(adminPasswordChange.status, 200);
  assert.equal((await request('/api/portal/summary', { cookie: adminCookie })).status, 401, 'password change revokes other sessions');
  const oldAdminPasswordLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@example.com', password: 'long-enough-admin-password' }
  });
  assert.equal(oldAdminPasswordLogin.status, 401);
  const newAdminPasswordLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@example.com', password: 'a-new-secure-admin-password' }
  });
  assert.equal(newAdminPasswordLogin.status, 200);
  const adminResetRequest = await request('/api/auth/password-reset/request', {
    method: 'POST',
    body: { email: 'ADMIN@example.com' }
  });
  assert.equal(adminResetRequest.status, 200);
  assert.match(deliveredEmails[0].body, /engjoseph250@gmail\.com/);
  const resetCode = deliveredEmails[0].body.match(/\b\d{6}\b/)?.[0];
  assert.ok(resetCode, 'email contains a six-digit one-time reset code');
  const incorrectResetCode = await request('/api/auth/password-reset/complete', {
    method: 'POST',
    body: { email: 'admin@example.com', code: '000000', newPassword: 'reset-admin-password-next' }
  });
  assert.equal(incorrectResetCode.status, 400);
  const completeAdminReset = await request('/api/auth/password-reset/complete', {
    method: 'POST',
    body: { email: 'admin@example.com', code: resetCode, newPassword: 'reset-admin-password-next' }
  });
  assert.equal(completeAdminReset.status, 200);
  assert.equal((await request('/api/portal/summary', { cookie: cookieJar(newAdminPasswordLogin) })).status, 401, 'password reset revokes all active sessions');
  const resetAdminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@example.com', password: 'reset-admin-password-next' }
  });
  assert.equal(resetAdminLogin.status, 200);

  const ticketAgencyLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@example.com', password: 'long-enough-owner-password' }
  });
  assert.equal(ticketAgencyLogin.status, 200);
  const ticketAgencyCookie = cookieJar(ticketAgencyLogin);
  const ticketAgencyCsrf = csrfToken(ticketAgencyCookie);
  const ticketOfferResponse = await request('/api/catalog', {
    method: 'POST',
    cookie: ticketAgencyCookie,
    csrf: ticketAgencyCsrf,
    body: {
      category: 'FLIGHT',
      title: 'Ticket workflow test flight',
      origin: 'BXX',
      destination: 'NBO',
      price: 300,
      available: 1,
      specs: 'Direct test listing',
      published: true
    }
  });
  assert.equal(ticketOfferResponse.status, 201);
  const ticketOffer = (await ticketOfferResponse.json()).product;
  const ticketBookingResponse = await request('/api/bookings', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {
      offerId: ticketOffer.id,
      travelerName: 'Traveler One',
      phone: '+252611234567',
      paymentMethod: 'REQUEST_ONLY'
    }
  });
  assert.equal(ticketBookingResponse.status, 201);
  const ticketBooking = (await ticketBookingResponse.json()).booking;
  const ticketApprovalResponse = await request(`/api/bookings/${ticketBooking.id}`, {
    method: 'PATCH',
    cookie: ticketAgencyCookie,
    csrf: ticketAgencyCsrf,
    body: { action: 'ACCEPT' }
  });
  assert.equal(ticketApprovalResponse.status, 200);
  const ticketApproval = await ticketApprovalResponse.json();
  assert.equal(ticketApproval.booking.state, 'ACCEPTED', 'document errors never reject an approved booking');
  assert.match(ticketApproval.ticketError, /confirmed travel date/, 'missing trip details identify the exact validation failure');
  const ticketStatusBeforeRetry = await request(`/api/bookings/${ticketBooking.id}/ticket`, { cookie: customerCookie });
  assert.equal((await ticketStatusBeforeRetry.json()).status, 'FAILED', 'validation failures have their own persistent document status');

  const ticketDb = new DatabaseSync(path.join(dataDir, 'safar-kaabe.sqlite'));
  ticketDb.prepare('UPDATE bookings SET travel_date = ? WHERE id = ?').run('2099-03-20', ticketBooking.id);
  ticketDb.close();
  const emailsBeforeTicket = deliveredEmails.length;
  failNextEmail = true;
  const generatedTicketResponse = await request(`/api/bookings/${ticketBooking.id}/ticket/generate`, {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {}
  });
  const generatedTicketBody = await generatedTicketResponse.text();
  assert.equal(generatedTicketResponse.status, 200, generatedTicketBody);
  const generatedTicketResult = JSON.parse(generatedTicketBody);
  const generatedTicket = generatedTicketResult.ticket;
  assert.equal(generatedTicket.status, 'READY');
  assert.equal(generatedTicketResult.email.status, 'FAILED', 'email failure is returned independently after files are saved');
  assert.match(generatedTicket.fileName, /^SAFAR-KAABE-Booking-Voucher-.*\.pdf$/);
  assert.match(generatedTicket.jpgFileName, /^SAFAR-KAABE-Booking-Voucher-.*\.jpg$/);
  assert.ok(generatedTicket.documentReference);
  const ownerBookings = await (await request('/api/bookings', { cookie: customerCookie })).json();
  const travelerTicketBooking = ownerBookings.bookings.find(item => item.id === ticketBooking.id);
  assert.equal(travelerTicketBooking.ticketStatus, 'READY', 'the ready ticket appears in My Trips data');
  assert.equal(travelerTicketBooking.ticketEmailStatus, 'FAILED', 'email failure is tracked separately from ticket generation');
  assert.equal(travelerTicketBooking.agencyLogoData, tinyPng, 'the ticket card receives the assigned agency logo');
  assert.equal(deliveredEmails.length, emailsBeforeTicket, 'failed SMTP delivery does not count as a sent email');

  const ticketPdfResponse = await request(`/api/bookings/${ticketBooking.id}/ticket.pdf`, { cookie: customerCookie });
  assert.equal(ticketPdfResponse.status, 200);
  assert.equal(ticketPdfResponse.headers.get('content-type'), 'application/pdf');
  assert.match(ticketPdfResponse.headers.get('content-disposition'), /^inline;/);
  const ticketPdf = Buffer.from(await ticketPdfResponse.arrayBuffer());
  assert.equal(ticketPdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(ticketPdf.toString('latin1').includes('%%EOF'));
  assert.match(ticketPdf.toString('latin1'), /\/MediaBox\s+\[0\s+0\s+792\s+310\]/, 'the PDF uses the supplied landscape boarding-pass layout');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = `${path.resolve(path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '..', '..', 'standard_fonts').split(path.sep).join('/')}/`;
  const parsedTicketLoadingTask = pdfjs.getDocument({ data: new Uint8Array(ticketPdf), standardFontDataUrl });
  const parsedTicketPdf = await parsedTicketLoadingTask.promise;
  assert.equal(parsedTicketPdf.numPages, 1);
  const ticketPdfText = (await (await parsedTicketPdf.getPage(1)).getTextContent()).items.map(item => item.str).join(' ');
  assert.match(ticketPdfText, /Traveler One/, 'ticket text is drawn in the PDF rather than flattened to an image');
  assert.match(ticketPdfText, /SAFAR KAABE/);
  assert.match(ticketPdfText, /BOOKING CONFIRMATION/);
  assert.match(ticketPdfText, /BXX/);
  assert.match(ticketPdfText, /NBO/);
  assert.match(ticketPdfText, /not an airline(?:-issued)? boarding pass/i);
  assert.match(ticketPdfText, /SCAN TO VERIFY/);
  assert.doesNotMatch(ticketPdfText, /\b(?:GATE|SEAT|BOARDING TIME|FLIGHT NUMBER|TICKET NUMBER)\b/i,
    'unverified airline details are not invented for the booking confirmation');
  await parsedTicketLoadingTask.destroy();
  const ticketPdfDownloadResponse = await request(`/api/bookings/${ticketBooking.id}/ticket.pdf?download=1`, { cookie: customerCookie });
  assert.equal(ticketPdfDownloadResponse.status, 200);
  assert.equal(ticketPdfDownloadResponse.headers.get('content-type'), 'application/pdf');
  assert.match(ticketPdfDownloadResponse.headers.get('content-disposition'), /^attachment;/);
  assert.equal(Buffer.from(await ticketPdfDownloadResponse.arrayBuffer()).subarray(0, 5).toString('ascii'), '%PDF-');
  const ticketJpgResponse = await request(`/api/bookings/${ticketBooking.id}/ticket.jpg?download=1`, { cookie: customerCookie });
  assert.equal(ticketJpgResponse.status, 200);
  assert.equal(ticketJpgResponse.headers.get('content-type'), 'image/jpeg');
  assert.match(ticketJpgResponse.headers.get('content-disposition'), /^attachment;/);
  const ticketJpg = Buffer.from(await ticketJpgResponse.arrayBuffer());
  const ticketJpgMetadata = await sharp(ticketJpg).metadata();
  assert.equal(ticketJpgMetadata.format, 'jpeg');
  assert.ok(ticketJpgMetadata.width >= 2800 && ticketJpgMetadata.height >= 1100, 'the ticket JPG is rendered at print-friendly resolution');
  const ticketGeneratorSource = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(ticketGeneratorSource.includes("booking.travelerName || 'Traveler'"), 'the voucher uses the booking passenger');
  assert.ok(ticketGeneratorSource.includes('CONFIRMED TRAVEL DATE'), 'the voucher includes the confirmed travel date');
  assert.ok(ticketGeneratorSource.includes('booking.specs') && ticketGeneratorSource.includes('booking.baggage'), 'the ticket includes available trip details');
  assert.ok(ticketGeneratorSource.includes('const jpg = await createTicketJpgBuffer(pdf);'), 'the JPG is rasterized from the generated PDF');
  const invalidVerification = await request(`/api/tickets/${generatedTicket.id}/verify?token=invalid`);
  assert.equal(invalidVerification.status, 404);
  assert.doesNotMatch(await invalidVerification.text(), /Traveler One/, 'invalid verification never exposes passenger details');

  const unauthorizedTicketRead = await request(`/api/bookings/${ticketBooking.id}/ticket.pdf`, { cookie: secondCustomerCookie });
  assert.equal(unauthorizedTicketRead.status, 404, 'another traveler cannot download this ticket');
  const unauthenticatedTicketRead = await request(`/api/bookings/${ticketBooking.id}/ticket.pdf`);
  assert.equal(unauthenticatedTicketRead.status, 401, 'ticket downloads require authentication');

  const emailRetryResponse = await request(`/api/bookings/${ticketBooking.id}/ticket/email`, {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {}
  });
  assert.equal(emailRetryResponse.status, 200);
  assert.equal((await emailRetryResponse.json()).email.status, 'SENT');
  assert.equal(deliveredEmails.length, emailsBeforeTicket + 1);
  assert.match(deliveredEmails.at(-1).body, /My Trips &amp; Vouchers|My Trips & Vouchers/);
  assert.match(deliveredEmails.at(-1).body, /ticket\.pdf/);
  assert.match(deliveredEmails.at(-1).body, /ticket\.jpg/);
  assert.match(deliveredEmails.at(-1).body, /download=(?:3D)?1/);
  assert.match(deliveredEmails.at(-1).body, /Traveler One/);
  assert.match(deliveredEmails.at(-1).body, /Travel Partner/);
  assert.match(deliveredEmails.at(-1).body, /Content-Type: application\/pdf/);
  assert.match(deliveredEmails.at(-1).body, /Content-Type: image\/jpeg/);
  const repeatTicketGeneration = await request(`/api/bookings/${ticketBooking.id}/ticket/generate`, {
    method: 'POST',
    cookie: ticketAgencyCookie,
    csrf: ticketAgencyCsrf,
    body: {}
  });
  assert.equal(repeatTicketGeneration.status, 200);
  assert.equal(deliveredEmails.length, emailsBeforeTicket + 1, 'repeated ticket retries do not resend an already delivered email');
  const ticketDbCheck = new DatabaseSync(path.join(dataDir, 'safar-kaabe.sqlite'));
  assert.equal(ticketDbCheck.prepare('SELECT COUNT(*) AS count FROM booking_documents WHERE booking_id = ?').get(ticketBooking.id).count, 1);
  const storedTicket = ticketDbCheck.prepare('SELECT pdf_storage_path, jpg_storage_path, document_version, layout_version, status, email_delivery_status FROM booking_documents WHERE booking_id = ?').get(ticketBooking.id);
  assert.equal(storedTicket.status, 'READY');
  assert.equal(storedTicket.layout_version, 4);
  assert.equal(storedTicket.email_delivery_status, 'SENT');
  assert.ok(storedTicket.pdf_storage_path && storedTicket.jpg_storage_path);
  assert.equal(ticketDbCheck.prepare('SELECT attempts FROM booking_document_deliveries WHERE document_id = (SELECT id FROM booking_documents WHERE booking_id = ?)').get(ticketBooking.id).attempts, 2);
  ticketDbCheck.close();
  const legacyLayoutDb = new DatabaseSync(path.join(dataDir, 'safar-kaabe.sqlite'));
  legacyLayoutDb.prepare("UPDATE booking_documents SET layout_version = 1, source_hash = 'previous-ticket-layout' WHERE booking_id = ?").run(ticketBooking.id);
  legacyLayoutDb.close();
  const travelerBookingsAfterLayoutUpdate = await (await request('/api/bookings', { cookie: customerCookie })).json();
  assert.equal(travelerBookingsAfterLayoutUpdate.bookings.find(item => item.id === ticketBooking.id).ticketRetryAvailable, 1,
    'existing tickets are offered a refresh after the ticket layout changes');
  const refreshedLayoutResponse = await request(`/api/bookings/${ticketBooking.id}/ticket/generate`, {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {}
  });
  assert.equal(refreshedLayoutResponse.status, 200);
  assert.equal((await refreshedLayoutResponse.json()).ticket.version, 2, 'layout refresh creates a new ticket version');
  assert.equal(deliveredEmails.length, emailsBeforeTicket + 2, 'the refreshed ticket version is emailed once');
  const versionChangeDb = new DatabaseSync(path.join(dataDir, 'safar-kaabe.sqlite'));
  versionChangeDb.prepare('UPDATE bookings SET travel_date = ?, phone = ? WHERE id = ?').run('2099-03-21', '+252612345678', ticketBooking.id);
  versionChangeDb.close();
  const versionedTicketResponse = await request(`/api/bookings/${ticketBooking.id}/ticket/generate`, {
    method: 'POST',
    cookie: ticketAgencyCookie,
    csrf: ticketAgencyCsrf,
    body: {}
  });
  assert.equal(versionedTicketResponse.status, 200);
  const versionedTicket = (await versionedTicketResponse.json()).ticket;
  assert.equal(versionedTicket.version, 3, 'changed confirmed itinerary creates a new document version');
  assert.match(versionedTicket.documentReference, /-V3$/);
  assert.equal(deliveredEmails.length, emailsBeforeTicket + 3, 'a new document version is emailed once');
  const versionedJpgResponse = await request(`/api/bookings/${ticketBooking.id}/ticket.jpg`, { cookie: customerCookie });
  assert.equal(versionedJpgResponse.status, 200);
  const versionedJpg = Buffer.from(await versionedJpgResponse.arrayBuffer());
  assert.notDeepEqual(versionedJpg, ticketJpg, 'a changed confirmed itinerary generates a newly populated voucher image');
  const historyDb = new DatabaseSync(path.join(dataDir, 'safar-kaabe.sqlite'));
  assert.equal(historyDb.prepare('SELECT COUNT(*) AS count FROM booking_document_versions WHERE booking_id = ?').get(ticketBooking.id).count, 2);
  assert.equal(historyDb.prepare('SELECT document_version FROM booking_document_deliveries WHERE document_id = (SELECT id FROM booking_documents WHERE booking_id = ?)').get(ticketBooking.id).document_version, versionedTicket.version);
  historyDb.close();

  const approvedVoucherOfferResponse = await request('/api/catalog', {
    method: 'POST',
    cookie: ticketAgencyCookie,
    csrf: ticketAgencyCsrf,
    body: {
      category: 'FLIGHT',
      title: 'Approved voucher generation test flight',
      origin: 'MGQ',
      destination: 'NBO',
      price: 300,
      available: 1,
      travelDate: '2099-03-22',
      specs: 'Confirmed itinerary test',
      published: true
    }
  });
  assert.equal(approvedVoucherOfferResponse.status, 201);
  const approvedVoucherOffer = (await approvedVoucherOfferResponse.json()).product;
  const approvedVoucherBookingResponse = await request('/api/bookings', {
    method: 'POST',
    cookie: customerCookie,
    csrf: customerCsrf,
    body: {
      offerId: approvedVoucherOffer.id,
      travelerName: 'Approval Voucher Traveler',
      phone: '+252611234567',
      paymentMethod: 'REQUEST_ONLY'
    }
  });
  assert.equal(approvedVoucherBookingResponse.status, 201);
  const approvedVoucherBooking = (await approvedVoucherBookingResponse.json()).booking;
  const approvedVoucherResponse = await request(`/api/bookings/${approvedVoucherBooking.id}`, {
    method: 'PATCH',
    cookie: ticketAgencyCookie,
    csrf: ticketAgencyCsrf,
    body: { action: 'ACCEPT' }
  });
  assert.equal(approvedVoucherResponse.status, 200);
  const approvedVoucherResult = await approvedVoucherResponse.json();
  assert.equal(approvedVoucherResult.booking.state, 'ACCEPTED');
  assert.equal(approvedVoucherResult.ticket.status, 'READY', 'agency approval with confirmed itinerary automatically creates the voucher');
  assert.equal(approvedVoucherResult.ticketError, null);
  const approvedVoucherBookings = await (await request('/api/bookings', { cookie: customerCookie })).json();
  assert.equal(approvedVoucherBookings.bookings.find(item => item.id === approvedVoucherBooking.id).ticketStatus, 'READY',
    'the automatically issued voucher appears in My Trips & Vouchers');
  const approvedVoucherPdf = await request(`/api/bookings/${approvedVoucherBooking.id}/ticket.pdf?download=1`, { cookie: customerCookie });
  assert.equal(approvedVoucherPdf.status, 200);
  assert.equal(approvedVoucherPdf.headers.get('content-type'), 'application/pdf');
  const approvedVoucherJpg = await request(`/api/bookings/${approvedVoucherBooking.id}/ticket.jpg?download=1`, { cookie: customerCookie });
  assert.equal(approvedVoucherJpg.status, 200);
  assert.equal(approvedVoucherJpg.headers.get('content-type'), 'image/jpeg');

  const leakedDatabase = await request('/data/safar-kaabe.sqlite');
  assert.equal(leakedDatabase.status, 404);

  for (let imageNumber = 1; imageNumber <= 9; imageNumber += 1) {
    const carouselImage = await request(`/image%20${imageNumber}.jpg`);
    assert.equal(carouselImage.status, 200, `carousel image ${imageNumber} should be served`);
    assert.equal(carouselImage.headers.get('content-type'), 'image/jpeg');
    assert.ok((await carouselImage.arrayBuffer()).byteLength > 0);
  }
  for (const size of [16, 32, 48, 64, 128, 180, 192, 256, 512]) {
    const iconResponse = await request(`/safar_kaabe_logo_${size}x${size}.png`);
    assert.equal(iconResponse.status, 200, `logo icon ${size}x${size} should be served`);
    const icon = Buffer.from(await iconResponse.arrayBuffer());
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
  }
  const maskableIcon = await request('/safar_kaabe_logo_maskable_512x512.png');
  assert.equal(maskableIcon.status, 200);
  const maskableIconImage = Buffer.from(await maskableIcon.arrayBuffer());
  assert.equal(maskableIconImage.readUInt32BE(16), 512);
  assert.equal(maskableIconImage.readUInt32BE(20), 512);
  for (const size of [16, 32, 48, 64, 128, 180, 192, 256, 512]) {
    const iconResponse = await request(`/safar_kaabe_icon_${size}x${size}.png`);
    assert.equal(iconResponse.status, 200, `brand-mark icon ${size}x${size} should be served`);
    const icon = Buffer.from(await iconResponse.arrayBuffer());
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
  }
  const appMaskableIcon = await request('/safar_kaabe_icon_maskable_512x512.png');
  assert.equal(appMaskableIcon.status, 200);
  const appMaskableIconImage = Buffer.from(await appMaskableIcon.arrayBuffer());
  assert.equal(appMaskableIconImage.readUInt32BE(16), 512);
  assert.equal(appMaskableIconImage.readUInt32BE(20), 512);
  for (const [asset, contentType] of [['/logo-mark.png', 'image/png'], ['/logo.jpeg', 'image/jpeg']]) {
    const logoResponse = await request(asset);
    assert.equal(logoResponse.status, 200);
    assert.equal(logoResponse.headers.get('content-type'), contentType);
    assert.ok((await logoResponse.arrayBuffer()).byteLength > 0);
  }
  const appPage = await request('/the%20style.html');
  assert.equal(appPage.status, 200);
  const appMarkup = await appPage.text();
  assert.match(appMarkup, /id="conversationAdminRecipientType"[\s\S]*?id="conversationAdminRecipient"/);
  assert.match(appMarkup, /function renderAdminConversationRecipients\(\)/);
  assert.match(appMarkup, /newConversationButton'\)\.classList\.remove\('hidden'\)/);
  assert.match(appMarkup, /conversationRecipientAgencyField'\)\.classList\.toggle\('hidden', !isClient\)/);
  assert.match(appMarkup, /conversationSupportField'\)\.classList\.toggle\('hidden', !isClient\)/);
  assert.match(appMarkup, /id="authModeLogin"[\s\S]*?id="authModeRegister"[\s\S]*?id="authContinueAsGuest"[\s\S]*?<form id="authForm"/);
  assert.match(appMarkup, /id="activeConversationCallButton"[^>]*startConversationCall\('AUDIO'\)/);
  assert.match(appMarkup, /id="activeConversationVideoButton"[^>]*startConversationCall\('VIDEO'\)/);
  assert.match(appMarkup, /id="chatDesktopRail"[^>]*aria-label="Chat sections"/);
  assert.match(appMarkup, /id="conversationSearch"[^>]*placeholder="Search or start a new chat"/);
  assert.match(appMarkup, /id="chatDashboardBackButton"[^>]*onclick="closeMessagingCenter\(\)"[^>]*aria-label="Back to dashboard"/);
  assert.match(appMarkup, /id="conversationFilterFavorites"[^>]*setConversationFilter\('favorites'\)/);
  assert.match(appMarkup, /id="conversationMessageSearch"[^>]*filterConversationMessages\(this\.value\)/);
  assert.match(appMarkup, /Provider-confirmed WaafiPay receipt/);
  assert.match(appMarkup, /registration\.update\(\)/);
  assert.match(appMarkup, /navigator\.serviceWorker\.addEventListener\('controllerchange'/);
  assert.match(appMarkup, /updateViaCache: 'none'/);
  const serviceWorkerSource = await fs.readFile(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(serviceWorkerSource, /safar-kaabe-v91/);
  assert.match(appMarkup, /id="notificationsButton"/);
  assert.match(appMarkup, /function enableWebPush()/);
  assert.match(appMarkup, /function toggleConversationFavorite\(id, event\)/);
  assert.match(appMarkup, /if \(travelDateInput\.value && travelDateInput\.value < today\) travelDateInput\.value = ''/);
  assert.doesNotMatch(appMarkup, /if \(!travelDateInput\.value \|\| travelDateInput\.value < today\) travelDateInput\.value = today/);
  assert.match(appMarkup, /function filterConversationMessages\(query\)/);
  assert.match(appMarkup, /id="chatStatusSection"/);
  assert.match(appMarkup, /#chatStatusViewer \.status-story-photo \{ display: block; width: 100%; height: 100%; object-fit: contain; background: #101820; \}/);
  assert.match(appMarkup, /aspect-ratio: 9 \/ 16/);
  assert.match(appMarkup, /id="chatStatusOwnerActions" class="hidden flex flex-col gap-1"/);
  assert.match(appMarkup, /function editViewedChatStatus\(\)/);
  assert.match(appMarkup, /function deleteViewedChatStatus\(\)/);
  assert.match(appMarkup, /\.app-loading-indicator \{ display: none !important; \}/);
  assert.doesNotMatch(appMarkup, /filter: blur\(1\.5px\) saturate\(1\.24\)/);
  assert.match(appMarkup, /id="newConversationButton"[^>]*aria-label="New chat"/);
  assert.match(appMarkup, /id="chatCallOverlay"[^>]*role="dialog"/);
  assert.match(appMarkup, /new RTCPeerConnection\(\{ iceServers \}\)/);
  assert.match(appMarkup, /async function acceptIncomingCall\(\)/);
  assert.match(appMarkup, /async function pollCallSignals\(\)/);
  assert.match(appMarkup, /async function recoverFailedCallConnection\(\)/);
  assert.match(appMarkup, /id="chatCallRemoteVideo" autoplay playsinline/);
  assert.match(appMarkup, /id="chatCallMuteButton"/);
  assert.match(appMarkup, /id="chatCallSwitchCameraButton"[^>]*onclick="switchCallCamera\(\)"/);
  assert.match(appMarkup, /function startCallRingtone\(isIncoming\)/);
  assert.match(appMarkup, /function stopCallRingtone\(\)/);
  assert.match(appMarkup, /Connected · \$\{String\(Math\.floor\(elapsedSeconds \/ 60\)\)/);
  assert.match(appMarkup, /id="welcomeOnboarding"[^>]*role="dialog"/);
  assert.match(appMarkup, /function showOnboardingIfNeeded\(\)/);
  assert.doesNotMatch(appMarkup, /if \(!setupRequired\) showOnboardingIfNeeded\(\)/);
  assert.match(appMarkup, /class="customer-hero flex w-full flex-col items-center justify-between gap-6[^"]*md:flex-row"/);
  assert.match(appMarkup, /aria-labelledby="popularRoutesHeading" class="space-y-3"/);
  assert.doesNotMatch(appMarkup, /#view_CUSTOMER > \.customer-hero,[\s\S]*?display: none !important/);
  assert.match(appMarkup, /id="sharedExploreSection"[^>]*aria-label="Travel inspiration for all users"/);
  assert.match(appMarkup, /id="globalExploreCarouselHost"[^>]*><\/div>/);
  assert.match(appMarkup, /customer-hero flex w-full flex-col items-center justify-between gap-6[^"]*md:flex-row/);
  assert.match(appMarkup, /exploreCarousel" class="w-full shrink-0 md:w-\[25rem\]"/);
  assert.match(appMarkup, /globalExploreCarouselHost'\)\.appendChild\(document\.querySelector\('\.customer-hero'\)\)/);
  assert.match(appMarkup, /Available trips/);
  assert.match(appMarkup, /No available trips match these details/);
  assert.match(appMarkup, /Choose a travel company/);
  assert.match(appMarkup, /All travel companies/);
  assert.match(appMarkup, /Trips update automatically about every 15 seconds/);
  assert.match(appMarkup, /id="agencyOwnerFields"/);
  assert.match(appMarkup, /function editAgency\(agencyId\)/);
  assert.match(appMarkup, /function deleteAgency\(agencyId\)/);
  assert.match(appMarkup, /onclick="editAgency\(/);
  assert.match(appMarkup, /onclick="deleteAgency\(/);
  assert.match(appMarkup, /airport codes use three letters/i);
  assert.match(appMarkup, /id="bookingSeatCount"[^>]*oninput="updateFinancialEngineView\(\)"/);
  assert.match(appMarkup, /seatCount,\s*paymentMethod/);
  assert.match(appMarkup, /seatCount > Number\(selectedOffer\.available\)/);
  assert.match(appMarkup, /Choose between 1 and \$\{Number\(selectedOffer\.available\) \|\| 0\} available seats/);
  assert.match(appMarkup, /scrollIntoView\(\{/);
  assert.match(appMarkup, /Send booking request/);
  assert.match(appMarkup, /<body class="min-h-screen flex selection:bg-emerald-500 selection:text-black">/);
  assert.match(appMarkup, /<div id="appLoadingIndicator" class="app-loading-indicator hidden"/);
  assert.doesNotMatch(appMarkup, /body\.app-starting/);
  assert.match(appMarkup, /\[class\*="bg-emerald-"\][\s\S]*?background-color: transparent !important/);
  assert.match(appMarkup, /\.onboarding-next \{ border: 1px solid #C909E6; background: transparent;/);
  assert.match(appMarkup, /class="rounded-xl border border-\[#C909E6\]\/40 bg-transparent[^"]*"/);
  assert.match(appMarkup, /function startCustomerOfferRefresh\(\)/);
  assert.match(appMarkup, /}, 15_000\)/);
  assert.match(appMarkup, /document\.addEventListener\('visibilitychange', refreshOnReturn\)/);
  assert.match(appMarkup, /window\.addEventListener\('online', refreshOnReturn\)/);
  assert.match(appMarkup, /window\.addEventListener\('focus', refreshOnReturn\)/);
  assert.match(appMarkup, /refreshCustomerOffers\(\)\.catch/);
  assert.match(appMarkup, /#C909E6/);
  assert.match(appMarkup, /function advanceOnboarding\(\)/);
  assert.match(appMarkup, /function finishOnboarding\(mode = 'guest'\)/);
  assert.match(appMarkup, /Continue as Guest/);
  assert.match(appMarkup, /Continue as Guest|Browse as a guest/);
  assert.match(appMarkup, /id="searchMaxPrice"[^>]*oninput="renderCatalog\(\)"/);
  assert.match(appMarkup, /id="travelerSearchFilters"[^>]*role="search"[\s\S]*?Where would you like to go\?[\s\S]*?id="searchOrigin" type="text" placeholder="City or airport name"/);
  assert.match(appMarkup, /id="searchOriginHelp"[^>]*>For example: Baidoa or BXX\./);
  assert.match(appMarkup, /id="searchDateHelp"[^>]*>Optional — choose a date to narrow your search\./);
  assert.match(appMarkup, /id="findTripsButton" type="button" onclick="performGlobalSearch\(\)"/);
  assert.doesNotMatch(appMarkup, /id="searchOrigin"[^>]*value="BXX - Baidoa"/);
  assert.doesNotMatch(appMarkup, /#sharedExploreSection,[\s\S]*?#view_CUSTOMER #popularRoutesSection,[\s\S]*?#view_CUSTOMER #categoryTabs \{[\s\S]*?display: none !important/);
  assert.match(appMarkup, /id="supNewImage" type="file" accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(appMarkup, /function previewSupplierProductImage\(input\)/);
  assert.match(appMarkup, /offer\.imageUrl \? `<img src=/);
  assert.match(appMarkup, /id="supNewTitleEn"[^>]*required aria-label="Ticket or service name"/);
  assert.match(appMarkup, /id="supNewPrice"[^>]*required aria-label="Price in US dollars"/);
  assert.match(appMarkup, /id="searchSort" onchange="renderCatalog\(\)"/);
  assert.match(appMarkup, /function selectPopularRoute\(origin, destination\)/);
  assert.match(appMarkup, /function getDestinationDisplayName\(destinationCode\)/);
  assert.match(appMarkup, /item\.agencyId === agencyFilter/);
  assert.match(appMarkup, /Mogadishu[\s\S]*?Nairobi/);
  assert.match(appMarkup, /Trips update automatically about every 15 seconds/i);
  assert.match(appMarkup, /role="tablist" aria-label="Filter travel offers by category"/);
  assert.match(appMarkup, /function handleCategoryTabKeydown\(event\)/);
  assert.match(appMarkup, /currentCategory === 'ALL' \|\| item\.category === currentCategory/);
  const serviceWorker = await request('/sw.js');
  assert.equal(serviceWorker.status, 200);
  const serviceWorkerText = await serviceWorker.text();
  assert.match(serviceWorkerText, /const CACHE_NAME = 'safar-kaabe-v91'/);
  assert.match(serviceWorkerText, /const CORE_FILES = \['\.\/', '\.\/the%20style\.html', '\.\/manifest\.webmanifest'\]/);
  assert.match(serviceWorkerText, /Promise\.allSettled\(APP_FILES\.map\(path => cache\.add\(path\)\)\)/);
  assert.doesNotMatch(serviceWorkerText, /'\.\/logo\.jpeg'/);
  const deploymentConfig = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  for (const functionConfig of Object.values(deploymentConfig.functions)) {
    assert.match(functionConfig.includeFiles, /safar_kaabe_\*\.png/, 'all PWA icon assets are included in the Vercel function bundle');
  }
  assert.match(serviceWorkerText, /if \(request\.mode === 'navigate'\) \{\s*event\.respondWith\(fetch\(request\)/);
  assert.match(appMarkup, /My Trips & Vouchers/);
  assert.match(appMarkup, /id="myTripsSearch"/);
  assert.match(appMarkup, /id="myTripsFilter"/);
  assert.match(appMarkup, /Download JPG/);
  assert.match(appMarkup, /downloadBookingDocument\(bookingId, type\)/);
  assert.match(appMarkup, /async function fetchTicketDocumentBlob\(bookingId, type\)/);
  assert.match(appMarkup, /credentials: 'same-origin'[\s\S]*?cache: 'no-store'/);
  assert.match(appMarkup, /String\.fromCharCode\(\.\.\.signature\) === '%PDF-'/);
  assert.match(appMarkup, /async function showTicketJpgFallback\(message\)/);
  assert.match(appMarkup, /registration\.update\(\),\s*fetch\('\/api\/app-version'/);
  assert.match(appMarkup, /fetch\('\/api\/app-version', \{ cache: 'no-store', credentials: 'same-origin' \}\)/);
  assert.match(appMarkup, /previousRelease !== releaseId[\s\S]*?window\.location\.reload\(\)/,
    'installed app reloads when the production deployment changes');
  assert.match(appMarkup, /document\.addEventListener\('visibilitychange', \(\) => \{ void checkForAppUpdate\(\); \}\)/);
  assert.match(appMarkup, /window\.setInterval\(\(\) => \{ void checkForAppUpdate\(\); \}, 5 \* 60 \* 1000\)/,
    'installed app checks for remote releases every five minutes while visible');
  assert.match(appMarkup, /Retry Voucher Generation/);
  assert.match(appMarkup, /const result = await apiRequest\(`\/api\/bookings\/\$\{encodeURIComponent\(bookingId\)\}\/ticket\/generate`[\s\S]*?result\.ticket\?\.status === 'READY'[\s\S]*?await openBookingTicket\(bookingId\)/,
    'successful ticket generation immediately opens the saved document preview');
  assert.match(appMarkup, /openBookingPdf\(bookingId\)/);
  assert.match(appMarkup, /zoomTicketPreview\(change\)/);
  assert.match(appMarkup, /retryBookingTicketEmail\(bookingId\)/);
  assert.match(appMarkup, /id="ticketPdfFrame"[^>]*onload="ticketPdfFrameLoaded\(\)"/);
  assert.match(appMarkup, /id="ticketPdfRetryButton"/);
  assert.match(appMarkup, /const realtime = await apiRequest\('\/api\/catalog\/realtime'\)[\s\S]*?if \(!realtime\.supported \|\| requestId !== notificationRealtimeRequestId \|\| !currentUser\) return;[\s\S]*?new EventSource\('\/api\/notifications\/stream'\)/,
    'notification EventSource is only opened when the server supports persistent realtime connections');
  assert.match(appMarkup, /<img src="logo-mark\.png" alt="" aria-hidden="true" \/>/);
  assert.match(appMarkup, /apple-touch-icon" sizes="180x180" href="safar_kaabe_icon_180x180\.png"/);
  const appManifest = await (await request('/manifest.webmanifest')).json();
  assert.ok(appManifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(appManifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(appManifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  assert.match(appMarkup, /id="mobileMenuTrigger"/);
  assert.match(appMarkup, /<header id="appHeader"[^>]*>[\s\S]*?id="mobileMenuTrigger"/);
  assert.match(appMarkup, /id="headerSearchBar"/);
  assert.match(appMarkup, /id="mobileHeaderMessagesButton"/);
  assert.match(appMarkup, /id="mobileHeaderNotificationsButton"[^>]*aria-label="Open notifications"/);
  assert.match(appMarkup, /#mobileHeaderMessagesButton,\s*#mobileHeaderNotificationsButton \{ display: none !important; \}/,
    'the large mobile-only header controls stay hidden on desktop');
  assert.match(appMarkup, /#appHeader > #headerSearchBar[\s\S]*?flex: 1 1 auto;/);
  assert.match(appMarkup, /#appHeader > div:last-child > #mobileHeaderMessagesButton,\s*#appHeader > div:last-child > #mobileHeaderNotificationsButton \{ display: flex !important; \}/);
  assert.match(appMarkup, /#mobileHeaderNotificationsButton\[hidden\] \{ display: none !important; \}/);
  assert.match(appMarkup, /id="mobileHeaderNotificationsBadge"/);
  assert.match(appMarkup, /#appHeader \{[\s\S]*?position: sticky;[\s\S]*?background: #071426;/);
  assert.match(appMarkup, /#appHeaderLogo \{ display: block; width: 2\.25rem; height: 2\.25rem;/);
  assert.match(appMarkup, /#appHeader \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(appMarkup, /#categoryTabs \{[\s\S]*?flex-wrap: nowrap;[\s\S]*?overflow-x: auto;/);
  assert.match(appMarkup, /#headerSearchBar input \{ min-height: 2\.75rem; font-size: 16px;/);
  assert.match(appMarkup, /id="globalSearchInput"[^>]*placeholder="Search travel"/);
  assert.doesNotMatch(appMarkup, /id="mobileSearchInput"/);
  assert.match(appMarkup, /function updateGlobalSearch\(value\) \{[\s\S]*?globalSearchQuery = value;/);
  assert.match(appMarkup, /function renderAdditionalSearchMatches\(query\)/);
  assert.match(appMarkup, /booking\.ref, booking\.pnr, booking\.travelerName/);
  assert.match(appMarkup, /function openConversationFromSearch\(id\)/);
  assert.equal((appMarkup.match(/class="explore-slide(?: hidden)?"/g) || []).length, 9);
  assert.match(appMarkup, /<div id="mobileMenuPanel"[\s\S]*?id="mobileMenuRole"/);
  assert.doesNotMatch(appMarkup.match(/<div id="mobileMenuPanel"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '', /<img\b/);
  assert.match(appMarkup, /async function openMessagingCenter/);
  assert.match(appMarkup, /onclick="openMessagingCenter\(\)" id="sidebar_MESSAGES"/);
  assert.match(appMarkup, /id="appContent"/);
  assert.match(appMarkup, /id="messagesPage"[^>]*role="region"/);
  assert.doesNotMatch(appMarkup.match(/<div id="messagesPage"[^>]*>/)?.[0] || '', /role="dialog"|aria-modal="true"/);
  assert.match(appMarkup, /document\.body\.classList\.add\('messages-page-open'\)/);
  assert.match(appMarkup, /document\.body\.classList\.remove\('messages-page-open'\)/);
  assert.match(appMarkup, /body\.messages-page-open > #appContent/);
  assert.match(appMarkup, /id="conversationSearch"[^>]*oninput="filterConversations\(this\.value\)"/);
  assert.match(appMarkup, /function filterConversations\(query\)/);
  assert.match(appMarkup, /#messagesPage #conversationMessages > div\.self-end > div \{ background: rgba\(255,255,255,\.035\) !important; \}/);
  assert.match(appMarkup, /object-fit: contain;/);
  assert.match(appMarkup, /\.explore-carousel-frame \{[\s\S]*?aspect-ratio: 5 \/ 4;/);
  assert.match(appMarkup, /\.explore-slide::before \{[\s\S]*?background-size: cover;[\s\S]*?filter: blur\(1rem\)/);
  assert.match(appMarkup, /new URL\(image\.getAttribute\('src'\), document\.baseURI\)\.href/);
  assert.match(appMarkup, /\.explore-carousel-frame \{[\s\S]*?aspect-ratio: 16 \/ 10;/);
  assert.match(appMarkup, /\.explore-carousel-frame \{[\s\S]*?width: 100%;/);
  assert.match(appMarkup, /min-height: 0;/);
  assert.match(appMarkup, /\.explore-carousel-frame \{[\s\S]*?aspect-ratio: 16 \/ 10;/);
  assert.doesNotMatch(appMarkup, /function updateExploreCarouselAspectRatio\(\)/);
  assert.match(appMarkup, /async function continueToAndroidExplore\(\)/);
  assert.match(appMarkup, /onclick="continueToAndroidExplore\(\)"/);
  assert.match(appMarkup, /classList\.toggle\('hidden', IS_ANDROID_APP\)/);
  assert.match(appMarkup, /AGENCY: canAccessPortal\('AGENCY'\)/);
  assert.match(appMarkup, /SUPPLIER: canAccessPortal\('SUPPLIER'\)/);
  assert.match(appMarkup, /ADMIN: canAccessPortal\('ADMIN'\)/);
  assert.doesNotMatch(appMarkup, /mobileNavigation button\[aria-label="Inventory management"\]/);
  assert.match(appMarkup, /Agency \/ staff sign in/);
  assert.match(appMarkup, /id="mobileTravelerSignInButton" onclick="openAuthGate\('login'\); closeMobileMenu\(\)"/);
  assert.match(appMarkup, /id="mobileTravelerSignUpButton" onclick="openAuthGate\('register'\); closeMobileMenu\(\)"/);
  assert.match(appMarkup, /id="mobileStaffSignInButton" onclick="openAuthGate\('login'\); closeMobileMenu\(\)"/);
  assert.match(appMarkup, /mobileTravelerSignUpButton'\)\.classList\.toggle\('hidden', !guest\)/);
  assert.match(appMarkup, /Agency staff, Super Admin and traveler accounts/);
  assert.match(appMarkup, /Choose an offer above to start a request\./);
  assert.match(appMarkup, /Compare trusted agencies for flights, stays, and tours, with clear support from booking through your return\./);
  assert.match(appMarkup, /id="conversationMessages"[^>]*>\s*<div class="m-auto w-full max-w-sm text-center/);
  assert.match(appMarkup, /id="conversationFilterUnread"[^>]*onclick="setConversationFilter\('unread'\)"/);
  assert.match(appMarkup, /function setConversationFilter\(filter\)/);
  assert.match(appMarkup, /data-conversation-unread="\$\{Number\(conversation\.unreadCount \|\| 0\) > 0\}"/);
  assert.match(appMarkup, /id="messagesLayout" class="messages-layout/);
  assert.match(appMarkup, /id="activeConversationBack"[^>]*onclick="showConversationList\(\)"/);
  assert.match(appMarkup, /function showConversationList\(\)/);
  assert.match(appMarkup, /messages-conversation-open > section \{ display: flex; \}/);
  assert.match(appMarkup, /id="activeConversationRecipient"/);
  assert.match(appMarkup, /response\.status >= 500 \? `\$\{message\} \(\$\{endpoint\}\)` : message/);
  assert.match(appMarkup, /\/api\/auth\/password-reset\/request/);
  assert.match(appMarkup, /\/api\/auth\/password-reset\/complete/);
  assert.match(appMarkup, /function togglePasswordVisibility\(inputId, button\)/);
  const passwordInputs = [...appMarkup.matchAll(/<input\b[^>]*type="password"[^>]*>/g)];
  assert.ok(passwordInputs.length > 0);
  for (const [passwordInput] of passwordInputs) {
    const inputId = passwordInput.match(/\bid="([^"]+)"/)?.[1];
    assert.ok(inputId, 'each password input has a stable ID');
    assert.match(appMarkup, new RegExp(`togglePasswordVisibility\\('${inputId}', this\\)`), `${inputId} has a visibility toggle`);
  }
  assert.match(appMarkup, /Choose an approved travel agency/);
  assert.match(appMarkup, /No approved agencies available/);
  assert.match(appMarkup, /Select an approved travel agency, or choose platform support instead/);
  assert.match(appMarkup, /sender address alone cannot send mail/);
  assert.match(appMarkup, /document\.getElementById\('resetAccountEmail'\)\.readOnly = false/);
  assert.doesNotMatch(appMarkup, /Amina|Hassan|\+252610000000|13 Baidoa travel partners/);
  assert.equal((await request('/%2e%2e%2fpackage.json')).status, 403);

  const logout = await request('/api/auth/logout', { method: 'POST', cookie: customerCookie, csrf: customerCsrf });
  assert.equal(logout.status, 200);
  assert.equal((await (await request('/api/auth/session', { cookie: customerCookie })).json()).user, null);

});
