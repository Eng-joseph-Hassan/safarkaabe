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

let html = fs.readFileSync(path.join(root, 'the style.html'), 'utf8');
html = replaceAll(html, "'/api/", "'api/", "'/api/");
html = replaceAll(html, '`/api/', '`api/', '`/api/');
html = replaceAll(html, '"/api/', '"api/', '"/api/');
html = html.replace(/\s*<script defer src="\/plugins\/all\.js"><\/script>/, '');
if (/["'`]\/api\//.test(html)) throw new Error('build-app: an absolute /api/ address is left in the page');
if (/vercel\.app/i.test(html)) throw new Error('build-app: the page still mentions vercel.app');
html = replaceAll(html, "document.getElementById('callAlertsBanner')?.classList.remove('hidden');", '/* Phone alerts are not available on the website version. */', 'call alerts banner');
fs.writeFileSync(path.join(out, 'index.html'), html);

let sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
sw = sw.replace(/const CACHE_NAME = '([^']+)';/, "const CACHE_NAME = '$1-wp';");
sw = replaceAll(sw, "'./the%20style.html'", "'./index.html'", 'the page in the precache list');
sw = replaceAll(sw, "requestUrl.pathname.startsWith('/api/')", "requestUrl.pathname.startsWith(new URL('api/', self.registration.scope).pathname)", 'API bypass');
fs.writeFileSync(path.join(out, 'sw.js'), sw);

const files = ['manifest.webmanifest', 'logo-mark.png', 'adss.mp4'];
for (const name of fs.readdirSync(root)) {
  if (/^safar_kaabe_(icon|logo)_.*\.png$/.test(name) || /^image [1-9]\.jpg$/.test(name)) files.push(name);
}
for (const name of files) fs.copyFileSync(path.join(root, name), path.join(out, name));
console.log(`build-app: wrote index.html, sw.js and ${files.length} files to ${out}`);
