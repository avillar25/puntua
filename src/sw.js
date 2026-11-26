// Puntúa · caché para abrir la web sin conexión (la app y el catálogo; las imágenes se guardan al verlas)
const C = 'puntua-__VERSION__';
const CORE = ['./', 'index.html', 'meta.js', 'catalog.json', 'version.js', 'firebase-config.js', 'web-backend.js', 'lookup.js', 'manifest.webmanifest', 'icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('puntua-') && k !== C && k !== 'puntua-img').map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.includes('/images/')) {   // imágenes: primero la caché
    e.respondWith(caches.open('puntua-img').then(c => c.match(e.request).then(r => r || fetch(e.request).then(n => { if (n.ok) c.put(e.request, n.clone()); return n; }))));
    return;
  }
  // resto: primero la red (para tener siempre lo último) y la caché si no hay conexión
  e.respondWith(fetch(e.request).then(n => { if (n.ok) caches.open(C).then(c => c.put(e.request, n.clone())); return n; }).catch(() => caches.match(e.request)));
});
