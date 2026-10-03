const CACHE = 'pocket-ledger-shell-36d71b8a93ed';
const ASSETS = ['./', './index.html', './styles.css?v=36d71b8a93ed', './engine.js?v=36d71b8a93ed', './store.js?v=36d71b8a93ed', './app.js?v=36d71b8a93ed', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('pocket-ledger-shell-') && k !== CACHE).map(k => caches.delete(k)))), self.clients.claim()
])));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache transaction requests, credentials, cross-origin responses or exports.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    // Keep HTML and its scripts on the same release until the new worker activates.
    event.respondWith(caches.match('./index.html').then(cached => cached || fetch(event.request))); return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
