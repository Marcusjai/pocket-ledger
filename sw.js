// Bump RELEASE for every shell change; never populate an active release's cache.
const RELEASE = 'fx-live-1';
const CACHE = 'pocket-ledger-shell-' + RELEASE;
const ASSETS = ['./', './index.html', './styles.css?v=fx-live-1', './engine.js?v=fx-live-1', './store.js?v=fx-live-1', './repayment-link.js?v=repayment-prefill-1', './fx-rates.js?v=fx-live-1', './app.js?v=fx-live-1', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];
async function installShell() {
  try {
    const cache = await caches.open(CACHE);
    // An HTTP-cached index from the previous release must not become the new
    // worker's permanent offline shell. This does not touch ledger IndexedDB.
    await cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })));
    const index = await cache.match('./index.html');
    if (!index || !(await index.text()).includes(`<meta name="pocket-ledger-release" content="${RELEASE}">`)) {
      throw new Error('Offline shell release does not match this update');
    }
  } catch (error) {
    // Leave the active release intact if downloading or verification fails.
    await caches.delete(CACHE);
    throw error;
  }
}
function cachedAsset(request) { return caches.open(CACHE).then(cache => cache.match(request)); }
self.addEventListener('install', event => event.waitUntil(installShell()));
self.addEventListener('activate', event => event.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('pocket-ledger-shell-') && k !== CACHE).map(k => caches.delete(k)))), self.clients.claim()
])));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache transaction requests, credentials, cross-origin responses or exports.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    // Keep HTML and its scripts on the same release until the new worker activates.
    event.respondWith(cachedAsset('./index.html').then(cached => cached || fetch(event.request))); return;
  }
  event.respondWith(cachedAsset(event.request).then(cached => cached || fetch(event.request)));
});
