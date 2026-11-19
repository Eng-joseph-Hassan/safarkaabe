'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createDatabase } = require('../../../database');

// A real 1x1 PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function startServer({ preSql } = {}) {
  delete process.env.SAFAR_PLUGINS_DISABLED;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-plugin-'));
  const db = createDatabase({ dataDir, databaseUrl: '' });
  await db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, phone TEXT,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'AGENCY', 'CLIENT')), agency_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT, target TEXT, created_at TEXT)
  `);
  const now = new Date().toISOString();
  const users = {
    admin: { id: 'u-admin', role: 'SUPER_ADMIN', name: 'Admin', email: 'admin@example.com', phone: '+252610000001' },
    seller: { id: 'u-seller', role: 'CLIENT', name: 'Seller', email: 'seller@example.com', phone: '+252610000002' },
    buyer: { id: 'u-buyer', role: 'CLIENT', name: 'Buyer', email: 'buyer@example.com', phone: '+252610000003' },
    other: { id: 'u-other', role: 'AGENCY', name: 'Agency Staff', email: 'agency@example.com', phone: '+252610000004', agency_id: 'a1' }
  };
  for (const user of Object.values(users)) {
    await db.prepare(`INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, agency_id, created_at)
      VALUES (?, ?, ?, ?, 's', 'h', ?, ?, ?)`).run(user.id, user.email, user.name, user.phone, user.role, user.agency_id || null, now);
  }

  if (preSql) await db.exec(preSql);
  const notifications = [];
  const audits = [];
  const failRecipients = new Set();
  const sendJson = (response, status, payload) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  };
  const requireString = (value, field, max = 160) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
      throw Object.assign(new Error(`${field} is required and must be no longer than ${max} characters.`), { statusCode: 400 });
    }
    return value.trim();
  };
  const ctx = {
    db,
    runInTransaction: callback => db.transaction(callback),
    nowIso: () => new Date().toISOString(),
    sendJson,
    readJson(request, maxBytes = 16_384) {
      return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', chunk => {
          body += chunk;
          if (body.length > maxBytes) reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        });
        request.on('end', () => {
          try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { statusCode: 400 })); }
        });
      });
    },
    requireRole(response, user, roles) {
      if (!user) { sendJson(response, 401, { error: 'Sign in to continue.' }); return false; }
      if (!roles.includes(user.role)) { sendJson(response, 403, { error: 'Not allowed.' }); return false; }
      return true;
    },
    authorizeMutation: () => true,
    requireString,
    normalizeEmail(value) {
      const email = requireString(value, 'Email', 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Enter a valid email address.'), { statusCode: 400 });
      return email;
    },
    validatePassword(value) {
      if (typeof value !== 'string' || value.length < 12) throw Object.assign(new Error('Password must be at least 12 characters long.'), { statusCode: 400 });
      return value;
    },
    async hashPassword(password) {
      const salt = crypto.randomBytes(8).toString('hex');
      return { salt, hash: crypto.createHash('sha256').update(salt + password).digest('hex') };
    },
    // Like the host's recipient_user_id REFERENCES users: a missing user (or a forced failure) throws for the whole call.
    async createNotifications(items) {
      for (const item of items) {
        const exists = await db.prepare('SELECT id FROM users WHERE id = ?').get(item.recipientUserId);
        if (!exists || failRecipients.has(item.recipientUserId)) throw new Error('FOREIGN KEY constraint failed');
      }
      notifications.push(...items);
      return items;
    },
    async audit(actorId, action, target) { audits.push({ actorId, action, target }); },
    validateImageData(data, mime) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime) || !/^[A-Za-z0-9+/=]+$/.test(data)) {
        throw Object.assign(new Error('Choose a PNG, JPEG, or WebP image.'), { statusCode: 400 });
      }
      return data;
    }
  };

  // Load the loader fresh so each test server gets its own plugin state.
  for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}plugins${path.sep}`)) delete require.cache[key];
  const loader = require('../../loader');
  await loader.initPlugins(ctx);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const id = request.headers['x-test-user'];
      let session = null;
      if (id) {
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (user) session = { user, session: { csrf_hash: 'x' } };
      }
      if (await loader.handlePluginRequest(request, response, url, session)) return;
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, error.statusCode || 500, { error: error.message });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, pathname, { as, body } = {}) {
    const headers = {};
    if (as) headers['x-test-user'] = users[as]?.id || as;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, headers: response.headers };
  }

  async function close() {
    await new Promise(resolve => server.close(resolve));
    await db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { call, close, db, users, notifications, audits, loader, failRecipients };
}

