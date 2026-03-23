const CACHE_NAME = 'pulse-v33';
const ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => {
        if (k !== CACHE_NAME) {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        }
      }))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate' || e.request.url.endsWith('.html') || e.request.url.endsWith('/')) {
    e.respondWith(
      fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return resp;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return resp;
    }))
  );
});

// ═══ WEB PUSH — receive push notifications even when browser is closed ═══
self.addEventListener('push', e => {
  let data = { title: 'pulse ♡', body: '', icon: '♡' };
  try {
    if (e.data) data = e.data.json();
  } catch (err) {
    try { data.body = e.data.text(); } catch (e2) {}
  }

  const options = {
    body: data.body || '',
    icon: 'data:image/svg+xml,' + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='#E8D4B4' width='100' height='100' rx='20'/><text x='50' y='68' text-anchor='middle' font-size='52'>" + (data.icon || '♡') + "</text></svg>"
    ),
    badge: 'data:image/svg+xml,' + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='#E8D4B4' width='100' height='100' rx='20'/><text x='50' y='68' text-anchor='middle' font-size='52'>♡</text></svg>"
    ),
    vibrate: [200, 100, 200, 100, 400],
    requireInteraction: true,
    renotify: true,
    tag: 'pulse-push-' + Date.now(),
    silent: false,
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'reply', title: '↩ Reply' }
    ],
    data: { url: './index.html' }
  };

  e.waitUntil(
    self.registration.showNotification(data.title || 'pulse ♡', options)
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', e => {
  const action = e.action;
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes('index.html') || client.url.endsWith('/')) {
          client.focus();
          if (action === 'reply') {
            client.postMessage({ type: 'notif-reply' });
          }
          return;
        }
      }
      const url = (e.notification.data && e.notification.data.url) || './index.html';
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('notificationclose', e => {});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
