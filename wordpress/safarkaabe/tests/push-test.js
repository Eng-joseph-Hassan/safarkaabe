// End-to-end check of the plugin's Web Push: a stand-in push service receives the alerts, decrypts them
// like a browser would (http_ece) and checks the VAPID signature. Args: <pluginDir> <repoDir>
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [pluginDir, repoDir] = process.argv.slice(2);
const ece = require(path.join(repoDir, 'node_modules', 'http_ece'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64u = buf => Buffer.from(buf).toString('base64url');
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures++; };

(async () => {
  // Browser side: its own key pair and secret, as PushManager.subscribe() would create.
  const browserKey = crypto.createECDH('prime256v1'); browserKey.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const received = [];
  const pushPort = 8991;
  const pushServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const authz = req.headers.authorization || '';
        const m = authz.match(/^vapid t=([^,]+), k=(.+)$/);
        const [h, c, sig] = m[1].split('.');
        const pub = Buffer.from(m[2], 'base64url');
        const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
        const signatureOk = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
        const claims = JSON.parse(Buffer.from(c, 'base64url'));
        const plain = ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: browserKey, authSecret });
        received.push({ message: JSON.parse(plain.toString()), signatureOk, claims, headers: req.headers });
        res.writeHead(201); res.end();
      } catch (error) {
        console.log('push service could not read an alert:', error.message);
        received.push({ error: error.message });
        res.writeHead(400); res.end();
      }
    });
  }).listen(pushPort, '127.0.0.1');

  const port = 8979, base = `http://127.0.0.1:${port}/safarkaabe/`;
  const db = path.join(os.tmpdir(), `skw-push-${Date.now()}.sqlite`);
  const server = spawn('C:/xampp/php/php.exe', ['-S', `127.0.0.1:${port}`, path.join(pluginDir, 'tests', 'router.php')], {
    cwd: pluginDir, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, SKW_TEST_DB: db, SKW_SETUP_TOKEN: 'tok', OPENSSL_CONF: 'C:/xampp/php/extras/ssl/openssl.cnf', SKW_TEST_CONFIG: JSON.stringify({ push_test_host: '127.0.0.1' }) }
  });
  let serverLog = ''; server.stderr.on('data', d => { serverLog += d; });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + 'api/setup/status')).ok) break; } catch {} await sleep(100); }
  const jar = r => (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');
  const csrf = ck => decodeURIComponent((ck.split('; ').find(p => p.startsWith('sk_csrf=')) || '=').split('=')[1]);
  const call = async (p, m, body, cookie) => fetch(base + p, { method: m, headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf(cookie) } : {}) }, body: body && JSON.stringify(body) });

  const admin = jar(await call('api/setup/admin', 'POST', { name: 'Admin', email: 'admin@x.test', password: 'long-enough-admin-password', setupToken: 'tok' }));
  const { agency } = await (await call('api/agencies', 'POST', { name: 'Bay Travel', tier: 'PROFESSIONAL', markupPct: 5, ownerName: 'Agency Owner', ownerEmail: 'owner@x.test', ownerPassword: 'long-enough-agency-password' }, admin)).json();
  await call(`api/agencies/${agency.id}/status`, 'PATCH', { action: 'APPROVE' }, admin);
  const staff = jar(await call('api/auth/login', 'POST', { email: 'owner@x.test', password: 'long-enough-agency-password' }));
  const traveler = jar(await call('api/auth/register', 'POST', { name: 'Amina Hassan', email: 'amina@x.test', phone: '+252610000001', password: 'long-enough-traveler-password' }));

  const keyRes = await (await call('api/push/public-key', 'GET')).json();
  check(keyRes.configured === true && Buffer.from(keyRes.publicKey, 'base64url').length === 65, 'the website gives its push key');
  const keyAgain = await (await call('api/push/public-key', 'GET')).json();
  check(keyAgain.publicKey === keyRes.publicKey, 'the push key stays the same');

  const bad = await call('api/push/subscriptions', 'POST', { subscription: { endpoint: 'https://evil.example/x', keys: { p256dh: b64u(browserKey.getPublicKey()), auth: b64u(authSecret) } } }, traveler);
  check(bad.status === 400, 'addresses that are not push services are refused');
  const sub = await call('api/push/subscriptions', 'POST', { subscription: { endpoint: `http://127.0.0.1:${pushPort}/push/amina`, keys: { p256dh: b64u(browserKey.getPublicKey()), auth: b64u(authSecret) } } }, traveler);
  check(sub.status === 201, 'the traveler turns on alerts');

  // The agency starts a conversation and calls the traveler.
  const conv = await (await call('api/conversations', 'POST', { agencyId: agency.id, subject: 'My trip', message: 'Hello' }, traveler)).json();
  const conversationId = conv.conversation?.id || conv.conversationId || conv.id;
  await call(`api/conversations/${conv.conversation?.id || conv.conversationId || conv.id}/messages`, 'POST', { message: 'Hello Amina, your seat is ready.' }, staff);
  await sleep(800);
  const msgAlert = received.find(r => r.message && r.message.type && !r.message.type.startsWith('CALL_'));
  check(Boolean(msgAlert), `a message alert arrives (${msgAlert ? msgAlert.message.title : 'none'})`);
  check(Boolean(msgAlert && msgAlert.signatureOk), 'the alert is signed correctly');
  check(Boolean(msgAlert && /^http:\/\/127\.0\.0\.1:8979\/safarkaabe\//.test(msgAlert.message.url)), 'the alert opens the app address');

  received.length = 0;
  const callRes = await (await call(`api/conversations/${conversationId}/calls`, 'POST', { callType: 'AUDIO', deviceId: 'dev1' }, staff)).json();
  const callId = callRes.call && callRes.call.id;
  check(Boolean(callId), 'the agency starts a call');
  await sleep(800);
  const ring = received.find(r => r.message && r.message.type === 'CALL_INCOMING');
  check(Boolean(ring), `the traveler's phone rings (${ring ? ring.message.title : 'no alert'})`);
  check(Boolean(ring && ring.headers.urgency === 'high' && ring.headers.ttl === '60'), 'the ring is urgent and short-lived');
  check(Boolean(ring && ring.message.data && ring.message.data.declineToken && ring.message.tag === `call-${callId}`), 'the ring carries Answer/Decline details');

  await sleep(6500);
  received.length = 0;
  await call('api/calls/active', 'GET', null, staff); // The caller's app checks the call...
  await sleep(800);
  check(received.some(r => r.message && r.message.type === 'CALL_INCOMING'), 'the phone rings again while the call waits');
  received.length = 0;
  await call('api/calls/active', 'GET', null, staff);
  await sleep(600);
  check(!received.some(r => r.message && r.message.type === 'CALL_INCOMING'), 'it does not ring twice within a few seconds');

  const wrong = await fetch(`${base}api/calls/${callId}/push-decline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) });
  check(wrong.status === 404, 'a wrong decline code is refused');
  const decline = await (await fetch(`${base}api/calls/${callId}/push-decline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ring.message.data.declineToken }) })).json();
  check(decline.declined === true, 'Decline on the alert ends the call');
  await sleep(800);
  const ended = received.find(r => r.message && r.message.type === 'CALL_ENDED');
  check(Boolean(ended && ended.message.data.reason === 'DECLINED'), 'the ringing alert is replaced when declined');
  const status = await (await call('api/calls/active', 'GET', null, staff)).json();
  check(Array.isArray(status.calls) && status.calls.length === 0, 'the caller sees the call has ended');

  const off = await call('api/push/subscriptions', 'DELETE', { endpoint: `http://127.0.0.1:${pushPort}/push/amina` }, traveler);
  check(off.status === 200, 'the traveler can turn alerts off');
  received.length = 0;
  await call(`api/conversations/${conversationId}/messages`, 'POST', { message: 'Are you there?' }, staff);
  await sleep(800);
  check(received.length === 0, 'no alerts after turning them off');

  const phpErrors = serverLog.split('\n').filter(l => /PHP (Fatal|Warning|Parse|Notice|Deprecated)|SAFAR KAABE (push|API)/.test(l));
  check(phpErrors.length === 0, 'no PHP errors' + (phpErrors.length ? ':\n' + phpErrors.slice(0, 5).join('\n') : ''));
  server.kill(); pushServer.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
