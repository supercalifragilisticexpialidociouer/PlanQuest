/* PlanQuest 网页版 Service Worker —— 离线可用
   策略：导航请求走「网络优先」（保证更新能拿到），静态资源走「缓存优先」。 */
'use strict';

const CACHE = 'pq-web-v53';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ally.js',
  './share.js',
  './credit-priv.js',
  './chat-mod.js',
  './legion-chat.js',
  './legion-discipline.js',
  './legion-gov.js',
  './legion-mesh-policy.js',
  './legion-mesh.js',
  './legion-p2p.js',
  './legion-channel.js',
  './legion.js',
  './ai-watch.js',
  './ai-chat.js',
  './ai-train.js',
  './flip-guard.js',
  './voice-asr.js',
  './buddy.js',
  './buddy3d.js',
  './vendor/three.min.js',
  './hr.js',
  './api-bridge.js',
  './native-guard.js',
  './core/pq-core.js',
  './core/pq-cloud.js',
  './vendor/workbuddy-cloud.js',
  './vendor/ort/ort.wasm.min.js',
  './vendor/ort/ort-wasm-simd-threaded.mjs',
  './vendor/ort/ort-wasm-simd-threaded.wasm',
  './vendor/pq-ai/best.onnx',
  './vendor/pq-ai/labels.json',
  './vendor/pq-ai/model_info.json',
  './assets/icon.png',
  './ind-icon.js',
  './assets/ind/00.png',
  './assets/ind/01.png',
  './assets/ind/02.png',
  './assets/ind/03.png',
  './assets/ind/04.png',
  './assets/ind/05.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 页面导航：先联网，失败回落到缓存
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 静态资源：缓存优先
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
    })
  );
});
