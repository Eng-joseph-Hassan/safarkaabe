# SAFAR KAABE plugins

Each folder in `plugins/` that has an `index.js` is a plugin. `loader.js` finds them, creates their tables,
routes requests to them, and serves their browser scripts. Turn a plugin off with
`SAFAR_PLUGINS_DISABLED=name1,name2`.

Installed plugins:

- [`anfac-media-store`](anfac-media-store/README.md) - ANFAC MEDIA Shop.

## Hooking the loader into the app

```js
const plugins = require('./plugins/loader');

await plugins.initPlugins(ctx);                       // once, after the core tables exist
if (await plugins.handlePluginRequest(request, response, url, session)) return;  // at the top of request handling
html.replace('</body>', plugins.pluginScriptTags() + '</body>');                // or a static <script> tag
```

`handlePluginRequest` also serves `GET /plugins/<name>/client.js` and `GET /plugins/all.js`
(a tiny script that loads every enabled plugin's browser script).

## Writing a plugin

Create `plugins/<name>/index.js`:

```js
module.exports = {
  async register(ctx) {
    return {
      name: 'my-plugin',              // lower case letters, numbers and dashes
      schema: `CREATE TABLE IF NOT EXISTS my_plugin_items (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
      async migrate() {},             // optional, runs after schema
      async handle(request, response, url, session) {
        if (!url.pathname.startsWith('/api/my-plugin/')) return false;  // not ours
        ctx.sendJson(response, 200, { ok: true });
        return true;                  // we answered
      },
      clientScript: 'client.js'       // optional: a file in the plugin folder, or script text
    };
  }
};
```

Add a `plugin.json` (`name`, `displayName`, `version`, `description`, `entry`, `client`) and a `README.md`.

### ctx (what the host gives every plugin)

| Name | What it does |
| --- | --- |
| `db` | `db.exec(sql)`, `db.prepare(sql).get/all/run(...values)`, `db.isPostgres` |
| `runInTransaction(fn)` | Runs `fn` in one transaction. Throwing rolls it back |
| `nowIso()` | Current time as an ISO string |
| `sendJson(response, status, payload)` | Sends JSON |
| `readJson(request, maxBytes)` | Reads the JSON body (errors carry `statusCode` 400 or 413) |
| `requireRole(response, user, roles)` | `false` (and sends 401/403) when the user may not continue |
| `authorizeMutation(request, response, session)` | CSRF and origin check for changes; sends 403 when `false` |
| `requireString(value, field, max)` | Trimmed text or a 400 error |
| `normalizeEmail(value)` | Lower-case email or a 400 error |
| `validatePassword(value)` | The password or a 400 error (at least 12 characters) |
| `hashPassword(password)` | `Promise<{ salt, hash }>` for the `users` table |
| `createNotifications(items)` | Items: `{ recipientUserId, type, title, body, href, dedupeKey }` |
| `audit(actorId, action, target)` | Writes the audit log |
| `validateImageData(base64, mime)` | Checks a PNG/JPEG/WebP image or throws a 400 error |
| `maxImageBytes` | Largest image `validateImageData` accepts |

`session` is `null` or `{ user, session }`. `user` has `id`, `role` (`SUPER_ADMIN`, `AGENCY` or `CLIENT`),
`name`, `email`, `phone`, `agency_id`.

### Rules

- SQL must run on SQLite and Postgres: use `?` placeholders, `TEXT` ids and ISO `TEXT` dates, `INTEGER` 0/1 for true/false,
  no `;` inside strings in `schema`, and avoid `SUM()` results (Postgres returns them as text).
- Prefix your tables with your plugin name. Never change core tables.
- Throw errors with a `statusCode` and a plain-English `message`; send JSON for every answer.
- In browser scripts, escape all server data with `escapeHtml` before using `innerHTML`, and add page parts defensively
  (the page may not be ready yet).
- Add tests under `<plugin>/test/` and run `node --test "plugins/**/*.test.js"`.