async function withSeller(t) {
  const app = await startServer();
  t.after(() => app.close());
  const added = await app.call('POST', '/api/store/sellers', { as: 'admin', body: { email: 'seller@example.com' } });
  assert.equal(added.status, 201);
  return app;
}

async function addProduct(app, body) {
  const result = await app.call('POST', '/api/store/products', {
    as: 'seller',
    body: { title: 'Logo design', category: 'DESIGN', price: 25, stock: 5, description: 'A clean logo.', ...body }
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.product;
}

test('loader serves the client script and script tags', async t => {
  const app = await startServer();
  t.after(() => app.close());
  assert.match(app.loader.pluginScriptTags(), /<script defer src="\/plugins\/anfac-media-store\/client\.js"><\/script>/);
  const script = await app.call('GET', '/plugins/anfac-media-store/client.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /text\/javascript/);
  assert.equal(script.headers.get('cache-control'), 'no-cache');
  assert.match(script.data.toString(), /storePluginModal/);
  // Light theme keeps success text readable, and typing in search only re-renders the product list.
  assert.match(script.data.toString(), /html\[data-theme="light"\] #storePluginModal .store-ok-text/);
  assert.match(script.data.toString(), /id="storeProductList"/);
  const info = await app.call('GET', '/api/store/info');
  assert.equal(info.status, 200);
  assert.equal(info.data.store.name, 'ANFAC MEDIA');
  assert.equal(info.data.isSeller, false);
  assert.equal(info.data.canManageSellers, false);
  assert.equal((await app.call('GET', '/api/store/info', { as: 'admin' })).data.canManageSellers, true);
  assert.equal((await app.call('GET', '/api/other')).status, 404);
});

test('only sellers can add, edit and delete products; public list hides unpublished', async t => {
  const app = await withSeller(t);
  assert.equal((await app.call('POST', '/api/store/products', { body: { title: 'x', category: 'DESIGN', price: 1 } })).status, 401);
  assert.equal((await app.call('POST', '/api/store/products', { as: 'buyer', body: { title: 'x', category: 'DESIGN', price: 1 } })).status, 403);
  assert.equal((await app.call('POST', '/api/store/products', { as: 'admin', body: { title: 'x', category: 'DESIGN', price: 1 } })).status, 403);
  assert.equal((await app.call('POST', '/api/store/products', { as: 'seller', body: { title: 'x', category: 'FOOD', price: 1 } })).status, 400);
  assert.equal((await app.call('POST', '/api/store/products', { as: 'seller', body: { title: 'x', category: 'DESIGN', price: 0 } })).status, 400);
  assert.equal((await app.call('POST', '/api/store/products', { as: 'seller', body: { title: 'x', category: 'DESIGN', price: 1, stock: 1.5 } })).status, 400);
  assert.equal((await app.call('POST', '/api/store/products', { as: 'seller', body: { title: 'x'.repeat(121), category: 'DESIGN', price: 1 } })).status, 400);

  const visible = await addProduct(app, { title: 'Wedding video' });
  assert.equal(visible.priceCents, 2500);
  const hidden = await addProduct(app, { title: 'Secret draft', isPublished: false, stock: null });
  assert.equal(hidden.stock, null);

  const publicList = await app.call('GET', '/api/store/products');
  assert.deepEqual(publicList.data.products.map(product => product.title), ['Wedding video']);
  assert.equal((await app.call('GET', '/api/store/products?manage=1', { as: 'buyer' })).status, 403);
  assert.equal((await app.call('GET', '/api/store/products?manage=1', { as: 'seller' })).data.products.length, 2);

  assert.equal((await app.call('PATCH', `/api/store/products/${visible.id}`, { as: 'buyer', body: { price: 1 } })).status, 403);
  const edited = await app.call('PATCH', `/api/store/products/${visible.id}`, { as: 'seller', body: { price: 30.5, isPublished: false } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.product.priceCents, 3050);
  assert.equal(edited.data.product.isPublished, false);
  assert.equal((await app.call('GET', '/api/store/products')).data.products.length, 0);

  assert.equal((await app.call('DELETE', `/api/store/products/${hidden.id}`, { as: 'buyer' })).status, 403);
  assert.equal((await app.call('DELETE', `/api/store/products/${hidden.id}`, { as: 'seller' })).status, 200);
  assert.equal((await app.call('DELETE', `/api/store/products/${hidden.id}`, { as: 'seller' })).status, 404);
  assert.ok(app.audits.some(entry => entry.action === 'STORE_PRODUCT_DELETED'));
});

test('product image is public only while published', async t => {
  const app = await withSeller(t);
  const product = await addProduct(app, { imageData: PNG_BASE64, imageMime: 'image/png' });
  assert.equal(product.hasImage, true);
  const image = await app.call('GET', `/api/store/products/${product.id}/image`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(image.data, Buffer.from(PNG_BASE64, 'base64'));
  assert.equal((await app.call('POST', '/api/store/products', { as: 'seller', body: { title: 'x', category: 'DESIGN', price: 1, imageData: PNG_BASE64, imageMime: 'image/gif' } })).status, 400);

  await app.call('PATCH', `/api/store/products/${product.id}`, { as: 'seller', body: { isPublished: false } });
  assert.equal((await app.call('GET', `/api/store/products/${product.id}/image`)).status, 404);
  assert.equal((await app.call('GET', `/api/store/products/${product.id}/image`, { as: 'seller' })).status, 200);
  await app.call('PATCH', `/api/store/products/${product.id}`, { as: 'seller', body: { removeImage: true } });
  assert.equal((await app.call('GET', `/api/store/products/${product.id}/image`, { as: 'seller' })).status, 404);
});

test('orders decrement stock, use server prices, and reject out-of-stock with 409', async t => {
  const app = await withSeller(t);
  const logo = await addProduct(app, { title: 'Logo', price: 25, stock: 3 });
  const video = await addProduct(app, { title: 'Video', price: 100, stock: null });

  assert.equal((await app.call('POST', '/api/store/orders', { body: { items: [{ productId: logo.id, quantity: 1 }], phone: '+252611111111' } })).status, 401);
  assert.equal((await app.call('POST', '/api/store/orders', { as: 'buyer', body: { items: [], phone: '+252611111111' } })).status, 400);
  assert.equal((await app.call('POST', '/api/store/orders', { as: 'buyer', body: { items: [{ productId: logo.id, quantity: 0 }] } })).status, 400);

  const placed = await app.call('POST', '/api/store/orders', {
    as: 'buyer',
    body: { items: [{ productId: logo.id, quantity: 2, priceCents: 1, unitCents: 1 }, { productId: video.id, quantity: 1, price: 0.01 }], phone: '+252 61 111 1111', note: 'Blue colors', totalCents: 5 }
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  const order = placed.data.order;
  assert.match(order.reference, /^AM-[A-Z0-9]{6}$/);
  assert.equal(order.status, 'NEW');
  assert.equal(order.totalCents, 2 * 2500 + 10000);
  assert.equal(order.paymentMethod, 'PAY_SELLER');
  assert.equal(order.items.length, 2);
  assert.deepEqual(order.allowedActions, ['CANCEL']);

  const products = (await app.call('GET', '/api/store/products')).data.products;
  assert.equal(products.find(product => product.id === logo.id).stock, 1);
  assert.equal(products.find(product => product.id === video.id).stock, null);

  const tooMany = await app.call('POST', '/api/store/orders', { as: 'other', body: { items: [{ productId: video.id, quantity: 1 }, { productId: logo.id, quantity: 2 }] } });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.data.error, /Only 1 left of "Logo"/);
  // The whole order rolled back, so no order exists for that buyer.
  assert.equal((await app.call('GET', '/api/store/orders', { as: 'other' })).data.orders.length, 0);

  const sellerNotes = app.notifications.filter(note => note.type === 'STORE_ORDER_NEW');
  assert.equal(sellerNotes.length, 1);
  assert.equal(sellerNotes[0].recipientUserId, app.users.seller.id);
  assert.equal(sellerNotes[0].href, `/?storeOrder=${order.id}`);

  await app.call('PATCH', `/api/store/products/${logo.id}`, { as: 'seller', body: { isPublished: false } });
  const hiddenOrder = await app.call('POST', '/api/store/orders', { as: 'other', body: { items: [{ productId: logo.id, quantity: 1 }] } });
  assert.equal(hiddenOrder.status, 409);
});

test('buyers see only their own orders and can cancel while NEW, which restores stock', async t => {
  const app = await withSeller(t);
  const product = await addProduct(app, { stock: 4 });
  const mine = (await app.call('POST', '/api/store/orders', { as: 'buyer', body: { items: [{ productId: product.id, quantity: 3 }] } })).data.order;
  const theirs = (await app.call('POST', '/api/store/orders', { as: 'other', body: { items: [{ productId: product.id, quantity: 1 }] } })).data.order;

  const myList = (await app.call('GET', '/api/store/orders', { as: 'buyer' })).data.orders;
  assert.deepEqual(myList.map(order => order.id), [mine.id]);
  assert.equal((await app.call('GET', '/api/store/orders?manage=1', { as: 'buyer' })).status, 403);
  assert.equal((await app.call('GET', '/api/store/orders', { as: 'buyer' })).data.orders.some(order => order.id === theirs.id), false);
  assert.equal((await app.call('PATCH', `/api/store/orders/${theirs.id}`, { as: 'buyer', body: { action: 'CANCEL' } })).status, 404);
  assert.equal((await app.call('PATCH', `/api/store/orders/${mine.id}`, { as: 'buyer', body: { action: 'CONFIRM' } })).status, 403);

  const cancelled = await app.call('PATCH', `/api/store/orders/${mine.id}`, { as: 'buyer', body: { action: 'CANCEL' } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.order.status, 'CANCELLED');
  const stock = (await app.call('GET', '/api/store/products')).data.products[0].stock;
  assert.equal(stock, 3);
  assert.ok(app.notifications.some(note => note.type === 'STORE_ORDER_UPDATE' && note.recipientUserId === app.users.seller.id));

  // Buyer cannot cancel after the seller confirms.
  assert.equal((await app.call('PATCH', `/api/store/orders/${theirs.id}`, { as: 'seller', body: { action: 'CONFIRM' } })).status, 200);
  const late = await app.call('PATCH', `/api/store/orders/${theirs.id}`, { as: 'other', body: { action: 'CANCEL' } });
  assert.equal(late.status, 409);
});

test('seller moves orders through valid steps only and buyers are notified', async t => {
  const app = await withSeller(t);
  const product = await addProduct(app, { stock: 2 });
  const order = (await app.call('POST', '/api/store/orders', { as: 'buyer', body: { items: [{ productId: product.id, quantity: 2 }] } })).data.order;

  const all = await app.call('GET', '/api/store/orders?manage=1', { as: 'seller' });
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.orders[0].allowedActions, ['CONFIRM', 'CANCEL']);

  assert.equal((await app.call('PATCH', `/api/store/orders/${order.id}`, { as: 'seller', body: { action: 'DELIVER' } })).status, 409);
  assert.equal((await app.call('PATCH', `/api/store/orders/${order.id}`, { as: 'seller', body: { action: 'FLY' } })).status, 400);
  for (const [action, status] of [['CONFIRM', 'CONFIRMED'], ['START', 'IN_PROGRESS'], ['READY', 'READY']]) {
    const result = await app.call('PATCH', `/api/store/orders/${order.id}`, { as: 'seller', body: { action } });
    assert.equal(result.status, 200);
    assert.equal(result.data.order.status, status);
  }
  assert.equal((await app.call('PATCH', `/api/store/orders/${order.id}`, { as: 'seller', body: { action: 'START' } })).status, 409);
  assert.equal((await app.call('PATCH', `/api/store/orders/${order.id}`, { as: 'seller', body: { action: 'CANCEL' } })).status, 400);
  const cancelled = await app.call('PATCH', `/api/store/orders/${order.id}`, { as: 'seller', body: { action: 'CANCEL', reason: 'Out of paper' } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.order.cancelReason, 'Out of paper');
  assert.equal((await app.call('GET', '/api/store/products')).data.products[0].stock, 2);
  assert.equal((await app.call('PATCH', `/api/store/orders/${order.id}`, { as: 'seller', body: { action: 'DELIVER' } })).status, 409);

  const buyerNotes = app.notifications.filter(note => note.type === 'STORE_ORDER_UPDATE' && note.recipientUserId === app.users.buyer.id);
  assert.equal(buyerNotes.length, 4);
  assert.ok(buyerNotes.every(note => note.href === `/?storeOrder=${order.id}`));

  const second = (await app.call('POST', '/api/store/orders', { as: 'buyer', body: { items: [{ productId: product.id, quantity: 1 }] } })).data.order;
  for (const action of ['CONFIRM', 'READY', 'DELIVER']) {
    assert.equal((await app.call('PATCH', `/api/store/orders/${second.id}`, { as: 'seller', body: { action } })).status, 200);
  }
  assert.equal((await app.call('GET', '/api/store/products')).data.products[0].stock, 1);
});

test('super admin manages sellers', async t => {
  const app = await startServer();
  t.after(() => app.close());
  assert.equal((await app.call('GET', '/api/store/sellers', { as: 'buyer' })).status, 403);
  assert.equal((await app.call('GET', '/api/store/sellers')).status, 401);
  assert.equal((await app.call('POST', '/api/store/sellers', { as: 'buyer', body: { email: 'buyer@example.com' } })).status, 403);
  assert.equal((await app.call('POST', '/api/store/sellers', { as: 'admin', body: { email: 'nobody@example.com' } })).status, 404);

  const added = await app.call('POST', '/api/store/sellers', { as: 'admin', body: { email: 'SELLER@example.com' } });
  assert.equal(added.status, 201);
  assert.equal((await app.call('POST', '/api/store/sellers', { as: 'admin', body: { email: 'seller@example.com' } })).status, 409);
  assert.equal((await app.call('GET', '/api/store/info', { as: 'seller' })).data.isSeller, true);

  assert.equal((await app.call('POST', '/api/store/sellers', { as: 'admin', body: { name: 'New', email: 'buyer@example.com', password: 'a-long-password-123' } })).status, 409);
  assert.equal((await app.call('POST', '/api/store/sellers', { as: 'admin', body: { name: 'New', email: 'new@example.com', password: 'short' } })).status, 400);
  const created = await app.call('POST', '/api/store/sellers', { as: 'admin', body: { name: 'ANFAC Staff', email: 'staff@anfac.example', password: 'a-long-password-123' } });
  assert.equal(created.status, 201);
  const account = await app.db.prepare('SELECT role, password_hash FROM users WHERE email = ?').get('staff@anfac.example');
  assert.equal(account.role, 'CLIENT');
  assert.notEqual(account.password_hash, 'a-long-password-123');

  const list = await app.call('GET', '/api/store/sellers', { as: 'admin' });
  assert.deepEqual(list.data.sellers.map(seller => seller.email).sort(), ['seller@example.com', 'staff@anfac.example']);

  const removed = await app.call('DELETE', '/api/store/sellers', { as: 'admin', body: { userId: app.users.seller.id } });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.sellers.length, 1);
  assert.equal((await app.call('DELETE', '/api/store/sellers', { as: 'admin', body: { userId: app.users.seller.id } })).status, 404);
  assert.equal((await app.call('GET', '/api/store/info', { as: 'seller' })).data.isSeller, false);
  assert.ok(['STORE_SELLER_ADDED', 'STORE_SELLER_ACCOUNT_CREATED', 'STORE_SELLER_REMOVED'].every(action => app.audits.some(entry => entry.action === action)));
});

test('sellers whose accounts were deleted are ignored, and one failed notification does not block the others', async t => {
  const app = await withSeller(t);
  const staff = await app.call('POST', '/api/store/sellers', { as: 'admin', body: { name: 'Staff', email: 'staff@anfac.example', password: 'a-long-password-123' } });
  assert.equal(staff.status, 201);
  const staffId = staff.data.seller.id;
  const ghost = await app.call('POST', '/api/store/sellers', { as: 'admin', body: { name: 'Ghost', email: 'ghost@anfac.example', password: 'a-long-password-123' } });
  const ghostId = ghost.data.seller.id;
  // The host deletes the account; store_members keeps its row.
  await app.db.prepare('DELETE FROM users WHERE id = ?').run(ghostId);
  assert.ok(await app.db.prepare('SELECT user_id FROM store_members WHERE user_id = ?').get(ghostId));

  // The original seller's notification fails for another reason; the staff seller must still be told.
  app.failRecipients.add(app.users.seller.id);
  const product = await addProduct(app, { stock: null });
  const placed = await app.call('POST', '/api/store/orders', { as: 'buyer', body: { items: [{ productId: product.id, quantity: 1 }] } });
  assert.equal(placed.status, 201);
  const newOrderNotes = app.notifications.filter(note => note.type === 'STORE_ORDER_NEW');
  assert.deepEqual(newOrderNotes.map(note => note.recipientUserId), [staffId]);

  const list = await app.call('GET', '/api/store/sellers', { as: 'admin' });
  assert.deepEqual(list.data.sellers.map(seller => seller.id).sort(), [app.users.seller.id, staffId].sort());
  // Listing sellers removes rows for deleted accounts.
  assert.equal(await app.db.prepare('SELECT user_id FROM store_members WHERE user_id = ?').get(ghostId), undefined);
});

test('an order total above the database limit is rejected with 400 and takes no stock', async t => {
  const app = await withSeller(t);
  const products = [];
  for (const title of ['Billboard A', 'Billboard B', 'Billboard C']) products.push(await addProduct(app, { title, price: 100_000, stock: 1000 }));
  const big = await app.call('POST', '/api/store/orders', {
    as: 'buyer', body: { items: products.map(product => ({ productId: product.id, quantity: 100 })) }
  });
  assert.equal(big.status, 400, JSON.stringify(big.data));
  assert.match(big.data.error, /at most/);
  assert.equal((await app.call('GET', '/api/store/orders', { as: 'buyer' })).data.orders.length, 0);
  assert.ok((await app.call('GET', '/api/store/products')).data.products.every(product => product.stock === 1000));
  // Two lines (2,000,000,000 cents) is still allowed.
  const ok = await app.call('POST', '/api/store/orders', {
    as: 'buyer', body: { items: products.slice(0, 2).map(product => ({ productId: product.id, quantity: 100 })) }
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
});

test('cancelling restores only stock the order actually took', async t => {
  const app = await withSeller(t);
  const unlimited = await addProduct(app, { title: 'Unlimited', stock: null });
  const counted = await addProduct(app, { title: 'Counted', stock: 4 });
  const order = (await app.call('POST', '/api/store/orders', {
    as: 'buyer', body: { items: [{ productId: unlimited.id, quantity: 10 }, { productId: counted.id, quantity: 3 }] }
  })).data.order;
  // The seller starts counting stock for the product that was unlimited when it was ordered.
  assert.equal((await app.call('PATCH', `/api/store/products/${unlimited.id}`, { as: 'seller', body: { stock: 5 } })).status, 200);
  assert.equal((await app.call('PATCH', `/api/store/orders/${order.id}`, { as: 'buyer', body: { action: 'CANCEL' } })).status, 200);
  const products = (await app.call('GET', '/api/store/products')).data.products;
  assert.equal(products.find(product => product.id === unlimited.id).stock, 5);
  assert.equal(products.find(product => product.id === counted.id).stock, 4);
});

test('migrate adds stock_reserved to an older order items table', async t => {
  const app = await startServer({ preSql: `CREATE TABLE store_order_items (order_id TEXT NOT NULL, product_id TEXT NOT NULL,
    title TEXT NOT NULL, unit_cents INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY (order_id, product_id))` });
  t.after(() => app.close());
  const columns = (await app.db.prepare('PRAGMA table_info(store_order_items)').all()).map(row => row.name);
  assert.ok(columns.includes('stock_reserved'));
});

test('a plugin can be switched off with SAFAR_PLUGINS_DISABLED', () => {
  process.env.SAFAR_PLUGINS_DISABLED = 'anfac-media-store';
  try {
    for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}plugins${path.sep}`)) delete require.cache[key];
    const loader = require('../../loader');
    assert.equal(loader.discoverPlugins().some(plugin => plugin.folder === 'anfac-media-store'), false);
  } finally {
    delete process.env.SAFAR_PLUGINS_DISABLED;
  }
});
