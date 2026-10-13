/* 한우물제 오프라인 지원
 * 한 번 열어 둔 휴대폰은 행사장 데이터가 끊기거나 느려도 안내를 볼 수 있어요.
 * 화면 코드를 바꾸면 VERSION 숫자만 올리면 됩니다.
 * 지도(map.jpg, 약 1MB)는 따로 보관해서 VERSION을 올려도 다시 받지 않아요.
 * 지도 이미지를 바꿀 때만 MAP_CACHE 숫자를 올려 주세요.
 */
const VERSION = 'hanumul-v7';
const MAP_CACHE = 'hanumul-map-1';
const CORE = ['./', 'index.html', 'emblem.png', 'manifest.webmanifest', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(CORE);
    await c.add('data.json').catch(() => {});
    const m = await caches.open(MAP_CACHE);
    // 브라우저에 남은 예전 응답(404 등)을 쓰지 않고 서버에서 새로 받음
    if (!(await m.match('map.jpg', { ignoreSearch: true }))) await m.add(new Request('map.jpg', { cache: 'reload' })).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== MAP_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

async function networkFirst(req, ms, key, mark) {
  const c = await caches.open(VERSION);
  try {
    const res = await Promise.race([fetch(req, { cache: 'no-cache' }), timeout(ms)]);
    if (res && res.ok) { c.put(key || req, res.clone()); return res; }
    throw new Error('bad');
  } catch (e) {
    const hit = await c.match(key || req, { ignoreSearch: true });
    // 화면이 "최신 안내"라고 잘못 표시하지 않도록 저장본이라는 표시를 붙임
    if (hit && mark) { const h = new Headers(hit.headers); h.set('X-From-Cache', '1'); return new Response(hit.body, { status: 200, headers: h }); }
    if (hit) return hit;
    return fetch(req); // 캐시도 없으면 끝까지 기다림
  }
}

async function cacheFirst(req, name) {
  const c = await caches.open(name || VERSION);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req, { cache: 'no-cache' }); // 브라우저에 남은 오래된 응답 대신 서버에 확인
  if (res && res.ok) c.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 서울랜드 홈페이지 등 외부는 그대로
  if (url.pathname.startsWith('/api/')) return;          // 저장 요청은 그대로
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, 3500, 'index.html')); return; }
  if (url.pathname.endsWith('/data.json')) { e.respondWith(networkFirst(req, 4000, null, true)); return; }
  if (url.pathname.endsWith('/map.jpg')) { e.respondWith(cacheFirst(req, MAP_CACHE)); return; }
  e.respondWith(cacheFirst(req));
});
