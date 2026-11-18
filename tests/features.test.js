const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

const cookieJar = response => (response.headers.getSetCookie?.() || []).map(cookie => cookie.split(';', 1)[0]).join('; ');
const csrfToken = cookie => (cookie.split('; ').find(part => part.startsWith('sk_csrf=')) || '').slice('sk_csrf='.length);

test('reviews, payment notifications, status audiences and saved offers', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safar-kaabe-features-'));
  const purchases = new Map();
  let paymentStatus = 'PENDING';
  const waafiServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const params = body.serviceParams;
    if (body.serviceName === 'HPP_PURCHASE') {
      purchases.set(params.transactionInfo.referenceId, params.transactionInfo);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        responseCode: '2001', params: { referenceId: params.transactionInfo.referenceId, hppUrl: 'https://checkout.example.test/session', orderId: 'order' }
      }));
      return;
    }
    const transaction = purchases.get(params.referenceId);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      responseCode: '2001',
      params: { referenceId: params.referenceId, transactionId: 'txn-1', status: paymentStatus, tranAmount: transaction.amount, currency: transaction.currency }
    }));
  });
  await new Promise(resolve => waafiServer.listen(0, '127.0.0.1', resolve));

  // Fake Firebase: records the Android push messages the server sends.
  const fcmMessages = [];
  const fcmServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === '/token') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.message.token === 'dead-device-token') {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
      return;
    }
    fcmMessages.push({ authorization: request.headers.authorization, path: request.url, ...body.message });
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"name":"projects/test/messages/1"}');
  });
  await new Promise(resolve => fcmServer.listen(0, '127.0.0.1', resolve));
  const { privateKey } = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const firebaseAccount = JSON.stringify({ project_id: 'safar-test', client_email: 'push@safar-test.iam.example', private_key: privateKey });

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverErrors = '';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), SAFAR_KAABE_DATA_DIR: dataDir,
      WAAFI_MERCHANT_UID: 'TESTMERCHANT', WAAFI_STORE_ID: '12345', WAAFI_HPP_KEY: '01234567890123456789012345678901',
      WAAFI_TEST_ENDPOINT: `http://127.0.0.1:${waafiServer.address().port}/asm`,
      FIREBASE_SERVICE_ACCOUNT: Buffer.from(firebaseAccount).toString('base64'),
      FCM_TOKEN_URL: `http://127.0.0.1:${fcmServer.address().port}/token`,
      FCM_API_BASE: `http://127.0.0.1:${fcmServer.address().port}`
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { serverErrors += chunk; });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => waafiServer.close(resolve));
    await new Promise(resolve => fcmServer.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function request(route, { method = 'GET', body, as } = {}) {
    const headers = { Origin: baseUrl };
    if (as) { headers.Cookie = as.cookie; headers['X-CSRF-Token'] = as.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      throw new Error(`${method} ${route} failed: ${error.message}\n${serverErrors}`, { cause: error });
    }
  }
  const json = async (route, options, expectedStatus = 200) => {
    const response = await request(route, options);
    const payload = await response.json().catch(() => ({}));
    assert.equal(response.status, expectedStatus, `${options?.method || 'GET'} ${route}: ${JSON.stringify(payload)}`);
    return payload;
  };
  const session = response => { const cookie = cookieJar(response); return { cookie, csrf: csrfToken(cookie) }; };

  for (let attempt = 0; attempt < 300; attempt += 1) {
    try { if ((await request('/api/setup/status')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const admin = session(await request('/api/setup/admin', { method: 'POST', body: { name: 'Admin', email: 'admin@example.test', password: 'long-enough-admin-password' } }));
  const { agency } = await json('/api/agencies', { method: 'POST', as: admin, body: {
    name: 'Bay Travel', tier: 'PROFESSIONAL', markupPct: 5, ownerName: 'Agency Owner', ownerEmail: 'owner@bay.test', ownerPassword: 'long-enough-agency-password'
  } }, 201);
  await json(`/api/agencies/${agency.id}/status`, { method: 'PATCH', as: admin, body: { action: 'APPROVE' } });
  const staff = session(await request('/api/auth/login', { method: 'POST', body: { email: 'owner@bay.test', password: 'long-enough-agency-password' } }));
  const traveler = session(await request('/api/auth/register', { method: 'POST', body: { name: 'Amina Hassan Ali', email: 'amina@example.test', phone: '+252600000001', password: 'long-enough-traveler-password' } }));
  const stranger = session(await request('/api/auth/register', { method: 'POST', body: { name: 'Other Traveler', email: 'other@example.test', phone: '+252600000002', password: 'long-enough-traveler-password' } }));
  assert.ok(staff.csrf && traveler.csrf && stranger.csrf);

  const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const { product: flexibleOffer } = await json('/api/catalog', { method: 'POST', as: staff, body: { title: 'Baidoa city tour', destination: 'BDB', category: 'TOUR', price: 50, available: 10 } }, 201);
  const { product: futureOffer } = await json('/api/catalog', { method: 'POST', as: staff, body: { title: 'Mogadishu flight', destination: 'MGQ', origin: 'BXX', category: 'FLIGHT', price: 120, available: 10, travelDate: future } }, 201);

  // ---- Saved offers ----
  assert.equal((await request(`/api/saved-offers/${flexibleOffer.id}`, { method: 'PUT', as: staff })).status, 403, 'only travelers save trips');
  assert.equal((await request('/api/saved-offers')).status, 401, 'guests must sign in to save trips');
  await json(`/api/saved-offers/${flexibleOffer.id}`, { method: 'PUT', as: traveler });
  await json(`/api/saved-offers/${flexibleOffer.id}`, { method: 'PUT', as: traveler }, 200);
  await json(`/api/saved-offers/${futureOffer.id}`, { method: 'PUT', as: traveler });
  assert.equal((await request('/api/saved-offers/does-not-exist', { method: 'PUT', as: traveler })).status, 404);
  let saved = (await json('/api/saved-offers', { as: traveler })).savedOffers;
  assert.deepEqual(saved.map(item => item.id).sort(), [flexibleOffer.id, futureOffer.id].sort());
  assert.ok(saved.every(item => item.bookable === true && item.agencyName === 'Bay Travel'));
  assert.deepEqual((await json('/api/saved-offers', { as: stranger })).savedOffers, [], 'saved trips are private to each traveler');
  await json(`/api/catalog/${futureOffer.id}`, { method: 'PATCH', as: staff, body: { published: false } });
  saved = (await json('/api/saved-offers', { as: traveler })).savedOffers;
  const unpublished = saved.find(item => item.id === futureOffer.id);
  assert.equal(unpublished.bookable, false, 'unpublished saved trips are marked unavailable');
  assert.equal(unpublished.baseUsdCents, undefined, 'unpublished listing details are not exposed');
  await json(`/api/catalog/${futureOffer.id}`, { method: 'PATCH', as: staff, body: { published: true } });
  await json(`/api/saved-offers/${futureOffer.id}`, { method: 'DELETE', as: traveler });
  assert.deepEqual((await json('/api/saved-offers', { as: traveler })).savedOffers.map(item => item.id), [flexibleOffer.id]);

  // ---- Reviews ----
  const { booking: flexibleBooking } = await json('/api/bookings', { method: 'POST', as: traveler, body: { offerId: flexibleOffer.id, travelerName: 'Amina Hassan Ali', phone: '+252600000001' } }, 201);
  const { booking: futureBooking } = await json('/api/bookings', { method: 'POST', as: traveler, body: { offerId: futureOffer.id, travelerName: 'Amina Hassan Ali', phone: '+252600000001' } }, 201);
  assert.equal((await request(`/api/bookings/${flexibleBooking.id}/review`, { method: 'PUT', as: traveler, body: { rating: 5 } })).status, 409, 'pending trips cannot be reviewed');
  await json(`/api/bookings/${flexibleBooking.id}`, { method: 'PATCH', as: staff, body: { action: 'ACCEPT' } });
  await json(`/api/bookings/${futureBooking.id}`, { method: 'PATCH', as: staff, body: { action: 'ACCEPT' } });
  const futureReview = await (await request(`/api/bookings/${futureBooking.id}/review`, { method: 'PUT', as: traveler, body: { rating: 5 } })).json();
  assert.match(futureReview.error, /after your trip/);
  assert.equal((await request(`/api/bookings/${flexibleBooking.id}/review`, { method: 'PUT', as: traveler, body: { rating: 6 } })).status, 400);
  assert.equal((await request(`/api/bookings/${flexibleBooking.id}/review`, { method: 'PUT', as: stranger, body: { rating: 1 } })).status, 404, 'travelers can only review their own trips');
  assert.equal((await request(`/api/bookings/${flexibleBooking.id}/review`, { method: 'PUT', as: staff, body: { rating: 5 } })).status, 403);
  const created = await json(`/api/bookings/${flexibleBooking.id}/review`, { method: 'PUT', as: traveler, body: { rating: 4, comment: 'Helpful team.' } }, 201);
  await json(`/api/bookings/${flexibleBooking.id}/review`, { method: 'PUT', as: traveler, body: { rating: 5, comment: 'Excellent, helpful team.' } });

  const staffNotifications = (await json('/api/notifications', { as: staff })).notifications;
  const reviewNotice = staffNotifications.filter(item => item.type === 'REVIEW_RECEIVED');
  assert.equal(reviewNotice.length, 1, 'agency is notified once about a new review');
  assert.match(reviewNotice[0].body, /Amina A\./);

  let publicReviews = await json(`/api/agencies/${agency.id}/reviews`);
  assert.equal(publicReviews.summary.reviewCount, 1);
  assert.equal(publicReviews.summary.averageRating, 5);
  assert.equal(publicReviews.summary.distribution[5], 1);
  assert.equal(publicReviews.reviews[0].reviewerName, 'Amina A.', 'public reviews show first name and last initial only');
  assert.equal(publicReviews.reviews[0].comment, 'Excellent, helpful team.');
  assert.equal(JSON.stringify(publicReviews).includes('amina@example.test'), false);
  const guestCatalog = (await json('/api/catalog')).catalog;
  assert.ok(guestCatalog.every(offer => offer.agencyRating === 5 && offer.agencyReviewCount === 1), 'offers show the agency rating');

  assert.equal((await request(`/api/reviews/${created.review.id}/reply`, { method: 'PUT', as: traveler, body: { reply: 'x' } })).status, 403);
  await json(`/api/reviews/${created.review.id}/reply`, { method: 'PUT', as: staff, body: { reply: 'Thank you for travelling with us!' } });
  publicReviews = await json(`/api/agencies/${agency.id}/reviews`);
  assert.equal(publicReviews.reviews[0].agencyReply, 'Thank you for travelling with us!');
  const travelerNotifications = (await json('/api/notifications', { as: traveler })).notifications;
  assert.ok(travelerNotifications.some(item => item.type === 'REVIEW_REPLY'), 'traveler is told the agency replied');

  const myBookings = (await json('/api/bookings', { as: traveler })).bookings;
  const reviewedBooking = myBookings.find(item => item.id === flexibleBooking.id);
  assert.equal(reviewedBooking.reviewRating, 5);
  assert.equal(reviewedBooking.reviewEligible, true);
  assert.equal(myBookings.find(item => item.id === futureBooking.id).reviewEligible, false);

  // ---- Payment notifications ----
  const { booking: paidBooking } = await json('/api/bookings', { method: 'POST', as: traveler, body: { offerId: flexibleOffer.id, travelerName: 'Amina Hassan Ali', phone: '+252600000001', paymentMethod: 'WAAFI' } }, 201);
  assert.ok(paidBooking.paymentReference);
  paymentStatus = 'APPROVED';
  await json('/api/payments/waafi/refresh', { method: 'POST', as: traveler, body: { referenceId: paidBooking.paymentReference } });
  await json('/api/payments/waafi/refresh', { method: 'POST', as: traveler, body: { referenceId: paidBooking.paymentReference } });
  const travelerPayments = (await json('/api/notifications', { as: traveler })).notifications.filter(item => item.category === 'PAYMENTS');
  assert.equal(travelerPayments.length, 1, 'payment confirmation is sent once');
  assert.equal(travelerPayments[0].type, 'PAYMENT_CONFIRMED');
  assert.match(travelerPayments[0].body, /confirmed your payment of 70\.50 USD/);
  const agencyPayments = (await json('/api/notifications', { as: staff })).notifications.filter(item => item.category === 'PAYMENTS');
  assert.equal(agencyPayments.length, 1);
  assert.equal(agencyPayments[0].type, 'PAYMENT_RECEIVED');

  const seatsBeforeDecline = (await json('/api/catalog')).catalog.find(item => item.id === flexibleOffer.id).available;
  const { booking: declinedBooking } = await json('/api/bookings', { method: 'POST', as: traveler, body: { offerId: flexibleOffer.id, travelerName: 'Amina Hassan Ali', phone: '+252600000001', paymentMethod: 'WAAFI' } }, 201);
  assert.equal((await json('/api/catalog')).catalog.find(item => item.id === flexibleOffer.id).available, seatsBeforeDecline - 1, 'checkout holds the seat');
  paymentStatus = 'DECLINED';
  await json('/api/payments/waafi/refresh', { method: 'POST', as: traveler, body: { referenceId: declinedBooking.paymentReference } });
  assert.equal((await json('/api/catalog')).catalog.find(item => item.id === flexibleOffer.id).available, seatsBeforeDecline, 'a declined payment returns its seat');
  assert.equal((await json('/api/bookings', { as: traveler })).bookings.find(item => item.id === declinedBooking.id).state, 'CANCELLED');
  const failed = (await json('/api/notifications', { as: traveler })).notifications.filter(item => item.type === 'PAYMENT_FAILED');
  assert.equal(failed.length, 1, 'traveler is told when a payment is not completed');

  // ---- Status audience and views ----
  const { status: contactsStatus } = await json('/api/statuses', { method: 'POST', as: traveler, body: { body: 'Only my contacts', audience: 'CONTACTS' } }, 201);
  const { status: publicStatus } = await json('/api/statuses', { method: 'POST', as: traveler, body: { body: 'Hello everyone' } }, 201);
  assert.equal(publicStatus.audience, 'EVERYONE');
  assert.equal((await request('/api/statuses', { method: 'POST', as: traveler, body: { body: 'x', audience: 'FRIENDS' } })).status, 400);

  const staffStatuses = (await json('/api/statuses', { as: staff })).statuses;
  assert.ok(staffStatuses.some(item => item.id === contactsStatus.id), 'the agency the traveler chatted with is a contact');
  assert.ok(staffStatuses.every(item => item.viewCount === null), 'view counts are only shown to the owner');
  const strangerStatuses = (await json('/api/statuses', { as: stranger })).statuses;
  assert.deepEqual(strangerStatuses.map(item => item.id), [publicStatus.id], 'contacts-only statuses are hidden from non-contacts');
  assert.equal((await request(`/api/statuses/${contactsStatus.id}/views`, { method: 'POST', as: stranger })).status, 404);
  assert.equal((await request(`/api/statuses/${contactsStatus.id}/replies`, { method: 'POST', as: stranger, body: { body: 'hi' } })).status, 404);
  assert.equal((await request(`/api/statuses/${contactsStatus.id}/reactions`, { method: 'POST', as: stranger, body: { emoji: '😍' } })).status, 404);

  await json(`/api/statuses/${contactsStatus.id}/views`, { method: 'POST', as: staff });
  await json(`/api/statuses/${contactsStatus.id}/views`, { method: 'POST', as: staff });
  await json(`/api/statuses/${publicStatus.id}/views`, { method: 'POST', as: stranger });
  await json(`/api/statuses/${contactsStatus.id}/views`, { method: 'POST', as: traveler });
  await json(`/api/statuses/${contactsStatus.id}/reactions`, { method: 'POST', as: staff, body: { emoji: '❤️' } });
  assert.equal((await request(`/api/statuses/${contactsStatus.id}/views`, { as: staff })).status, 403, 'only the owner sees the viewer list');
  const views = await json(`/api/statuses/${contactsStatus.id}/views`, { as: traveler });
  assert.equal(views.viewCount, 1, 'repeat views and the owner’s own views are not counted');
  assert.equal(views.viewers[0].userName, 'Agency Owner');
  assert.equal(views.viewers[0].reaction, '❤️');
  const ownStatuses = (await json('/api/statuses', { as: traveler })).statuses;
  assert.equal(ownStatuses.find(item => item.id === contactsStatus.id).viewCount, 1);
  assert.equal(ownStatuses.find(item => item.id === publicStatus.id).viewCount, 1);
  assert.equal((await json('/api/statuses', { as: staff })).statuses.find(item => item.id === contactsStatus.id).viewedByMe, true);

  await json(`/api/statuses/${publicStatus.id}`, { method: 'PATCH', as: traveler, body: { audience: 'CONTACTS' } });
  assert.deepEqual((await json('/api/statuses', { as: stranger })).statuses, [], 'changing the audience hides the status immediately');
  assert.equal((await request(`/api/statuses/${publicStatus.id}`, { method: 'PATCH', as: stranger, body: { audience: 'EVERYONE' } })).status, 403);

  // ---- Frontend wiring ----
  const markup = await (await request('/the%20style.html')).text();
  for (const pattern of [
    /id="sidebarSavedOffersButton"[^>]*onclick="openSavedOffersModal\(\)"/,
    /id="mobileSavedOffersButton"/,
    /id="savedOffersModal"[^>]*role="dialog"/,
    /function toggleSavedOffer\(offerId, event\)/,
    /id="agencyReviewsModal"[^>]*role="dialog"/,
    /id="reviewEditorModal"[^>]*role="dialog"/,
    /\/api\/bookings\/\$\{encodeURIComponent\(reviewEditorBookingId\)\}\/review/,
    /id="agTab_REVIEWS"/,
    /function saveAgencyReviewReply\(event, reviewId\)/,
    /id="chatStatusAudience"[\s\S]*?value="CONTACTS"/,
    /id="chatStatusOwnerViews"[^>]*onclick="showChatStatusViews\(\)"/,
    /\/api\/statuses\/\$\{encodeURIComponent\(status\.id\)\}\/views/,
    /item\.type === 'REVIEW_RECEIVED'/
  ]) assert.match(markup, pattern);

  // ---- Review removal ----
  await json(`/api/bookings/${flexibleBooking.id}/review`, { method: 'DELETE', as: admin });
  assert.equal((await json(`/api/agencies/${agency.id}/reviews`)).summary.reviewCount, 0);
  assert.equal((await json('/api/catalog')).catalog[0].agencyRating, null);

  // ---- Voice messages: byte-range playback and app-recorded duration ----
  const voiceChat = await json('/api/conversations', { method: 'POST', as: traveler, body: { subject: 'Voice note', message: 'Hello', support: true } }, 201);
  const voiceBytes = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 7)]);
  const { message: voiceMessage } = await json(`/api/conversations/${voiceChat.conversation.id}/messages`, { method: 'POST', as: traveler, body: {
    messageType: 'AUDIO', attachmentMime: 'audio/ogg', attachmentName: 'voice-message.ogg', durationMs: 16000,
    attachmentData: `data:audio/ogg;base64,${voiceBytes.toString('base64')}`
  } }, 201);
  assert.equal(voiceMessage.durationMs, 16000);
  const voiceUrl = `${baseUrl}/api/conversations/${voiceChat.conversation.id}/messages/${voiceMessage.id}/attachment`;
  const fullVoice = await fetch(voiceUrl, { headers: { Cookie: traveler.cookie } });
  assert.equal(fullVoice.status, 200);
  assert.equal(fullVoice.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await fullVoice.arrayBuffer()).length, voiceBytes.length);
  const partialVoice = await fetch(voiceUrl, { headers: { Cookie: traveler.cookie, Range: 'bytes=0-3' } });
  assert.equal(partialVoice.status, 206);
  assert.equal(partialVoice.headers.get('content-range'), `bytes 0-3/${voiceBytes.length}`);
  assert.equal(Buffer.from(await partialVoice.arrayBuffer()).toString('ascii'), 'OggS');
  const suffixVoice = await fetch(voiceUrl, { headers: { Cookie: traveler.cookie, Range: 'bytes=-10' } });
  assert.equal(suffixVoice.status, 206);
  assert.equal(Buffer.from(await suffixVoice.arrayBuffer()).length, 10);
  assert.equal((await fetch(voiceUrl, { headers: { Cookie: traveler.cookie, Range: `bytes=${voiceBytes.length}-` } })).status, 416);
  // ---- Support threads notify Super Admins; admins viewing do not mark traveler messages read ----
  const adminNotices = (await json('/api/notifications', { as: admin })).notifications;
  assert.ok(adminNotices.some(item => item.type === 'MESSAGE' && item.conversationId === voiceChat.conversation.id), 'support messages notify Super Admins');
  const agencyChat = await json('/api/conversations', { method: 'POST', as: traveler, body: { subject: 'Trip question', message: 'Is breakfast included?', agencyId: agency.id } }, 201);
  await json(`/api/conversations/${agencyChat.conversation.id}/read`, { method: 'POST', as: admin });
  const unreadForAgency = (await json('/api/conversations', { as: staff })).conversations.find(item => item.id === agencyChat.conversation.id);
  assert.equal(unreadForAgency.unreadCount, 1, 'a Super Admin reading an agency chat does not clear the agency unread count');

  // ---- Blocking ----
  await json('/api/blocks', { method: 'POST', as: staff, body: { conversationId: agencyChat.conversation.id } });
  const blockedSend = await request(`/api/conversations/${agencyChat.conversation.id}/messages`, { method: 'POST', as: traveler, body: { message: 'Hello?' } });
  assert.equal(blockedSend.status, 403, 'a blocked traveler cannot message the agency');
  assert.equal((await request(`/api/conversations/${agencyChat.conversation.id}/calls`, { method: 'POST', as: traveler, body: { callType: 'AUDIO' } })).status, 403, 'a blocked traveler cannot call');
  const staffBlocks = (await json('/api/blocks', { as: staff })).blocks;
  assert.equal(staffBlocks.length, 1);
  assert.equal(staffBlocks[0].name, 'Amina Hassan Ali');
  assert.equal((await json('/api/conversations', { as: staff })).conversations.find(item => item.id === agencyChat.conversation.id).blockedByMe, true);
  await json('/api/blocks', { method: 'DELETE', as: staff, body: { key: staffBlocks[0].key } });
  await json(`/api/conversations/${agencyChat.conversation.id}/messages`, { method: 'POST', as: traveler, body: { message: 'Hello again' } }, 201);

  // ---- Calls: incoming notification and history ----
  const { call } = await json(`/api/conversations/${agencyChat.conversation.id}/calls`, { method: 'POST', as: traveler, body: { callType: 'VIDEO' } }, 201);
  assert.ok((await json('/api/notifications', { as: staff })).notifications.some(item => item.type === 'CALL_INCOMING'), 'the person being called is notified');
  await json(`/api/calls/${call.id}`, { method: 'PATCH', as: staff, body: { action: 'REJECT' } });
  const travelerCalls = (await json('/api/calls/history', { as: traveler })).calls;
  assert.equal(travelerCalls[0].id, call.id);
  assert.equal(travelerCalls[0].direction, 'OUTGOING');
  assert.equal(travelerCalls[0].status, 'REJECTED');
  assert.equal((await json('/api/calls/history', { as: staff })).calls[0].direction, 'INCOMING');

  // ---- Calls: hanging up while ringing is a missed call; device ownership ----
  const { call: cancelledCall } = await json(`/api/conversations/${agencyChat.conversation.id}/calls`, { method: 'POST', as: traveler, body: { callType: 'AUDIO', deviceId: 'phone-1' } }, 201);
  const travelerActive = (await json('/api/calls/active', { as: traveler })).calls.find(item => item.id === cancelledCall.id);
  assert.equal(travelerActive.myDeviceId, 'phone-1', 'the caller sees which of their devices holds the call');
  await json(`/api/calls/${cancelledCall.id}`, { method: 'PATCH', as: traveler, body: { action: 'END' } });
  assert.equal((await json('/api/calls/history', { as: traveler })).calls.find(item => item.id === cancelledCall.id).status, 'MISSED');
  const calleeNotices = [...(await json('/api/notifications', { as: staff })).notifications];
  assert.ok(calleeNotices.some(item => item.type === 'CALL_MISSED' && item.body.includes('Amina')), 'the person called is told about the missed call');

  // ---- Android call alerts (ring when the app is closed) ----
  assert.equal((await request('/api/push/native-tokens', { method: 'POST', as: staff, body: {} })).status, 400);
  assert.equal((await json('/api/push/native-tokens', { method: 'POST', as: staff, body: { token: 'staff-phone-token', platform: 'android' } })).configured, true);
  await json('/api/push/native-tokens', { method: 'POST', as: staff, body: { token: 'dead-device-token', platform: 'android' } });
  fcmMessages.length = 0;
  const { call: pushCall } = await json(`/api/conversations/${agencyChat.conversation.id}/calls`, { method: 'POST', as: traveler, body: { callType: 'VIDEO' } }, 201);
  const ring = fcmMessages.find(item => item.data.type === 'CALL_INCOMING' && item.data.callId === pushCall.id);
  assert.ok(ring, 'the agency phone gets a ringing call alert');
  assert.equal(ring.token, 'staff-phone-token');
  assert.equal(ring.android.priority, 'HIGH');
  assert.equal(ring.android.ttl, '60s', 'a call alert expires once the call stops ringing');
  assert.equal(ring.data.callerName, 'Amina Hassan Ali');
  assert.equal(ring.data.callType, 'VIDEO');
  assert.equal(ring.authorization, 'Bearer fake-access-token');
  assert.match(ring.path, /^\/v1\/projects\/safar-test\/messages:send$/);
  assert.equal((await request(`/api/calls/${pushCall.id}/push-decline`, { method: 'POST', body: { token: 'wrong-token' } })).status, 404);
  assert.equal((await json(`/api/calls/${pushCall.id}/push-decline`, { method: 'POST', body: { token: ring.data.declineToken } })).declined, true,
    'Decline on the notification works without opening the app');
  assert.equal((await json('/api/calls/history', { as: traveler })).calls.find(item => item.id === pushCall.id).status, 'REJECTED');
  assert.ok(fcmMessages.some(item => item.data.type === 'CALL_ENDED' && item.data.callId === pushCall.id && item.data.reason === 'DECLINED'),
    'the ringing stops on every agency phone');
  const { call: answeredCall } = await json(`/api/conversations/${agencyChat.conversation.id}/calls`, { method: 'POST', as: traveler, body: { callType: 'AUDIO' } }, 201);
  await json(`/api/calls/${answeredCall.id}`, { method: 'PATCH', as: staff, body: { action: 'ACCEPT', deviceId: 'laptop' } });
  assert.ok(fcmMessages.some(item => item.data.type === 'CALL_ENDED' && item.data.callId === answeredCall.id && item.data.reason === 'ANSWERED'),
    'answering on one device stops the other devices ringing');
  await json(`/api/calls/${answeredCall.id}`, { method: 'PATCH', as: traveler, body: { action: 'END' } });
  fcmMessages.length = 0;
  await json(`/api/conversations/${agencyChat.conversation.id}/messages`, { method: 'POST', as: traveler, body: { message: 'Are you there?' } }, 201);
  for (let attempt = 0; attempt < 20 && !fcmMessages.some(item => item.data.type === 'MESSAGE'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(fcmMessages.some(item => item.data.type === 'MESSAGE' && item.data.title && item.data.url), 'new messages also reach the phone');
  await json('/api/push/native-tokens', { method: 'DELETE', as: staff, body: { token: 'staff-phone-token' } });

  // ---- Blocking applies to the whole agency, and ends live calls ----
  await json('/api/agency/staff', { method: 'POST', as: staff, body: { name: 'Second Agent', email: 'agent2@bay.test', password: 'long-enough-agent-password' } }, 201);
  const colleague = session(await request('/api/auth/login', { method: 'POST', body: { email: 'agent2@bay.test', password: 'long-enough-agent-password' } }));
  const { call: liveCall } = await json(`/api/conversations/${agencyChat.conversation.id}/calls`, { method: 'POST', as: traveler, body: { callType: 'AUDIO' } }, 201);
  await json('/api/blocks', { method: 'POST', as: colleague, body: { conversationId: agencyChat.conversation.id } });
  assert.equal((await json('/api/calls/history', { as: traveler })).calls.find(item => item.id === liveCall.id).status, 'ENDED', 'blocking hangs up a ringing call');
  assert.equal((await request(`/api/conversations/${agencyChat.conversation.id}/messages`, { method: 'POST', as: staff, body: { message: 'Hi' } })).status, 403,
    'a block by one staff member applies to colleagues');
  assert.equal((await json('/api/blocks', { as: staff })).blocks.length, 1, 'colleagues see the agency block');
  const travelerMessages = (await json(`/api/conversations/${agencyChat.conversation.id}/messages`, { as: traveler })).messages;
  const ownMessage = travelerMessages.find(item => item.body === 'Hello again');
  assert.equal((await request(`/api/conversations/${agencyChat.conversation.id}/messages/${ownMessage.id}`, { method: 'PATCH', as: traveler, body: { message: 'edited while blocked' } })).status, 403,
    'a blocked person cannot edit old messages');
  await json('/api/blocks', { method: 'DELETE', as: staff, body: { key: (await json('/api/blocks', { as: staff })).blocks[0].key } });
  assert.equal((await json('/api/blocks', { as: colleague })).blocks.length, 0, 'any colleague can remove the agency block');

  // ---- Refunds ----
  paymentStatus = 'APPROVED';
  const { booking: refundBooking } = await json('/api/bookings', { method: 'POST', as: traveler, body: { offerId: flexibleOffer.id, travelerName: 'Amina Hassan Ali', phone: '+252600000001', paymentMethod: 'WAAFI' } }, 201);
  await json('/api/payments/waafi/refresh', { method: 'POST', as: traveler, body: { referenceId: refundBooking.paymentReference } });
  await json(`/api/bookings/${refundBooking.id}`, { method: 'PATCH', as: staff, body: { action: 'ACCEPT' } });
  assert.equal((await request(`/api/bookings/${refundBooking.id}`, { method: 'PATCH', as: staff, body: { action: 'MARK_REFUNDED', refundReference: 'EVC-1' } })).status, 409, 'no refund is due before cancellation');
  await json(`/api/bookings/${refundBooking.id}`, { method: 'DELETE', as: staff, body: { reason: 'Flight cancelled by airline', returnSeats: false } });
  let refundState = (await json('/api/bookings', { as: staff })).bookings.find(item => item.id === refundBooking.id);
  assert.equal(refundState.refundStatus, 'NEEDED', 'cancelling a paid booking marks a refund as needed');
  assert.equal((await request(`/api/bookings/${refundBooking.id}`, { method: 'PATCH', as: traveler, body: { action: 'MARK_REFUNDED', refundReference: 'x' } })).status, 403);
  assert.equal((await request(`/api/bookings/${refundBooking.id}`, { method: 'PATCH', as: staff, body: { action: 'MARK_REFUNDED' } })).status, 400, 'a refund reference is required');
  const refunded = await json(`/api/bookings/${refundBooking.id}`, { method: 'PATCH', as: staff, body: { action: 'MARK_REFUNDED', refundReference: 'EVC-778899', refundNote: 'Sent to your EVC number' } });
  assert.equal(refunded.booking.refundStatus, 'REFUNDED');
  assert.equal(refunded.booking.refundReference, 'EVC-778899');
  assert.equal((await request(`/api/bookings/${refundBooking.id}`, { method: 'PATCH', as: staff, body: { action: 'MARK_REFUNDED', refundReference: 'EVC-2' } })).status, 409, 'a refund is recorded once');
  const refundNotice = (await json('/api/notifications', { as: traveler })).notifications.find(item => item.type === 'PAYMENT_REFUNDED');
  assert.match(refundNotice.body, /70\.50 USD.*EVC-778899/);
  refundState = (await json('/api/bookings', { as: traveler })).bookings.find(item => item.id === refundBooking.id);
  assert.equal(refundState.refundStatus, 'REFUNDED', 'the traveler sees the refund');

  // ---- Waitlist ----
  const { product: smallTrip } = await json('/api/catalog', { method: 'POST', as: staff, body: { title: 'Kismayo boat trip', destination: 'KMU', category: 'TOUR', price: 40, available: 1 } }, 201);
  await json(`/api/saved-offers/${smallTrip.id}`, { method: 'PUT', as: stranger });
  assert.equal((await request(`/api/offers/${smallTrip.id}/waitlist`, { method: 'POST', as: stranger, body: { seatCount: 1 } })).status, 409, 'cannot wait for a trip that has seats');
  const { booking: lastSeat } = await json('/api/bookings', { method: 'POST', as: traveler, body: { offerId: smallTrip.id, travelerName: 'Amina Hassan Ali', phone: '+252600000001' } }, 201);
  const soldOutAttempt = await request('/api/bookings', { method: 'POST', as: stranger, body: { offerId: smallTrip.id, travelerName: 'Other Traveler', phone: '+252600000002' } });
  const soldOutPayload = await soldOutAttempt.json();
  assert.equal(soldOutAttempt.status, 409);
  assert.equal(soldOutPayload.waitlistAvailable, true, 'travelers are offered the waitlist when a trip is full');
  const savedSoldOut = (await json('/api/saved-offers', { as: stranger })).savedOffers.find(item => item.id === smallTrip.id);
  assert.equal(savedSoldOut.soldOut, true, 'saved trips show when they are sold out');
  assert.equal((await request(`/api/offers/${smallTrip.id}/waitlist`, { method: 'POST', as: staff })).status, 403, 'only travelers join waitlists');
  await json(`/api/offers/${smallTrip.id}/waitlist`, { method: 'POST', as: stranger, body: { seatCount: 1 } });
  assert.equal((await json('/api/waitlist', { as: stranger })).waitlist.length, 1);
  await json(`/api/bookings/${lastSeat.id}`, { method: 'DELETE', as: traveler, body: { reason: 'Plans changed' } });
  await json('/api/catalog');
  const waitNotice = (await json('/api/notifications', { as: stranger })).notifications.find(item => item.type === 'WAITLIST_SEATS_OPEN');
  assert.ok(waitNotice, 'waitlisted travelers are told when seats open');
  assert.match(waitNotice.href, new RegExp(`trip=${smallTrip.id}`));
  await json('/api/bookings', { method: 'POST', as: stranger, body: { offerId: smallTrip.id, travelerName: 'Other Traveler', phone: '+252600000002' } }, 201);
  assert.equal((await json('/api/waitlist', { as: stranger })).waitlist.length, 0, 'booking the trip removes it from the waitlist');

  // ---- Trip reminders ----
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const { product: tomorrowTrip } = await json('/api/catalog', { method: 'POST', as: staff, body: { title: 'Hargeisa flight', destination: 'HGA', origin: 'MGQ', category: 'FLIGHT', price: 150, available: 5, travelDate: tomorrow } }, 201);
  const { booking: tomorrowBooking } = await json('/api/bookings', { method: 'POST', as: traveler, body: { offerId: tomorrowTrip.id, travelerName: 'Amina Hassan Ali', phone: '+252600000001' } }, 201);
  await json(`/api/bookings/${tomorrowBooking.id}`, { method: 'PATCH', as: staff, body: { action: 'ACCEPT' } });
  const cron = await json('/api/cron/daily');
  assert.ok(cron.ok);
  await json('/api/cron/daily');
  const reminders = (await json('/api/notifications', { as: traveler })).notifications.filter(item => item.type === 'TRIP_REMINDER' && item.bookingId === tomorrowBooking.id);
  assert.equal(reminders.length, 1, 'one reminder is sent the day before the trip');
  assert.match(reminders[0].body, /Hargeisa flight.*tomorrow/);

  // ---- Sales reports ----
  assert.equal((await request('/api/reports/sales', { as: traveler })).status, 403, 'travelers cannot see sales reports');
  assert.equal((await request('/api/reports/sales?from=2026-13-01', { as: staff })).status, 400);
  const report = await json('/api/reports/sales', { as: staff });
  assert.ok(report.totals.requests >= 5);
  assert.ok(report.totals.confirmed >= 2);
  assert.ok(report.totals.salesCents > 0);
  assert.ok(report.byTrip.some(row => row.trip === 'Hargeisa flight' && row.seatsSold === 1));
  assert.equal(report.byMonth.length >= 1, true);
  await json('/api/bookings', { method: 'POST', as: traveler, body: { offerId: flexibleOffer.id, travelerName: '=HYPERLINK("http://bad.test")', phone: '+252600000001' } }, 201);
  const csvResponse = await request('/api/reports/sales?format=csv', { as: staff });
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get('content-type'), /text\/csv/);
  assert.match(csvResponse.headers.get('content-disposition'), /attachment; filename="safar-kaabe-sales-/);
  const csvBytes = Buffer.from(await csvResponse.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'the file starts with a UTF-8 marker so Excel shows Somali names correctly');
  const csvText = csvBytes.subarray(3).toString('utf8');
  assert.match(csvText, /^Booking number,Booked on,Travel date,Trip/);
  assert.match(csvText, /,\+252600000001,/, 'phone numbers are not altered');
  assert.match(csvText, /"'=HYPERLINK\(""http:\/\/bad\.test""\)"/, 'spreadsheet formulas in traveler names are neutralised');
  assert.equal(csvText.includes('Bay Travel'), true);
  const adminReport = await json('/api/reports/sales', { as: admin });
  assert.ok(adminReport.totals.requests >= report.totals.requests, 'admins see all agencies');

  // ---- Appearance choice is saved to the account ----
  assert.equal((await request('/api/auth/theme', { method: 'PATCH', as: traveler, body: { theme: 'purple' } })).status, 400);
  assert.equal((await json('/api/auth/theme', { method: 'PATCH', as: traveler, body: { theme: 'light' } })).user.themePreference, 'light');
  assert.equal((await json('/api/auth/session', { as: traveler })).user.themePreference, 'light', 'the colour choice follows the user to other devices');
  assert.equal((await request('/api/auth/theme', { method: 'PATCH', body: { theme: 'dark' } })).status, 401);

  // ---- Sign-in code setting needs email to be configured ----
  assert.equal((await request('/api/auth/login-code', { method: 'PATCH', as: staff, body: { enabled: true, password: 'long-enough-agency-password' } })).status, 503,
    'sign-in codes cannot be turned on until email sending is set up');
  assert.equal((await json('/api/auth/session', { as: staff })).loginCodesAvailable, false);

  assert.match(markup, /function voicePlayerMarkup\(url, messageId, durationMs\)/);
  assert.doesNotMatch(markup, /<audio class="message-audio" controls/);
  assert.match(markup, /html:not\(\.app-booting\) \.app-loading-indicator \{ display: none !important; \}/);

  assert.doesNotMatch(serverErrors, /TypeError|ReferenceError|SyntaxError|SQLITE_|notification could not be created|Unhandled/, serverErrors);
});
