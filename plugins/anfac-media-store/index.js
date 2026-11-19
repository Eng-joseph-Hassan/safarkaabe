'use strict';

/*
 * ANFAC MEDIA Shop plugin (anfac-media-store)
 *
 * A small product marketplace: the company ANFAC MEDIA sells its own products and services
 * (design, video, photo, printing, branding, web) and signed-in users browse, order and track orders.
 *
 * module.exports = { register(ctx) } -> { name, schema, migrate, handle, clientScript }
 *
 * ctx contract (all provided by the host app):
 *   db                     { exec(sql), prepare(sql).get/all/run(...values), isPostgres }  ('?' placeholders)
 *   runInTransaction(fn)   runs async fn inside one database transaction
 *   nowIso()               current time as an ISO string
 *   sendJson(response, status, payload)
 *   readJson(request, maxBytes) -> Promise<object>   (rejects with error.statusCode 400/413)
 *   requireRole(response, user, roles) -> bool       (sends 401/403 itself when false)
 *   authorizeMutation(request, response, session) -> bool  (CSRF/origin check; sends 403 itself when false)
 *   requireString(value, field, max) -> trimmed string    (throws error.statusCode 400)
 *   normalizeEmail(value) -> lower-case email             (throws error.statusCode 400)
 *   validatePassword(value) -> value                      (throws error.statusCode 400)
 *   hashPassword(password) -> Promise<{ salt, hash }>
 *   createNotifications([{ recipientUserId, type, title, body, href, dedupeKey }])
 *   audit(actorId, action, target)
 *   validateImageData(base64, mime) -> base64             (throws error.statusCode 400)
 *   maxImageBytes          optional number, the largest image validateImageData accepts (default 262144)
 *
 * session passed to handle(): null or { user, session } where user has
 *   id, role ('SUPER_ADMIN' | 'AGENCY' | 'CLIENT'), name, email, phone, agency_id.
 *
 * The host must have a users table (id, email, name, phone, password_salt, password_hash, role, created_at).
 * The plugin never changes core tables. A seller is a normal user (role CLIENT) plus a store_members row.
 *
 * Environment:
 *   STORE_NAME                  shop name shown to users (default "ANFAC MEDIA")
 *   STORE_PAYMENT_INSTRUCTIONS  how buyers pay the seller
 */

const crypto = require('node:crypto');

const PLUGIN_NAME = 'anfac-media-store';
const STORE_ID = 'anfac-media';
const CATEGORIES = ['DESIGN', 'VIDEO', 'PHOTO', 'PRINTING', 'BRANDING', 'WEB', 'OTHER'];
const STATUSES = ['NEW', 'CONFIRMED', 'IN_PROGRESS', 'READY', 'DELIVERED', 'CANCELLED'];
const STATUS_LABELS = {
  NEW: 'Order sent',
  CONFIRMED: 'Confirmed by seller',
  IN_PROGRESS: 'Being made',
  READY: 'Ready',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled'
};
// Seller actions: which status each action moves from, and to.
const SELLER_ACTIONS = {
  CONFIRM: { from: ['NEW'], to: 'CONFIRMED' },
  START: { from: ['CONFIRMED'], to: 'IN_PROGRESS' },
  READY: { from: ['CONFIRMED', 'IN_PROGRESS'], to: 'READY' },
  DELIVER: { from: ['READY'], to: 'DELIVERED' },
  CANCEL: { from: ['NEW', 'CONFIRMED', 'IN_PROGRESS', 'READY'], to: 'CANCELLED' }
};
const BUYER_ACTIONS = { CANCEL: { from: ['NEW'], to: 'CANCELLED' } };
const UPDATE_MESSAGES = {
  CONFIRMED: 'The seller confirmed your order.',
  IN_PROGRESS: 'The seller started working on your order.',
  READY: 'Your order is ready.',
  DELIVERED: 'Your order was delivered. Thank you!',
  CANCELLED: 'Your order was cancelled.'
};

