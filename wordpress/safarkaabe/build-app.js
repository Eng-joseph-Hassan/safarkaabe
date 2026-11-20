// Copies the SAFAR KAABE app page and its files into wordpress/safarkaabe/app/ so WordPress can serve it
// at /safarkaabe/. All server addresses become relative ("api/...") so they stay under /safarkaabe/.
// Run from the repository root:  node wordpress/safarkaabe/build-app.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, 'app');
fs.mkdirSync(out, { recursive: true });

function replaceAll(text, from, to, label, expectAtLeast = 1) {
  const count = text.split(from).length - 1;
  if (count < expectAtLeast) throw new Error(`build-app: expected "${label}" in the page`);
  return text.split(from).join(to);
}

let html = fs.readFileSync(path.join(root, 'the style.html'), 'utf8').replace(/\r\n/g, '\n');
html = replaceAll(html, "'/api/", "'api/", "'/api/");
html = replaceAll(html, '`/api/', '`api/', '`/api/');
html = replaceAll(html, '"/api/', '"api/', '"/api/');
html = html.replace(/\s*<script defer src="\/plugins\/all\.js"><\/script>/, '');
if (/["'`]\/api\//.test(html)) throw new Error('build-app: an absolute /api/ address is left in the page');
if (/vercel\.app/i.test(html)) throw new Error('build-app: the page still mentions vercel.app');
html = replaceAll(html, 'placeholder="Enter the token configured in Vercel"', 'placeholder="Find it in WordPress admin → SAFAR KAABE"', 'setup token hint');

// Speed: build the styles once here instead of compiling them in every visitor's browser,
// and load fonts and icons without holding up the first paint.
const FONTS = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap';
const ICONS = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css';
html = replaceAll(html, '<script src="https://cdn.tailwindcss.com"></script>', '', 'Tailwind script');
html = replaceAll(html, `@import url('${FONTS}');`, '', 'font import');
const lazyCss = url => `<link rel="stylesheet" href="${url}" media="print" onload="this.media='all'" /><noscript><link rel="stylesheet" href="${url}" /></noscript>`;
html = replaceAll(html, `<link rel="stylesheet" href="${ICONS}" />`,
  '<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />'
  + '<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin />' + lazyCss(FONTS) + lazyCss(ICONS), 'icon stylesheet');
// Images, logo and video: the server fills in %%SKW_ASSETS%% with the plugin folder address, so they load
// straight from the hosting without starting WordPress for each file.
const assetRef = /(["'])(logo-mark\.png|image [1-9]\.jpg|adss\.mp4|safar_kaabe_(?:icon|logo)_[a-z0-9_]+\.png)/g;
if ((html.match(assetRef) || []).length < 10) throw new Error('build-app: expected image addresses in the page');
html = html.replace(assetRef, '$1%%SKW_ASSETS%%$2');

// Start-up data: the server puts the first answers into the page (<!--SKW_BOOT-->), and apiRequest uses each one
// once during the first 20 seconds instead of asking the server again.
html = replaceAll(html, '</head>', '<!--SKW_BOOT-->\n</head>', 'end of head');
html = replaceAll(html, '    async function apiRequest(path, options = {}) {\n',
  `    function takeStartupAnswer(path, options) {
      const boot = window.__SKW_BOOT__;
      if (!boot || (options.method && options.method !== 'GET') || performance.now() > 20000) return null;
      const key = String(path).replace(/^\\.?\\//, '');
      if (!Object.prototype.hasOwnProperty.call(boot, key)) return null;
      const answer = boot[key];
      // These two are asked twice during start-up; the others only once.
      if (key !== 'api/catalog/realtime' && key !== 'api/auth/session') delete boot[key];
      return answer;
    }

    async function apiRequest(path, options = {}) {
      const startupAnswer = takeStartupAnswer(path, options);
      if (startupAnswer) return startupAnswer;
`, 'apiRequest');

// Fewer background checks: on shared hosting each check starts WordPress, and many of them slow down the whole site.
html = replaceAll(html, `      callPollTimer = window.setInterval(() => {
        if (!currentUser || callPollingInProgress) return;
        syncActiveCalls();
      }, 1800);`, `      let lastCallCheck = Date.now();
      callPollTimer = window.setInterval(() => {
        if (!currentUser || callPollingInProgress) return;
        // Fast during a call; every 5 seconds while the app is open; every 15 seconds in the background.
        const wait = activeCall ? 0 : document.hidden ? 15000 : 5000;
        if (Date.now() - lastCallCheck < wait) return;
        lastCallCheck = Date.now();
        syncActiveCalls();
      }, 1800);`, 'call checks');
html = replaceAll(html, `        if (!document.hidden) loadNotifications(true);
      }, 7000);`, `        if (!document.hidden) loadNotifications(true);
      }, 20000);`, 'notification checks');
html = replaceAll(html, `          conversationInboxRefreshInProgress = false;
        }
      }, 15000);`, `          conversationInboxRefreshInProgress = false;
        }
      }, 30000);`, 'inbox checks');
html = replaceAll(html, `        refreshCustomerOffers().catch(error => console.warn('Unable to refresh travel offers.', error));
      }, 15_000);`, `        if (!document.hidden) refreshCustomerOffers().catch(error => console.warn('Unable to refresh travel offers.', error));
      }, 60_000);`, 'trip checks');
html = replaceAll(html, `        sendPresenceUpdate().catch(error => console.warn('Presence heartbeat failed.', error));
      }, 25_000);`, `        sendPresenceUpdate().catch(error => console.warn('Presence heartbeat failed.', error));
      }, 50_000);`, 'online checks');
fs.writeFileSync(path.join(out, 'index.html'), html); // Tailwind reads the classes from this file.

const os = require('os');
const { execFileSync } = require('child_process');
const twIn = path.join(os.tmpdir(), 'skw-tailwind-input.css');
fs.writeFileSync(twIn, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'tailwindcss@3.4.17', '-i', twIn, '-o', 'app.css', '--content', 'index.html', '--minify'], { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' }); // Relative paths: the folder name has spaces.
const css = fs.readFileSync(path.join(out, 'app.css'));
if (css.length < 5000) throw new Error('build-app: app.css looks empty');
const cssVersion = require('crypto').createHash('sha256').update(css).digest('hex').slice(0, 10);
// After the page's own <style>, like the Tailwind script did, so utility classes still win.
html = replaceAll(html, '</head>', `<link rel="stylesheet" href="%%SKW_ASSETS%%app.css?v=${cssVersion}" />\n</head>`, 'end of head');
fs.writeFileSync(path.join(out, 'index.html'), html);

let sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8').replace(/\r\n/g, '\n');
sw = sw.replace(/const CACHE_NAME = '([^']+)';/, "const CACHE_NAME = '$1-wp2';");
// Opened pages hold the person's own start-up data, so they are not kept; offline, the saved plain page is used.
sw = replaceAll(sw, '      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));', '', 'page caching');
sw = replaceAll(sw, "caches.match(request).then(cached => cached || caches.match('./')", "caches.match('./index.html').then(cached => cached || caches.match('./')", 'offline page');
sw = replaceAll(sw, "'./the%20style.html'", "'./index.html'", 'the page in the precache list');
sw = replaceAll(sw, "requestUrl.pathname.startsWith('/api/')", "requestUrl.pathname.startsWith(new URL('api/', self.registration.scope).pathname)", 'API bypass');
sw = replaceAll(sw, "'https://cdn.tailwindcss.com',", '', 'Tailwind in the offline list');
// Decline from the call alert goes to this site's /safarkaabe/api/, not the site root.
sw = replaceAll(sw, 'fetch(`/api/calls/', 'fetch(self.registration.scope + `api/calls/', 'call decline address');
fs.writeFileSync(path.join(out, 'sw.js'), sw);

const files = ['manifest.webmanifest', 'logo-mark.png', 'adss.mp4'];
for (const name of fs.readdirSync(root)) {
  if (/^safar_kaabe_(icon|logo)_.*\.png$/.test(name) || /^image [1-9]\.jpg$/.test(name)) files.push(name);
}
for (const name of files) fs.copyFileSync(path.join(root, name), path.join(out, name));
console.log(`build-app: wrote index.html, sw.js and ${files.length} files to ${out}`);
