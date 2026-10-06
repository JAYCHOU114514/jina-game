/* 合成大基娜 — Service Worker
 *
 * 目的：国内访问 GitHub Pages 实测只有 17~54 KB/s、首屏 3~7 秒。
 * 装了 SW 之后第一次加载完就全在本地，之后秒开，断网也能玩，
 * 手机上还能「添加到主屏幕」当 App 用。
 *
 * ⚠️ 每次发新版请把下面的版本号 +1，否则老用户会一直用旧缓存。
 *    例如 jina-v1 -> jina-v2
 */
const CACHE = 'jina-v1';

// 预缓存核心文件（体积小、必须可用）。精灵图不列在这里，
// 因为游戏开局会一次性把 11 张全加载，运行时缓存自然会覆盖到。
const CORE = ['./', './index.html', './style.css', './game.js', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 逐个 add：某一张 404 不应该让整个安装失败
      .then((cache) => Promise.allSettled(CORE.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  // 只管自己的资源，别去碰跨域的
  if (url.origin !== self.location.origin) return;

  // 导航请求：优先吐缓存的 index.html（这样断网也能打开）
  if (req.mode === 'navigate') {
    event.respondWith(
      caches
        .match('./index.html')
        .then((hit) => hit || fetch(req))
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 其余资源：stale-while-revalidate —— 先给缓存（秒开），
  // 同时后台悄悄拉新版更新缓存，下次打开就是新版。
  event.respondWith(
    caches.match(req).then((hit) => {
      const fromNet = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches
              .open(CACHE)
              .then((c) => c.put(req, copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || fromNet;
    })
  );
});