const PRODUCT_BODY_LIMIT = 1_600_000;
// Order totals are stored in INTEGER (int4 on Postgres, max 2,147,483,647), so keep every total below that.
const MAX_ORDER_TOTAL_CENTS = 2_000_000_000;
const SMALL_BODY_LIMIT = 16_384;
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS store_members (
    store_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'SELLER',
    created_at TEXT NOT NULL,
    PRIMARY KEY (store_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS store_products (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'OTHER',
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    stock INTEGER CHECK (stock IS NULL OR stock >= 0),
    image_mime TEXT,
    image_data TEXT,
    is_published INTEGER NOT NULL DEFAULT 1 CHECK (is_published IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS store_products_store_idx ON store_products (store_id, is_published);
  CREATE TABLE IF NOT EXISTS store_orders (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    store_id TEXT NOT NULL,
    buyer_id TEXT NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_phone TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CONFIRMED', 'IN_PROGRESS', 'READY', 'DELIVERED', 'CANCELLED')),
    payment_method TEXT NOT NULL DEFAULT 'PAY_SELLER',
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    cancel_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS store_orders_buyer_idx ON store_orders (buyer_id, created_at);
  CREATE INDEX IF NOT EXISTS store_orders_store_idx ON store_orders (store_id, created_at);
  CREATE TABLE IF NOT EXISTS store_order_items (
    order_id TEXT NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    title TEXT NOT NULL,
    unit_cents INTEGER NOT NULL CHECK (unit_cents >= 0),
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
    stock_reserved INTEGER NOT NULL DEFAULT 1 CHECK (stock_reserved IN (0, 1)),
    PRIMARY KEY (order_id, product_id)
  )
`;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function register(ctx) {
  const required = ['db', 'runInTransaction', 'sendJson', 'readJson', 'requireRole', 'authorizeMutation',
    'requireString', 'normalizeEmail', 'validatePassword', 'hashPassword', 'createNotifications', 'audit', 'validateImageData'];
  for (const key of required) {
    if (!ctx || !ctx[key]) throw new Error(`The ${PLUGIN_NAME} plugin needs ctx.${key}.`);
  }
  const { db, sendJson, readJson } = ctx;
  const nowIso = ctx.nowIso || (() => new Date().toISOString());
  const storeName = String(process.env.STORE_NAME || 'ANFAC MEDIA').trim().slice(0, 80) || 'ANFAC MEDIA';
  const paymentInstructions = String(process.env.STORE_PAYMENT_INSTRUCTIONS ||
    `Pay ${storeName} by EVC Plus, Zaad or cash. The seller will contact you to confirm.`).slice(0, 600);
  const maxImageBytes = Number(ctx.maxImageBytes) > 0 ? Number(ctx.maxImageBytes) : 262_144;

  // ---------- helpers ----------

  // store_members has no foreign key to the host's users table, so a seller row can outlive a deleted account.
  // Every seller lookup joins users so such rows are ignored, and pruneSellers() removes them.
  async function isSeller(user) {
    if (!user) return false;
    return Boolean(await db.prepare(`SELECT store_members.user_id FROM store_members JOIN users ON users.id = store_members.user_id
      WHERE store_members.store_id = ? AND store_members.user_id = ?`).get(STORE_ID, user.id));
  }

  async function sellerIds() {
    return (await db.prepare(`SELECT store_members.user_id FROM store_members JOIN users ON users.id = store_members.user_id
      WHERE store_members.store_id = ?`).all(STORE_ID)).map(row => row.user_id);
  }

  async function pruneSellers() {
    try {
      await db.prepare('DELETE FROM store_members WHERE user_id NOT IN (SELECT id FROM users)').run();
    } catch (error) {
      console.warn(`${PLUGIN_NAME}: could not remove sellers of deleted accounts:`, error.message);
    }
  }

  // One call per recipient, so one bad recipient cannot stop the others from being notified.
  async function notify(items) {
    for (const item of items) {
      try {
        await ctx.createNotifications([item]);
      } catch (error) {
        console.warn(`${PLUGIN_NAME}: notification failed:`, error.message);
      }
    }
  }

  async function hasColumn(table, column) {
    if (db.isPostgres) {
      return Boolean(await db.prepare(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`).get(table, column));
    }
    return (await db.prepare(`PRAGMA table_info(${table})`).all()).some(row => row.name === column);
  }

  async function safeAudit(actorId, action, target) {
    try {
      await ctx.audit(actorId, action, target);
    } catch (error) {
      console.warn(`${PLUGIN_NAME}: audit failed:`, error.message);
    }
  }

  function productPublic(row) {
    const updatedAt = row.updated_at;
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      category: row.category,
      priceCents: Number(row.price_cents),
      currency: row.currency,
      stock: row.stock === null || row.stock === undefined ? null : Number(row.stock),
      hasImage: Number(row.has_image) === 1,
      imageUrl: Number(row.has_image) === 1 ? `/api/store/products/${encodeURIComponent(row.id)}/image?v=${encodeURIComponent(updatedAt)}` : null,
      isPublished: Number(row.is_published) === 1,
      createdAt: row.created_at,
      updatedAt
    };
  }

  const PRODUCT_COLUMNS = `id, title, description, category, price_cents, currency, stock, is_published, created_at, updated_at,
    CASE WHEN image_data IS NULL THEN 0 ELSE 1 END AS has_image`;

  async function getProduct(id) {
    return db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM store_products WHERE id = ? AND store_id = ?`).get(id, STORE_ID);
  }

  function readPrice(value) {
    const price = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0.01 || price > 100_000) {
      throw httpError(400, 'Price must be between 0.01 and 100000 US dollars.');
    }
    return Math.round(price * 100);
  }

  function readStock(value) {
    if (value === null || value === undefined || value === '') return null;
    const stock = typeof value === 'string' ? Number(value) : value;
    if (!Number.isInteger(stock) || stock < 0 || stock > 100_000) {
      throw httpError(400, 'Stock must be a whole number from 0 to 100000, or empty for unlimited.');
    }
    return stock;
  }

  function readCategory(value) {
    const category = String(value || '').toUpperCase();
    if (!CATEGORIES.includes(category)) throw httpError(400, `Category must be one of: ${CATEGORIES.join(', ')}.`);
    return category;
  }

  function readDescription(value) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'string' || value.trim().length > 2000) throw httpError(400, 'Description must be no longer than 2000 characters.');
    return value.trim();
  }

  function readImage(body) {
    if (body.imageData === undefined || body.imageData === null || body.imageData === '') return undefined;
    let data = String(body.imageData);
    let mime = String(body.imageMime || '').toLowerCase();
    const dataUrl = /^data:([a-z/+-]+);base64,(.*)$/s.exec(data);
    if (dataUrl) {
      mime = mime || dataUrl[1];
      data = dataUrl[2];
    }
    if (!IMAGE_MIMES.includes(mime)) throw httpError(400, 'Choose a PNG, JPEG, or WebP image.');
    return { data: ctx.validateImageData(data, mime), mime };
  }

  function makeReference() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(6);
    let reference = 'AM-';
    for (const byte of bytes) reference += alphabet[byte % alphabet.length];
    return reference;
  }

  function allowedActions(order, viewerIsSeller, viewerIsBuyer) {
    const actions = new Set();
    if (viewerIsSeller) {
      for (const [action, rule] of Object.entries(SELLER_ACTIONS)) if (rule.from.includes(order.status)) actions.add(action);
    }
    if (viewerIsBuyer) {
      for (const [action, rule] of Object.entries(BUYER_ACTIONS)) if (rule.from.includes(order.status)) actions.add(action);
    }
    return [...actions];
  }

  function orderPublic(row, items, viewerIsSeller, viewerId) {
    const viewerIsBuyer = row.buyer_id === viewerId;
    return {
      id: row.id,
      reference: row.reference,
      status: row.status,
      statusLabel: STATUS_LABELS[row.status] || row.status,
      buyerId: row.buyer_id,
      buyerName: row.buyer_name,
      buyerPhone: row.buyer_phone,
      note: row.note || '',
      paymentMethod: row.payment_method,
      totalCents: Number(row.total_cents),
      currency: row.currency,
      cancelReason: row.cancel_reason || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: items.map(item => ({
        productId: item.product_id,
        title: item.title,
        unitCents: Number(item.unit_cents),
        quantity: Number(item.quantity),
        lineCents: Number(item.unit_cents) * Number(item.quantity)
      })),
      allowedActions: allowedActions(row, viewerIsSeller, viewerIsBuyer)
    };
  }

  async function loadItems(orderIds) {
    const byOrder = new Map(orderIds.map(id => [id, []]));
    for (let start = 0; start < orderIds.length; start += 100) {
      const chunk = orderIds.slice(start, start + 100);
      if (!chunk.length) continue;
      const rows = await db.prepare(`SELECT order_id, product_id, title, unit_cents, quantity FROM store_order_items
        WHERE order_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY title`).all(...chunk);
      for (const row of rows) byOrder.get(row.order_id)?.push(row);
    }
    return byOrder;
  }

  function requireSignedInMutation(request, response, session) {
    if (!session || !session.user) {
      sendJson(response, 401, { error: 'Sign in to continue.' });
      return false;
    }
    return ctx.authorizeMutation(request, response, session);
  }

  async function requireSeller(response, user) {
    if (!user) {
      sendJson(response, 401, { error: 'Sign in to continue.' });
      return false;
    }
    if (!await isSeller(user)) {
      sendJson(response, 403, { error: `Only ${storeName} sellers can do this.` });
      return false;
    }
    return true;
  }

  // ---------- route handlers ----------

  async function handleInfo(response, user) {
    sendJson(response, 200, {
      store: { id: STORE_ID, name: storeName, paymentInstructions },
      isSeller: await isSeller(user),
      canManageSellers: user?.role === 'SUPER_ADMIN',
      categories: CATEGORIES,
      statusLabels: STATUS_LABELS,
      maxImageBytes
    });
  }

  async function handleListProducts(response, url, user) {
    const manage = url.searchParams.get('manage') === '1';
    if (manage && !await requireSeller(response, user)) return;
    const rows = await db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM store_products WHERE store_id = ?${manage ? '' : ' AND is_published = 1'}
      ORDER BY created_at DESC LIMIT 500`).all(STORE_ID);
    sendJson(response, 200, { products: rows.map(productPublic) });
  }

  async function handleProductImage(response, id, user) {
    const row = await db.prepare('SELECT image_mime, image_data, is_published FROM store_products WHERE id = ? AND store_id = ?').get(id, STORE_ID);
    const visible = row && (Number(row.is_published) === 1 || await isSeller(user));
    if (!visible || !row.image_data || !IMAGE_MIMES.includes(row.image_mime)) {
      sendJson(response, 404, { error: 'Image not found.' });
      return;
    }
    const bytes = Buffer.from(row.image_data, 'base64');
    response.writeHead(200, {
      'Content-Type': row.image_mime,
      'Content-Length': bytes.length,
      'Cache-Control': Number(row.is_published) === 1 ? 'public, max-age=300' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(bytes);
  }

  async function handleCreateProduct(request, response, user) {
    if (!await requireSeller(response, user)) return;
    const body = await readJson(request, PRODUCT_BODY_LIMIT);
    const title = ctx.requireString(body.title, 'Title', 120);
    const description = readDescription(body.description);
    const category = readCategory(body.category || 'OTHER');
    const priceCents = readPrice(body.price);
    const stock = readStock(body.stock);
    const image = readImage(body);
    const isPublished = body.isPublished === false ? 0 : 1;
    const id = crypto.randomUUID();
    const now = nowIso();
    await db.prepare(`INSERT INTO store_products (id, store_id, title, description, category, price_cents, currency, stock,
      image_mime, image_data, is_published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)`)
      .run(id, STORE_ID, title, description, category, priceCents, stock, image?.mime || null, image?.data || null, isPublished, now, now);
    await safeAudit(user.id, 'STORE_PRODUCT_CREATED', id);
    sendJson(response, 201, { product: productPublic(await getProduct(id)) });
  }

  async function handleUpdateProduct(request, response, user, id) {
    if (!await requireSeller(response, user)) return;
    const existing = await getProduct(id);
    if (!existing) {
      sendJson(response, 404, { error: 'Product not found.' });
      return;
    }
    const body = await readJson(request, PRODUCT_BODY_LIMIT);
    const sets = [];
    const values = [];
    if (body.title !== undefined) { sets.push('title = ?'); values.push(ctx.requireString(body.title, 'Title', 120)); }
    if (body.description !== undefined) { sets.push('description = ?'); values.push(readDescription(body.description)); }
    if (body.category !== undefined) { sets.push('category = ?'); values.push(readCategory(body.category)); }
    if (body.price !== undefined) { sets.push('price_cents = ?'); values.push(readPrice(body.price)); }
    if (body.stock !== undefined) { sets.push('stock = ?'); values.push(readStock(body.stock)); }
    if (body.isPublished !== undefined) { sets.push('is_published = ?'); values.push(body.isPublished ? 1 : 0); }
    if (body.removeImage === true) {
      sets.push('image_mime = ?', 'image_data = ?');
      values.push(null, null);
    } else {
      const image = readImage(body);
      if (image) {
        sets.push('image_mime = ?', 'image_data = ?');
        values.push(image.mime, image.data);
      }
    }
    if (!sets.length) {
      sendJson(response, 200, { product: productPublic(existing) });
      return;
    }
    sets.push('updated_at = ?');
    values.push(nowIso());
    await db.prepare(`UPDATE store_products SET ${sets.join(', ')} WHERE id = ? AND store_id = ?`).run(...values, id, STORE_ID);
    await safeAudit(user.id, 'STORE_PRODUCT_UPDATED', id);
    sendJson(response, 200, { product: productPublic(await getProduct(id)) });
  }

  async function handleDeleteProduct(response, user, id) {
    if (!await requireSeller(response, user)) return;
    const result = await db.prepare('DELETE FROM store_products WHERE id = ? AND store_id = ?').run(id, STORE_ID);
    if (result.changes !== 1) {
      sendJson(response, 404, { error: 'Product not found.' });
      return;
    }
    await safeAudit(user.id, 'STORE_PRODUCT_DELETED', id);
    sendJson(response, 200, { ok: true });
  }

  async function handleCreateOrder(request, response, user) {
    const body = await readJson(request, SMALL_BODY_LIMIT);
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
      throw httpError(400, 'Add between 1 and 50 products to your order.');
    }
    const quantities = new Map();
    for (const item of body.items) {
      const productId = typeof item?.productId === 'string' ? item.productId.trim() : '';
      const quantity = typeof item?.quantity === 'string' ? Number(item.quantity) : item?.quantity;
      if (!productId || productId.length > 80) throw httpError(400, 'Each item needs a product.');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw httpError(400, 'Quantity must be a whole number from 1 to 100.');
      const total = (quantities.get(productId) || 0) + quantity;
      if (total > 100) throw httpError(400, 'Quantity must be a whole number from 1 to 100.');
      quantities.set(productId, total);
    }
    const phone = ctx.requireString(body.phone || user.phone || '', 'Phone number', 40);
    if (!/^\+?[0-9 ()-]{6,40}$/.test(phone)) throw httpError(400, 'Enter a valid phone number so the seller can reach you.');
    const note = body.note === undefined || body.note === null ? '' : String(body.note).trim();
    if (note.length > 1000) throw httpError(400, 'Note must be no longer than 1000 characters.');
    const buyerName = String(user.name || user.email || 'Customer').slice(0, 160);

    const orderId = crypto.randomUUID();
    const order = await ctx.runInTransaction(async () => {
      const now = nowIso();
      const lines = [];
      let totalCents = 0;
      // Lock product rows in one fixed order (sorted ids) so two orders for the same products cannot deadlock.
      const sorted = [...quantities].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      for (const [productId, quantity] of sorted) {
        const product = await db.prepare(`SELECT id, title, price_cents, currency, stock, is_published FROM store_products
          WHERE id = ? AND store_id = ?`).get(productId, STORE_ID);
        if (!product || Number(product.is_published) !== 1) {
          throw httpError(409, `${product ? `"${product.title}"` : 'A product in your cart'} is no longer for sale. Remove it and try again.`);
        }
        const updated = await db.prepare(`UPDATE store_products SET stock = stock - ?
          WHERE id = ? AND store_id = ? AND (stock IS NULL OR stock >= ?)`).run(quantity, productId, STORE_ID, quantity);
        if (Number(updated.changes) !== 1) {
          const left = Number(product.stock) || 0;
          throw httpError(409, left > 0
            ? `Only ${left} left of "${product.title}". Lower the quantity and try again.`
            : `"${product.title}" is out of stock.`);
        }
        const unitCents = Number(product.price_cents);
        totalCents += unitCents * quantity;
        const stockReserved = product.stock === null || product.stock === undefined ? 0 : 1;
        lines.push({ productId, title: product.title, unitCents, quantity, stockReserved });
      }
      if (totalCents > MAX_ORDER_TOTAL_CENTS) {
        throw httpError(400, `An order can be at most $${(MAX_ORDER_TOTAL_CENTS / 100).toLocaleString('en-US')}. Split it into smaller orders.`);
      }
      let reference = makeReference();
      for (let attempt = 0; attempt < 5 && await db.prepare('SELECT id FROM store_orders WHERE reference = ?').get(reference); attempt += 1) {
        reference = makeReference();
      }
      await db.prepare(`INSERT INTO store_orders (id, reference, store_id, buyer_id, buyer_name, buyer_phone, note, status,
        payment_method, total_cents, currency, cancel_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'NEW', 'PAY_SELLER', ?, 'USD', NULL, ?, ?)`)
        .run(orderId, reference, STORE_ID, user.id, buyerName, phone, note, totalCents, now, now);
      for (const line of lines) {
        await db.prepare(`INSERT INTO store_order_items (order_id, product_id, title, unit_cents, quantity, stock_reserved)
          VALUES (?, ?, ?, ?, ?, ?)`).run(orderId, line.productId, line.title, line.unitCents, line.quantity, line.stockReserved);
      }
      return { reference, totalCents };
    });

    const sellers = await sellerIds();
    await notify(sellers.map(sellerId => ({
      recipientUserId: sellerId,
      type: 'STORE_ORDER_NEW',
      title: `New ${storeName} order ${order.reference}`,
      body: `${buyerName} ordered ${quantities.size} product${quantities.size === 1 ? '' : 's'} for $${(order.totalCents / 100).toFixed(2)}.`,
      href: `/?storeOrder=${encodeURIComponent(orderId)}`,
      dedupeKey: `store-order-new:${orderId}:${sellerId}`
    })));
    await safeAudit(user.id, 'STORE_ORDER_CREATED', orderId);
    const row = await db.prepare('SELECT * FROM store_orders WHERE id = ?').get(orderId);
    const items = (await loadItems([orderId])).get(orderId) || [];
    sendJson(response, 201, { order: orderPublic(row, items, sellers.includes(user.id), user.id) });
  }

  async function handleListOrders(response, url, user) {
    if (!user) {
      sendJson(response, 401, { error: 'Sign in to see your orders.' });
      return;
    }
    const manage = url.searchParams.get('manage') === '1';
    const seller = await isSeller(user);
    if (manage && !seller) {
      sendJson(response, 403, { error: `Only ${storeName} sellers can do this.` });
      return;
    }
    const status = String(url.searchParams.get('status') || '').toUpperCase();
    const values = manage ? [STORE_ID] : [STORE_ID, user.id];
    let sql = `SELECT * FROM store_orders WHERE store_id = ?${manage ? '' : ' AND buyer_id = ?'}`;
    if (STATUSES.includes(status)) {
      sql += ' AND status = ?';
      values.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT 300';
    const rows = await db.prepare(sql).all(...values);
    const items = await loadItems(rows.map(row => row.id));
    sendJson(response, 200, { orders: rows.map(row => orderPublic(row, items.get(row.id) || [], manage && seller, user.id)) });
  }

  async function handleUpdateOrder(request, response, user, id) {
    const body = await readJson(request, SMALL_BODY_LIMIT);
    const action = String(body.action || '').toUpperCase();
    const order = await db.prepare('SELECT * FROM store_orders WHERE id = ? AND store_id = ?').get(id, STORE_ID);
    const seller = await isSeller(user);
    const buyer = order && order.buyer_id === user.id;
    if (!order || (!seller && !buyer)) {
      sendJson(response, 404, { error: 'Order not found.' });
      return;
    }
    const rule = (seller ? SELLER_ACTIONS[action] : null) || (buyer ? BUYER_ACTIONS[action] : null);
    if (!rule) {
      if (!SELLER_ACTIONS[action]) throw httpError(400, 'Choose a valid action.');
      throw httpError(403, 'Only the seller can do this.');
    }
    const allowedFrom = new Set(rule.from);
    if (buyer && !seller && action === 'CANCEL') {
      for (const status of [...allowedFrom]) if (!BUYER_ACTIONS.CANCEL.from.includes(status)) allowedFrom.delete(status);
    }
    if (!allowedFrom.has(order.status)) {
      const message = buyer && !seller && action === 'CANCEL'
        ? 'You can only cancel an order before the seller confirms it. Message the seller for help.'
        : `This order is "${STATUS_LABELS[order.status]}", so it cannot be changed that way.`;
      throw httpError(409, message);
    }
    let cancelReason = null;
    if (action === 'CANCEL') {
      const reason = body.reason === undefined || body.reason === null ? '' : String(body.reason).trim();
      if (reason.length > 300) throw httpError(400, 'Reason must be no longer than 300 characters.');
      if (seller && !buyer && !reason) throw httpError(400, 'Tell the buyer why the order is cancelled.');
      cancelReason = reason || (buyer && !seller ? 'Cancelled by the buyer.' : 'Cancelled by the seller.');
    }
    const nextStatus = rule.to;
    await ctx.runInTransaction(async () => {
      const result = await db.prepare(`UPDATE store_orders SET status = ?, cancel_reason = ?, updated_at = ?
        WHERE id = ? AND status = ?`).run(nextStatus, cancelReason, nowIso(), id, order.status);
      if (Number(result.changes) !== 1) throw httpError(409, 'This order just changed. Refresh and try again.');
      if (nextStatus === 'CANCELLED') {
        // Only give back stock this order actually took (the product had a stock count when it was ordered).
        const items = await db.prepare(`SELECT product_id, quantity FROM store_order_items
          WHERE order_id = ? AND stock_reserved = 1 ORDER BY product_id`).all(id);
        for (const item of items) {
          await db.prepare('UPDATE store_products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL')
            .run(Number(item.quantity), item.product_id);
        }
      }
    });
    const href = `/?storeOrder=${encodeURIComponent(id)}`;
    if (user.id !== order.buyer_id) {
      await notify([{
        recipientUserId: order.buyer_id,
        type: 'STORE_ORDER_UPDATE',
        title: `${storeName} order ${order.reference}: ${STATUS_LABELS[nextStatus]}`,
        body: nextStatus === 'CANCELLED' && cancelReason ? `${UPDATE_MESSAGES.CANCELLED} Reason: ${cancelReason}` : UPDATE_MESSAGES[nextStatus],
        href,
        dedupeKey: `store-order:${id}:${nextStatus}`
      }]);
    } else if (nextStatus === 'CANCELLED') {
      const sellers = (await sellerIds()).filter(sellerId => sellerId !== user.id);
      await notify(sellers.map(sellerId => ({
        recipientUserId: sellerId,
        type: 'STORE_ORDER_UPDATE',
        title: `Order ${order.reference} was cancelled`,
        body: `${order.buyer_name} cancelled the order.`,
        href,
        dedupeKey: `store-order:${id}:CANCELLED:${sellerId}`
      })));
    }
    await safeAudit(user.id, `STORE_ORDER_${action}`, id);
    const row = await db.prepare('SELECT * FROM store_orders WHERE id = ?').get(id);
    const items = (await loadItems([id])).get(id) || [];
    sendJson(response, 200, { order: orderPublic(row, items, seller, user.id) });
  }

  async function listSellers() {
    const rows = await db.prepare(`SELECT users.id, users.name, users.email, users.phone, store_members.created_at
      FROM store_members JOIN users ON users.id = store_members.user_id
      WHERE store_members.store_id = ? ORDER BY users.name`).all(STORE_ID);
    return rows.map(row => ({ id: row.id, name: row.name, email: row.email, phone: row.phone || '', addedAt: row.created_at }));
  }

  async function handleSellers(request, response, user, method) {
    if (!ctx.requireRole(response, user, ['SUPER_ADMIN'])) return;
    if (method === 'GET') {
      await pruneSellers();
      sendJson(response, 200, { sellers: await listSellers() });
      return;
    }
    const body = await readJson(request, SMALL_BODY_LIMIT);
    if (method === 'DELETE') {
      const userId = typeof body.userId === 'string' ? body.userId : '';
      const result = await db.prepare('DELETE FROM store_members WHERE store_id = ? AND user_id = ?').run(STORE_ID, userId);
      if (Number(result.changes) !== 1) {
        sendJson(response, 404, { error: 'This person is not a seller.' });
        return;
      }
      await safeAudit(user.id, 'STORE_SELLER_REMOVED', userId);
      sendJson(response, 200, { sellers: await listSellers() });
      return;
    }
    // POST
    const email = ctx.normalizeEmail(body.email);
    const createAccount = body.password !== undefined || body.name !== undefined;
    let target = await db.prepare('SELECT id, name, email FROM users WHERE LOWER(email) = ?').get(email);
    if (createAccount) {
      const name = ctx.requireString(body.name, 'Name', 120);
      const password = ctx.validatePassword(body.password);
      if (target) {
        sendJson(response, 409, { error: 'An account already uses this email. Add it without a password instead.' });
        return;
      }
      const phone = typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim().slice(0, 40) : null;
      const { salt, hash } = await ctx.hashPassword(password);
      const id = crypto.randomUUID();
      await db.prepare(`INSERT INTO users (id, email, name, phone, password_salt, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'CLIENT', ?)`).run(id, email, name, phone, salt, hash, nowIso());
      await safeAudit(user.id, 'STORE_SELLER_ACCOUNT_CREATED', id);
      target = { id, name, email };
    } else if (!target) {
      sendJson(response, 404, { error: 'No account uses this email. Add a name and password to create a new seller account.' });
      return;
    }
    const inserted = await db.prepare(`INSERT INTO store_members (store_id, user_id, role, created_at) VALUES (?, ?, 'SELLER', ?)
      ON CONFLICT (store_id, user_id) DO NOTHING`).run(STORE_ID, target.id, nowIso());
    if (Number(inserted.changes) !== 1) {
      sendJson(response, 409, { error: 'This person is already a seller.' });
      return;
    }
    await safeAudit(user.id, 'STORE_SELLER_ADDED', target.id);
    sendJson(response, 201, { seller: { id: target.id, name: target.name, email: target.email }, sellers: await listSellers() });
  }

  // ---------- router ----------

  async function route(request, response, url, session) {
    const pathname = url.pathname;
    const method = request.method || 'GET';
    const user = session?.user || null;
    const isRead = method === 'GET' || method === 'HEAD';
    const mutationAllowed = () => requireSignedInMutation(request, response, session);

    if (pathname === '/api/store/info' && isRead) return handleInfo(response, user);
    if (pathname === '/api/store/products') {
      if (isRead) return handleListProducts(response, url, user);
      if (method === 'POST') return mutationAllowed() && handleCreateProduct(request, response, user);
    }
    const imageMatch = /^\/api\/store\/products\/([A-Za-z0-9-]{1,80})\/image$/.exec(pathname);
    if (imageMatch && isRead) return handleProductImage(response, imageMatch[1], user);
    const productMatch = /^\/api\/store\/products\/([A-Za-z0-9-]{1,80})$/.exec(pathname);
    if (productMatch) {
      if (method === 'PATCH') return mutationAllowed() && handleUpdateProduct(request, response, user, productMatch[1]);
      if (method === 'DELETE') return mutationAllowed() && handleDeleteProduct(response, user, productMatch[1]);
    }
    if (pathname === '/api/store/orders') {
      if (isRead) return handleListOrders(response, url, user);
      if (method === 'POST') return mutationAllowed() && handleCreateOrder(request, response, user);
    }
    const orderMatch = /^\/api\/store\/orders\/([A-Za-z0-9-]{1,80})$/.exec(pathname);
    if (orderMatch && method === 'PATCH') return mutationAllowed() && handleUpdateOrder(request, response, user, orderMatch[1]);
    if (pathname === '/api/store/sellers') {
      if (isRead) return handleSellers(request, response, user, 'GET');
      if (method === 'POST' || method === 'DELETE') return mutationAllowed() && handleSellers(request, response, user, method);
    }
    sendJson(response, 404, { error: 'This shop action is not available.' });
    return undefined;
  }

  async function handle(request, response, url, session) {
    if (url.pathname !== '/api/store' && !url.pathname.startsWith('/api/store/')) return false;
    try {
      await route(request, response, url, session);
    } catch (error) {
      if (response.headersSent) throw error;
      // Postgres deadlock (40P01) or serialization failure (40001): safe for the user to retry.
      if (!error.statusCode && (error.code === '40P01' || error.code === '40001')) {
        sendJson(response, 409, { error: 'The shop was busy. Please try again.' });
        return true;
      }
      if (!error.statusCode) throw error;
      sendJson(response, error.statusCode, { error: error.message });
    }
    return true;
  }

  return {
    name: PLUGIN_NAME,
    schema: SCHEMA,
    async migrate() {
      // Orders placed before stock_reserved existed keep the old behaviour (stock is restored when it is tracked).
      if (!await hasColumn('store_order_items', 'stock_reserved')) {
        await db.exec('ALTER TABLE store_order_items ADD COLUMN stock_reserved INTEGER NOT NULL DEFAULT 1');
      }
      await pruneSellers();
    },
    handle,
    clientScript: 'client.js'
  };
}

module.exports = { register, STORE_ID, CATEGORIES, STATUSES, SELLER_ACTIONS, BUYER_ACTIONS };
