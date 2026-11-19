# ANFAC MEDIA Shop (`anfac-media-store`)

A small product shop that plugs into SAFAR KAABE. The company **ANFAC MEDIA** sells its own products and
services (design, video, photo, printing, branding, websites). Travelers and agencies browse the shop,
order, and follow their orders. ANFAC MEDIA manages products and orders from its own seller account.

- Products with photo, price, category, description, stock (or no limit), and show/hide.
- Cart, order with phone number and note, pay the seller directly (EVC Plus, Zaad or cash).
- Stock is taken in one database transaction, so two buyers can never buy the last item twice.
  Prices and totals are always worked out on the server.
- Order steps: Order sent -> Confirmed -> Being made -> Ready -> Delivered (or Cancelled).
  Buyers can cancel while the order is still "Order sent". Cancelling puts the stock back.
- Notifications: sellers get `STORE_ORDER_NEW` for each new order; buyers get `STORE_ORDER_UPDATE` on each change.
- The Super Admin adds or removes sellers (an existing account by email, or a new account with name and password).
- Works on SQLite and Postgres (Neon). Uses its own `store_*` tables and never changes core tables.

## Files

| File | What it is |
| --- | --- |
| `plugin.json` | Name, version and entry files |
| `index.js` | Server side: tables and API routes (`register(ctx)`) |
| `client.js` | Browser side: Shop menu entry and the shop window (`#storePluginModal`) |
| `test/store.test.js` | Tests (run `node --test "plugins/**/*.test.js"`) |

## Install in SAFAR KAABE

The `plugins/` folder (with `loader.js`) sits next to `server.js`. Add these lines to `server.js`:

1. Load the plugin loader near the other `require` lines:

   ```js
   const plugins = require('./plugins/loader');
   ```

2. Start the plugins right after the core tables are ready. Change

   ```js
   const dbReady = initializeDatabase();
   ```

   to

   ```js
   const dbReady = initializeDatabase().then(() => plugins.initPlugins({
     db, runInTransaction, nowIso, sendJson, readJson, requireRole, authorizeMutation,
     requireString, normalizeEmail, validatePassword, hashPassword, createNotifications, audit,
     validateImageData, maxImageBytes: maxCatalogImageBytes
   }));
   ```

3. In `handleApi`, right after `const user = session?.user || null;`, add:

   ```js
   if (await plugins.handlePluginRequest(request, response, url, session)) return;
   ```

   This one line serves the shop API (`/api/store/...`) and the browser script (`/plugins/anfac-media-store/client.js`).

4. Load the browser script in `the style.html`, just before `</body>`:

   ```html
   <script defer src="/plugins/anfac-media-store/client.js"></script>
   ```

   (Apps that build their HTML in code can insert `plugins.pluginScriptTags()` before `</body>` instead.
   `<script defer src="/plugins/all.js"></script>` also works and loads every enabled plugin.)

5. On Vercel, add `plugins/**` to `includeFiles` for `server.js` and `api/[...path].js` in `vercel.json`,
   because the loader finds plugins by reading the folder.

6. Sign in as Super Admin, open **ANFAC MEDIA Shop** -> **Sellers**, and add the ANFAC MEDIA account
   (an existing email, or a new name, email and password). That account then sees **Manage products** and **Orders**.

To switch the shop off without removing files, set `SAFAR_PLUGINS_DISABLED=anfac-media-store`.

## Settings (environment variables)

| Name | Default |
| --- | --- |
| `STORE_NAME` | `ANFAC MEDIA` |
| `STORE_PAYMENT_INSTRUCTIONS` | `Pay ANFAC MEDIA by EVC Plus, Zaad or cash. The seller will contact you to confirm.` |
| `SAFAR_PLUGINS_DISABLED` | empty (comma list of plugin names to turn off) |

## API

All answers are JSON. Changes need a signed-in user and pass the host's CSRF check (`authorizeMutation`).

| Method and path | Who | What |
| --- | --- | --- |
| `GET /api/store/info` | anyone | `{ store: { id, name, paymentInstructions }, isSeller, canManageSellers, categories, statusLabels, maxImageBytes }` |
| `GET /api/store/products` | anyone | Products in the shop. `?manage=1` (sellers) also returns hidden ones |
| `GET /api/store/products/:id/image` | anyone / seller | The photo. Hidden products only for sellers |
| `POST /api/store/products` | seller | `{ title, description, category, price, stock, isPublished, imageData, imageMime }` |
| `PATCH /api/store/products/:id` | seller | Any of the fields above, or `removeImage: true` |
| `DELETE /api/store/products/:id` | seller | Delete (past orders keep their copy of the name and price) |
| `POST /api/store/orders` | signed in | `{ items: [{ productId, quantity }], phone, note }`. 409 when out of stock |
| `GET /api/store/orders` | signed in | Your orders. `?manage=1` (sellers) returns all shop orders. `?status=NEW` filters |
| `PATCH /api/store/orders/:id` | seller / buyer | `{ action }`: seller `CONFIRM`, `START`, `READY`, `DELIVER`, `CANCEL` (with `reason`); buyer `CANCEL` while NEW |
| `GET /api/store/sellers` | Super Admin | List sellers |
| `POST /api/store/sellers` | Super Admin | `{ email }` adds an existing account; `{ name, email, password }` creates a new one |
| `DELETE /api/store/sellers` | Super Admin | `{ userId }` removes the seller role (the account stays) |

Categories: `DESIGN, VIDEO, PHOTO, PRINTING, BRANDING, WEB, OTHER`. Price is in US dollars (0.01 to 100000).
Stock is a whole number from 0 to 100000, or `null` for no limit.

Deep link: `/?storeOrder=<orderId>` opens the order. `/?shop=1` opens the shop.
From other page code you can call `window.openStorePlugin('products' | 'cart' | 'orders')`.

## Tables

`store_members`, `store_products`, `store_orders`, `store_order_items`. They are created with
`CREATE TABLE IF NOT EXISTS` on start, so installing is safe to repeat.

## Use it in another app

The plugin only talks to the host through `ctx` (see the top of `index.js` and `../README.md`). Any Node
`http` app can use it if it:

1. has a `users` table with `id, email, name, phone, password_salt, password_hash, role, created_at`,
2. passes the `ctx` helpers to `initPlugins(ctx)` and calls `handlePluginRequest(request, response, url, session)`,
3. loads `/plugins/anfac-media-store/client.js` in its page. The script uses the page's `apiRequest`, `escapeHtml`,
   `showToast`, `formatMoney`, `openAuthGate` and `currentUser` when they exist, and falls back to simple versions when they don't.

`test/store.test.js` is a working example of a minimal host.
