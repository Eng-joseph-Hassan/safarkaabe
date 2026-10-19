const CACHE_NAME = 'safar-kaabe-v30';
const REMOTE_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'
];
const APP_FILES = [
  './',
  './the%20style.html',
  './manifest.webmanifest',
  './logo-mark.png',
  './logo.jpeg',
  './safar_kaabe_logo_512x512.png',
  './safar_kaabe_logo_16x16.png',
  './safar_kaabe_logo_32x32.png',
  './safar_kaabe_logo_48x48.png',
  './safar_kaabe_logo_64x64.png',
  './safar_kaabe_logo_128x128.png',
  './safar_kaabe_logo_180x180.png',
  './safar_kaabe_logo_192x192.png',
  './safar_kaabe_logo_256x256.png',
  './safar_kaabe_logo_maskable_512x512.png',
  './image%201.jpg',
  './image%202.jpg',
  './image%203.jpg',
  './image%204.jpg',
  './image%205.jpg',
  './image%206.jpg',
  './image%207.jpg',
  './image%208.jpg',
  './image%209.jpg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_FILES);
      const remoteResults = await Promise.allSettled(REMOTE_ASSETS.map(async url => {
        const response = await fetch(url, { mode: 'no-cors' });
        if (!response.ok && response.type !== 'opaque') throw new Error(`Unable to cache ${url}`);
        await cache.put(url, response);
      }));
      remoteResults.forEach((result, index) => {
        if (result.status === 'rejected') console.warn('Unable to precache optional app asset:', REMOTE_ASSETS[index], result.reason);
      });
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith('/api/')) return;
  if (requestUrl.origin !== self.location.origin) {
    if (['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(requestUrl.hostname)) {
      event.respondWith(
        caches.match(request).then(cached => cached || fetch(request).then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          return response;
        }))
      );
    }
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(error => {
        if (request.mode === 'navigate') return caches.match('./');
        throw error;
      });
    })
  );
});
