// App shell 用 stale-while-revalidate：先出快取瞬間開啟，背景抓新版更新快取——
// 部署新前端後「下一次」開啟才生效（比 network-first 晚一次，換來每次冷啟動不等網路）。
// GAS API 是跨域（script.google.com），不會被這裡攔截。
const CACHE = 'mb-shell-v1';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json', './icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // no-cache 強制向伺服器 revalidate（有 ETag，304 很便宜）——GitHub Pages 送 max-age=600，
  // 不加的話部署後最多 10 分鐘拿到 HTTP cache 裡的舊檔。
  // 用 url 而非 request：navigate mode 的 Request 帶 init 重建會拋錯
  const update = fetch(e.request.url, { cache: 'no-cache' }).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return res;
  });
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(cached => {
      if (cached) {
        e.waitUntil(update.catch(() => {})); // 撐住 SW 生命週期讓背景更新跑完
        return cached;
      }
      return update;
    })
  );
});
