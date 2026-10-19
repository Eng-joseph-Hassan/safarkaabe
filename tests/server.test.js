const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { SMTPServer } = require('smtp-server');
const { DatabaseSync } = require('node:sqlite');

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
  `);
  legacyDb.close();
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SAFAR_KAABE_DATA_DIR: dataDir,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtpPort),
      SMTP_USER: 'smtp-test-user',
      SMTP_PASS: 'smtp-test-password',
      SMTP_FROM: 'engjoseph250@gmail.com'
    },
    stdio: 'ignore'
  });

  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => smtpServer.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
    const headers = { Origin: baseUrl };
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
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
  assert.equal(ready, true, 'server should start and expose setup status');

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
      destination: 'NBO',
      price: 250,
      available: 2,
      travelDate: '2099-03-20',
      baggage: '20 kg checked',
      specs: 'Direct service',
      published: true
    }
  });
  assert.equal(agencyProductResponse.status, 201);
  const agencyProduct = (await agencyProductResponse.json()).product;
  assert.equal(agencyProduct.agencyId, agency.id, 'agency listings are always assigned to the signed-in agency');
  assert.equal(agencyProduct.available, 2);
  assert.equal(agencyProduct.travelDate, '2099-03-20');
  assert.equal(agencyProduct.published, true);
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
  const agencyConversations = await (await request('/api/conversations', { cookie: agencyCookie })).json();
  assert.equal(agencyConversations.conversations.length, 1);
  assert.equal(agencyConversations.conversations[0].unreadCount, 1);
  assert.equal(agencyConversations.conversations[0].agencyLogoData, tinyPng);
  assert.equal(agencyConversations.conversations[0].customerAvatarData, tinyPng);
  const otherAgencyConversations = await (await request('/api/conversations', { cookie: otherAgencyCookie })).json();
  assert.equal(otherAgencyConversations.conversations.length, 0, 'agency messages are tenant-isolated');
  const crossTenantConversation = await request(`/api/conversations/${conversationId}/messages`, { cookie: otherAgencyCookie });
  assert.equal(crossTenantConversation.status, 404, 'other agencies cannot read a conversation');
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
  assert.equal(booking.financials.customerGrandTotalCents, 16342, 'server computes prices from its own catalog');
  assert.equal(booking.travelDate, null);
  assert.match(booking.pnr, /^PNR-SK-/);
  const customerBookings = await (await request('/api/bookings', { cookie: customerCookie })).json();
  assert.equal(customerBookings.bookings.length, 1);
  const inventoryAfterBooking = await (await request('/api/catalog', { cookie: customerCookie })).json();
  assert.ok(!inventoryAfterBooking.catalog.some(product => product.id === 'legacy-flight-available'), 'sold-out inventory is removed from traveler search');

  const secondCustomerResponse = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Traveler Two', email: 'traveler2@example.com', phone: '+252622222222', password: 'long-enough-second-password' }
  });
  const secondCustomerCookie = cookieJar(secondCustomerResponse);
  const secondBookings = await (await request('/api/bookings', { cookie: secondCustomerCookie })).json();
  assert.equal(secondBookings.bookings.length, 0);

  const adminBookings = await (await request('/api/bookings', { cookie: adminCookie })).json();
  assert.equal(adminBookings.bookings.length, 1);
  assert.equal(adminBookings.bookings[0].ref, booking.reference);

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
  for (const [asset, contentType] of [['/logo-mark.png', 'image/png'], ['/logo.jpeg', 'image/jpeg']]) {
    const logoResponse = await request(asset);
    assert.equal(logoResponse.status, 200);
    assert.equal(logoResponse.headers.get('content-type'), contentType);
    assert.ok((await logoResponse.arrayBuffer()).byteLength > 0);
  }
  const appPage = await request('/the%20style.html');
  assert.equal(appPage.status, 200);
  const appMarkup = await appPage.text();
  assert.match(appMarkup, /<img src="logo-mark\.png" alt="" aria-hidden="true" \/>/);
  assert.match(appMarkup, /apple-touch-icon" sizes="180x180" href="safar_kaabe_logo_180x180\.png"/);
  const appManifest = await (await request('/manifest.webmanifest')).json();
  assert.ok(appManifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(appManifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(appManifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  assert.match(appMarkup, /id="mobileMenuTrigger"/);
  assert.match(appMarkup, /<header id="appHeader"[^>]*>[\s\S]*?id="mobileMenuTrigger"/);
  assert.match(appMarkup, /id="headerSearchBar"/);
  assert.match(appMarkup, /id="mobileHeaderMessagesButton"/);
  assert.match(appMarkup, /#appHeader > #headerSearchBar[\s\S]*?flex: 1 1 auto;/);
  assert.match(appMarkup, /#appHeader > div:last-child > #mobileHeaderMessagesButton \{ display: flex !important; \}/);
  assert.match(appMarkup, /#appHeader \{[\s\S]*?position: sticky;[\s\S]*?background: #071426;/);
  assert.match(appMarkup, /#appHeaderLogo \{ display: block; width: 2\.25rem; height: 2\.25rem;/);
  assert.match(appMarkup, /#appHeader \{[\s\S]*?display: flex;/);
  assert.match(appMarkup, /function renderAdditionalSearchMatches\(query\)/);
  assert.match(appMarkup, /booking\.ref, booking\.pnr, booking\.travelerName/);
  assert.match(appMarkup, /function openConversationFromSearch\(id\)/);
  assert.equal((appMarkup.match(/class="explore-slide(?: hidden)?"/g) || []).length, 9);
  assert.match(appMarkup, /<div id="mobileMenuPanel"[\s\S]*?id="mobileMenuRole"/);
  assert.doesNotMatch(appMarkup.match(/<div id="mobileMenuPanel"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '', /<img\b/);
  assert.match(appMarkup, /async function openMessagingCenter/);
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
