const CACHE_NAME = 'safar-kaabe-v91';
const REMOTE_ASSETS = [  'https://cdn.tailwindcss.com',  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'];
const CORE_FILES = ['./', './the%20style.html', './manifest.webmanifest'];
const APP_FILES = [  './logo-mark.png',  './safar_kaabe_icon_16x16.png',  './safar_kaabe_icon_32x32.png',  './safar_kaabe_icon_48x48.png',  './safar_kaabe_icon_64x64.png',  './safar_kaabe_icon_180x180.png',  './safar_kaabe_icon_192x192.png',  './safar_kaabe_icon_512x512.png',  './safar_kaabe_icon_maskable_512x512.png',  './safar_kaabe_logo_512x512.png',  './safar_kaabe_logo_16x16.png',  './safar_kaabe_logo_32x32.png',  './safar_kaabe_logo_48x48.png',  './safar_kaabe_logo_64x64.png',  './safar_kaabe_logo_128x128.png',  './safar_kaabe_logo_180x180.png',  './safar_kaabe_logo_192x192.png',  './safar_kaabe_logo_256x256.png',  './safar_kaabe_logo_maskable_512x512.png',  './image%201.jpg',  './image%202.jpg',  './image%203.jpg',  './image%204.jpg',  './image%205.jpg',  './image%206.jpg',  './image%207.jpg',  './image%208.jpg',  './image%209.jpg'];
self.addEventListener('install', event => {  event.waitUntil(    (async () => {      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(CORE_FILES);
      const appResults = await Promise.allSettled(APP_FILES.map(path => cache.add(path)));
      appResults.forEach((result, index) => {        if (result.status === 'rejected') console.warn('Unable to precache optional app asset:', APP_FILES[index], result.reason);
      });
      const remoteResults = await Promise.allSettled(REMOTE_ASSETS.map(async url => {        const response = await fetch(url, { mode: 'no-cors' });
        if (!response.ok && response.type !== 'opaque') throw new Error(`Unable to cache ${url}`);
        await cache.put(url, response);
      }));
      remoteResults.forEach((result, index) => {        if (result.status === 'rejected') console.warn('Unable to precache optional app asset:', REMOTE_ASSETS[index], result.reason);
      });
      await self.skipWaiting();
    })()  );
});
self.addEventListener('activate', event => {  event.waitUntil(    caches.keys()      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))      .then(() => self.clients.claim())  );
});
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'SAFAR KAABE', {
    body: data.body || 'You have a new travel update.',
    icon: './safar_kaabe_icon_192x192.png',
    badge: './safar_kaabe_icon_48x48.png',
    data: { url: data.url || './', notificationId: data.notificationId || null }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => client.url.startsWith(self.location.origin));
    return existing ? existing.focus().then(() => existing.navigate(target)) : self.clients.openWindow(target);
  }));
});
self.addEventListener('fetch', event => {  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const requestUrl = new URL(request.url);
  if (requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(error => caches.match(request).then(cached => cached || caches.match('./').then(fallback => {
      if (fallback) return fallback;
      throw error;
    }))));
    return;
  }
  if (requestUrl.origin !== self.location.origin) {    if (['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(requestUrl.hostname)) {      event.respondWith(        caches.match(request).then(cached => cached || fetch(request).then(response => {          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          return response;
        }))      );
    }    return;
  }  event.respondWith(    caches.match(request).then(cached => {      if (cached) return cached;
      return fetch(request).then(response => {        if (response.ok) {          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }        return response;
      }).catch(error => {        if (request.mode === 'navigate') return caches.match('./');
        throw error;
      });
    })  );
});
