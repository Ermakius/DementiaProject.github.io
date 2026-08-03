const CACHE = 'anime-v1';
const CORE = ['./', './index.html', './icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Постеры и скриншоты: cache-first + докеширование
  if (url.hostname === 'shikimori.one' || url.hostname.includes('kodik.biz')) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request);
      fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') { c.put(e.request, r.clone()); trim(c); } }).catch(() => {});
      return hit || fetch(e.request);
    }));
    return;
  }
  // Оболочка: network-first с оффлайн-фолбэком
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(r => { caches.open(CACHE).then(c => c.put('./index.html', r.clone())); return r; })
        .catch(() => caches.match('./index.html'))
    );
  }
});
async function trim(c){
  const keys = await c.keys();
  if (keys.length > 600) for (let i = 0; i < 150; i++) await c.delete(keys[i]);
}