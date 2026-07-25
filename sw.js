/* ================================================================
   拍书朗读 PWA - Service Worker
   策略：应用壳缓存优先 + 其他资源 Network First + 缓存清理
   ================================================================ */

const CACHE_VERSION = 2;
const CACHE_NAME = `book-reader-v${CACHE_VERSION}`;

// 应用静态资源（Cache First）
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
];

// CDN 资源（长期缓存）
const CDN_CACHE = 'book-reader-cdn-v1';
const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js',
];

// 域名分类
const isAppShell = (url) =>
  APP_SHELL.some((path) => url.pathname.endsWith(path)) || url.pathname === '/';

const isCDN = (url) =>
  CDN_URLS.some((cdn) => url.href.startsWith(new URL(cdn).origin));

const isTesseractData = (url) =>
  url.href.includes('tesseract.js') || url.href.includes('traineddata');

// === Install ===
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
    })()
  );
  self.skipWaiting();
});

// === Activate ===
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              key !== CACHE_NAME && key !== CDN_CACHE && !key.startsWith('book-reader-v')
          )
          .map((key) => caches.delete(key))
      );
    })()
  );
  self.clients.claim();
});

// === Fetch ===
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 策略 1: 应用壳 - Cache First（离线可用）
  if (isAppShell(url)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  // 策略 2: CDN 长期缓存
  if (isCDN(url)) {
    event.respondWith(
      caches.open(CDN_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const response = await fetch(event.request);
          cache.put(event.request, response.clone());
          return response;
        } catch {
          return cached || new Response('', { status: 408 });
        }
      })
    );
    return;
  }

  // 策略 3: Tesseract 数据（traineddata 等大文件）- Cache First，后台更新
  if (isTesseractData(url)) {
    event.respondWith(
      caches.open(CDN_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        const fetchPromise = fetch(event.request).then((response) => {
          cache.put(event.request, response.clone());
          return response;
        });
        return cached || fetchPromise;
      })
    );
    return;
  }

  // 策略 4: 其他请求 - Network First，失败时回退
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 成功时缓存
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request) || caches.match('./index.html'))
  );
});

// === 后台同步（预留） ===
self.addEventListener('sync', (event) => {
  // 可在此处理离线时的待处理任务
  console.log('[SW] sync event:', event.tag);
});
