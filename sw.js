/* PWA_SAFE_PATCH_V124
   - 작업방 실시간 데이터/RTDB/채팅 요청은 캐시하지 않습니다.
   - HTML은 네트워크 우선으로 가져와 배포 직후 구버전이 오래 남지 않게 했습니다.
   - 같은 폴더의 정적 이미지/manifest 정도만 가볍게 캐시합니다.
*/
const CACHE_NAME = 'magammagam-pwa-v124-20260705-pgbgfix1';
const STATIC_ALLOW = [
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ALLOW).catch(() => undefined))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => key === CACHE_NAME ? undefined : caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase/Apps Script/API는 절대 캐시하지 않음

  const accept = req.headers.get('accept') || '';
  const isNavigation = req.mode === 'navigate' || accept.includes('text/html');

  if (isNavigation) {
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req)));
    return;
  }

  const isPlaygroundBackground = /\/assets\/playground\/[^/]+\.(?:jpg|jpeg|webp|png)$/i.test(url.pathname);
  if (isPlaygroundBackground) {
    // 놀이터 배경은 이름이 같아도 교체될 수 있으므로 네트워크를 먼저 확인합니다.
    // 오프라인일 때만 가장 최근 캐시를 보여 줍니다.
    event.respondWith((async () => {
      const cached = await caches.match(req);
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      } catch (err) {
        return cached || Response.error();
      }
    })());
    return;
  }

  const isSafeStatic = /\.(?:png|jpg|jpeg|webp|svg|gif|ico|webmanifest)$/i.test(url.pathname);
  if (!isSafeStatic) return;

  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
