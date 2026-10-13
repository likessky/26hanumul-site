/* 한우물제 오프라인 지원
 * 한 번 열어 둔 휴대폰은 행사장 데이터가 끊기거나 느려도 안내를 볼 수 있어요.
 * 내용을 바꾸면 VERSION 숫자만 올리면 됩니다.
 */
const VERSION = 'hanumul-v4';
const CORE = ['./', 'index.html', 'emblem.png', 'fonts/black-han-sans.css', 'manifest.webmanifest', 'icon-192.png'];
const OPTIONAL = ['data.json', 'map.jpg'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(CORE);
    await Promise.all(OPTIONAL.map((u) => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

async function networkFirst(req, ms, key) {
  const c = await caches.open(VERSION);
  try {
    const res = await Promise.race([fetch(req, { cache: 'no-cache' }), timeout(ms)]);
    if (res && res.ok) { c.put(key || req, res.clone()); return res; }
    throw new Error('bad');
  } catch (e) {
    const hit = await c.match(key || req, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(req); // 캐시도 없으면 끝까지 기다림
  }
}

async function cacheFirst(req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) c.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 서울랜드 지도 등 외부는 그대로
  if (url.pathname.startsWith('/api/')) return;          // 저장 요청은 그대로
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, 3500, 'index.html')); return; }
  if (url.pathname.endsWith('/data.json')) { e.respondWith(networkFirst(req, 4000)); return; }
  e.respondWith(cacheFirst(req));
});
