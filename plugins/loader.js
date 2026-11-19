'use strict';

// Generic plugin loader for SAFAR KAABE (and any Node http app with the same ctx helpers).
// See plugins/README.md for the plugin contract.

const fs = require('node:fs');
const path = require('node:path');

const pluginsDir = __dirname;
const loaded = [];
let initPromise = null;

function disabledPlugins() {
  return new Set(String(process.env.SAFAR_PLUGINS_DISABLED || '')
    .split(',').map(name => name.trim()).filter(Boolean));
}

function discoverPlugins() {
  const disabled = disabledPlugins();
  let entries = [];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .filter(entry => !disabled.has(entry.name))
    .filter(entry => fs.existsSync(path.join(pluginsDir, entry.name, 'index.js')))
    .map(entry => ({ folder: entry.name, dir: path.join(pluginsDir, entry.name) }))
    .sort((left, right) => left.folder.localeCompare(right.folder));
}

async function loadAll(ctx) {
  loaded.length = 0;
  const disabled = disabledPlugins();
  for (const { folder, dir } of discoverPlugins()) {
    const mod = require(path.join(dir, 'index.js'));
    if (!mod || typeof mod.register !== 'function') {
      console.warn(`Plugin "${folder}" has no register(ctx) function. Skipped.`);
      continue;
    }
    const plugin = await mod.register(ctx);
    if (!plugin || typeof plugin !== 'object') continue;
    const name = String(plugin.name || folder);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`Plugin "${folder}" has an invalid name "${name}".`);
    if (disabled.has(name)) continue;
    if (plugin.schema) await ctx.db.exec(plugin.schema);
    if (typeof plugin.migrate === 'function') await plugin.migrate();
    let clientScript = null;
    if (plugin.clientScript) {
      clientScript = String(plugin.clientScript);
      // A plain file name or path is read from the plugin folder; anything else is treated as script text.
      if (!/\n/.test(clientScript) && /\.js$/i.test(clientScript)) {
        clientScript = fs.readFileSync(path.resolve(dir, clientScript), 'utf8');
      }
    }
    loaded.push({ name, handle: typeof plugin.handle === 'function' ? plugin.handle : null, clientScript });
  }
  return loaded.map(plugin => plugin.name);
}

// Call once after the core database tables exist. Safe to call more than once: later calls reuse the first result.
function initPlugins(ctx) {
  if (!ctx || !ctx.db) throw new Error('initPlugins(ctx) needs ctx.db.');
  if (!initPromise) {
    initPromise = loadAll(ctx).catch(error => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

async function handlePluginRequest(request, response, url, session) {
  if (initPromise) await initPromise;
  const pathname = url.pathname;
  const method = request.method || 'GET';
  const scriptMatch = /^\/plugins\/([a-z0-9-]+)\/client\.js$/.exec(pathname);
  if (scriptMatch && (method === 'GET' || method === 'HEAD')) {
    const plugin = loaded.find(entry => entry.name === scriptMatch[1] && entry.clientScript);
    if (!plugin) return false;
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(method === 'HEAD' ? undefined : plugin.clientScript);
    return true;
  }
  if (pathname === '/plugins/all.js' && (method === 'GET' || method === 'HEAD')) {
    // One static <script src="/plugins/all.js"> line loads every enabled plugin's browser script.
    const sources = loaded.filter(entry => entry.clientScript).map(entry => `/plugins/${entry.name}/client.js`);
    const body = `(function(){var s=${JSON.stringify(sources)};s.forEach(function(src){var t=document.createElement('script');t.src=src;t.defer=true;document.body.appendChild(t);});})();\n`;
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(method === 'HEAD' ? undefined : body);
    return true;
  }
  for (const plugin of loaded) {
    if (!plugin.handle) continue;
    if (await plugin.handle(request, response, url, session)) return true;
  }
  return false;
}

function pluginScriptTags() {
  return loaded
    .filter(entry => entry.clientScript)
    .map(entry => `<script defer src="/plugins/${entry.name}/client.js"></script>`)
    .join('\n');
}

function loadedPlugins() {
  return loaded.map(entry => entry.name);
}

module.exports = { initPlugins, handlePluginRequest, pluginScriptTags, loadedPlugins, discoverPlugins };
