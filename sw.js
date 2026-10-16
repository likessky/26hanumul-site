/* 한우물제 오프라인 지원
 * 한 번 열어 둔 휴대폰은 행사장 데이터가 끊기거나 느려도 안내를 볼 수 있어요.
 * 화면 코드를 바꾸면 VERSION 숫자만 올리면 됩니다.
 * 지도(map.jpg, 약 1MB)는 따로 보관해서 VERSION을 올려도 다시 받지 않아요.
 * 지도 이미지를 바꿀 때만 MAP_CACHE 숫자를 올려 주세요.
 */
const VERSION = 'hanumul-v21';
const MAP_CACHE = 'hanumul-map-1';
const CORE = ['./', 'index.html', 'emblem.png', 'manifest.webmanifest', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' }))); // 브라우저에 남은 예전 화면 말고 서버의 새 화면을 저장
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
  wakeOldPages(); // 활성화를 늦추지 않도록 기다리지 않고 따로 진행
});

/* 예전 화면 깨우기
 * 10/15 오후 이전 화면에는 "새 버전이 나오면 스스로 새로고침"하는 코드가 없어서,
 * 휴대폰이 백그라운드에서 되살린 예전 화면은 퀴즈 탭이 없는 채로 남아 있어요.
 * 새 화면은 'hello'에 'hello-ack'로 답하므로, 답하지 않는 창만 골라 한 번 새로 열어요.
 * (새 화면은 원래대로 스스로 새로고침하고, 수정·퀴즈 중이면 끝날 때까지 미뤄요) */
const acks = new Set();
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'hello-ack' && e.source) acks.add(e.source.id);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function wakeOldPages() {
  try {
    await wait(3000); // 스스로 새로고침하는 화면은 먼저 새로고침하도록
    const list = await self.clients.matchAll({ type: 'window' });
    list.forEach((c) => { try { c.postMessage({ type: 'hello' }); } catch (x) {} });
    await wait(2500);
    for (const c of await self.clients.matchAll({ type: 'window' })) {
      if (acks.has(c.id) || !list.some((x) => x.id === c.id)) continue;
      if (new URL(c.url).origin !== self.location.origin) continue;
      try { await c.navigate(c.url); } catch (x) {}
    }
  } catch (x) {}
}

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

// 시간 안에 못 받아 저장본을 보여 준 경우에도, 늦게 도착한 새 화면은 저장해 두고
// 저장본과 내용이 다르면 열려 있는 화면에 알려서 한 번 새로고침하게 함
async function lateUpdate(net, c, key, notify) {
  try {
    const res = await net;
    if (!res || !res.ok) return;
    const old = await c.match(key, { ignoreSearch: true });
    const fresh = await res.clone().text();
    const changed = !old || (await old.text()) !== fresh;
    await c.put(key, res);
    if (changed && notify) for (const cl of await self.clients.matchAll({ type: 'window' })) cl.postMessage({ type: 'page-updated' });
  } catch (e) {}
}

async function networkFirst(e, req, ms, key, mark) {
  const c = await caches.open(VERSION);
  const net = fetch(req, { cache: 'no-cache' });
  try {
    const res = await Promise.race([net, timeout(ms)]);
    if (res && res.ok) { c.put(key || req, res.clone()); return res; }
    throw new Error('bad');
  } catch (err) {
    const hit = await c.match(key || req, { ignoreSearch: true });
    if (hit) try { e.waitUntil(lateUpdate(net, c, key || req, req.mode === 'navigate')); } catch (x) {}
    // 화면이 "최신 안내"라고 잘못 표시하지 않도록 저장본이라는 표시를 붙임
    if (hit && mark) { const h = new Headers(hit.headers); h.set('X-From-Cache', '1'); return new Response(hit.body, { status: 200, headers: h }); }
    if (hit) return hit;
    return net; // 캐시도 없으면 끝까지 기다림
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
  if (url.pathname.endsWith('/announce.json')) return;   // 공지는 항상 네트워크로 (오프라인에서 예전 공지를 다시 띄우지 않도록)
  if (req.mode === 'navigate') { e.respondWith(networkFirst(e, req, 3500, 'index.html')); return; }
  if (url.pathname.endsWith('/data.json')) { e.respondWith(networkFirst(e, req, 4000, null, true)); return; }
  if (url.pathname.endsWith('/map.jpg')) { e.respondWith(cacheFirst(req, MAP_CACHE)); return; }
  e.respondWith(cacheFirst(req));
});
