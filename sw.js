/* Service Worker: оболочка + кеш постеров */
const VERSION = 'anime-v4';
const CORE = ['./', './index.html', './manifest.json', './icon.png', './icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.all(CORE.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  /* Постеры: cache-first + докеширование.
     Только картинки — данные API и плеер не кешируем. */
  if (req.destination === 'image'){
    e.respondWith(cacheFirst(req));
    return;
  }

  if (req.mode === 'navigate'){
    e.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req){
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  try{
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')){
      cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  }catch(e){
    return new Response('', { status: 504 });
  }
}

async function networkFirst(req){
  const cache = await caches.open(VERSION);
  const shell = new URL('./index.html', self.registration.scope).href;
  try{
    const res = await fetch(req);
    if (res && res.ok) cache.put(shell, res.clone());
    return res;
  }catch(e){
    return (await cache.match(req))
      || (await cache.match(shell))
      || new Response('<h1>Нет сети</h1>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function trim(cache){
  const keys = await cache.keys();
  if (keys.length > 400){
    for (let i = 0; i < keys.length - 300; i++) await cache.delete(keys[i]);
  }
}