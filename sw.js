/* ============================================================
   ETA (Edge Thin Agent) — Service Worker
   ------------------------------------------------------------
   部署在 GitHub Pages 项目页，站点可能挂在 /<repo>/ 子路径下，
   所以一律用相对 registration.scope 推导路径，绝不写死 '/'。

   缓存分三档：
     - 本站资源（同 scope 的 js/css/html）：stale-while-revalidate
       —— 秒开且后台更新，用户下次刷新拿到新版
     - CDN 资源（跨域 highlight/marked/KaTeX/pdf.js…）：cache-first
       —— 版本号带在 URL 里，命中即可长期复用；离线也能渲染
     - API 请求（chat/completions、models、搜索代理…）：一律不碰
       —— 流式响应经不起缓存，且回放旧回答会误导用户
   ============================================================ */

// 改动预缓存清单后必须递增版本号，否则老 SW 会一直用旧的文件列表
const SW_VERSION = 'eta-v2';
const LOCAL_CACHE = SW_VERSION + '-local';
const CDN_CACHE = SW_VERSION + '-cdn';

// scope 形如 https://user.github.io/agent-website.github.io/
const SCOPE_URL = new URL(self.registration ? self.registration.scope : './', self.location.href);
const SCOPE_PATH = SCOPE_URL.pathname;

// 首屏必需的本站文件（相对 scope 解析，子路径部署也正确）
const PRECACHE_FILES = [
  '', 'index.html', 'manifest.json', 'css/styles.css',
  'js/debug.js', 'js/storage.js', 'js/state.js', 'js/conversation.js', 'js/render.js',
  'js/artifacts.js', 'js/file-parser.js', 'js/search.js', 'js/retrieval.js',
  'js/context-buffer.js', 'js/custom-tools.js',
  'js/memory.js', 'js/profile.js', 'js/memory-ui.js',
  'js/agent.js', 'js/agent-loop.js',
  'js/sandbox-python.js', 'js/sandbox-js.js', 'js/agent-commands.js', 'js/agent-generate.js',
  'js/eta-config.js', 'js/agent-timeline.js', 'js/multi-model.js', 'js/voice.js',
  'js/prompt-library.js', 'js/export-plus.js', 'js/pwa.js', 'js/eta-settings.js',
  'js/ui.js', 'js/init.js', 'icon.svg',
];

// API 路径特征：命中即完全绕过 SW
const API_PATTERNS = [
  /\/chat\/completions/i, /\/v1\/models/i, /\/embeddings/i, /\/dashboard\//i,
  /\/billing\//i, /\/balance/i, /\/user\/dashboard/i,
  /api\.search\.brave\.com/i, /allorigins/i, /corsproxy/i,
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(LOCAL_CACHE);
    // 单个文件 404 不能让整个 install 失败（env.js 被 gitignore，线上就是没有）
    await Promise.all(PRECACHE_FILES.map(async f => {
      const url = new URL(f, SCOPE_URL).href;
      try {
        const resp = await fetch(url, { cache: 'reload' });
        if (resp.ok) await cache.put(url, resp);
      } catch (e) { /* 离线安装或文件缺失，忽略 */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.indexOf(SW_VERSION) !== 0).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

function isApiRequest(url) {
  return API_PATTERNS.some(re => re.test(url.href));
}

function isLocalAsset(url) {
  return url.origin === SCOPE_URL.origin && url.pathname.startsWith(SCOPE_PATH);
}

// 只缓存明确的静态库资源，避免把任意跨域响应囤起来
function isCdnAsset(url) {
  if (url.origin === SCOPE_URL.origin) return false;
  if (!/^https:$/.test(url.protocol)) return false;
  if (!/\.(?:js|css|woff2?|ttf|wasm|json|map)$/i.test(url.pathname)) return false;
  return /cdnjs\.cloudflare\.com|jsdelivr\.net|unpkg\.com|cdn\.jsdelivr\.net/i.test(url.hostname);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (isApiRequest(url)) return;               // 交给网络，SW 完全不介入
  if (url.protocol === 'chrome-extension:') return;

  if (isLocalAsset(url)) { event.respondWith(staleWhileRevalidate(req, LOCAL_CACHE)); return; }
  if (isCdnAsset(url)) { event.respondWith(cacheFirst(req, CDN_CACHE)); return; }
});

// 先给缓存（秒开），同时后台拉新版写回
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: false });
  const network = fetch(req).then(resp => {
    if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  }).catch(() => null);
  if (cached) { network.catch(() => {}); return cached; }
  const fresh = await network;
  if (fresh) return fresh;
  // 导航请求离线兜底到首页，避免出现浏览器的恐龙页
  if (req.mode === 'navigate') {
    const shell = await cache.match(new URL('index.html', SCOPE_URL).href);
    if (shell) return shell;
  }
  return new Response('offline', { status: 503, statusText: 'Offline' });
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    // 跨域库多为 opaque 响应（type: 'cors' 才有 ok），两种都存，离线才用得上
    if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch (e) {
    return new Response('/* offline: CDN asset unavailable */', {
      status: 503, headers: { 'Content-Type': 'application/javascript' },
    });
  }
}

// 页面可以主动要求清空 CDN 缓存（设置里给了按钮）
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'ETA_CLEAR_CACHE') {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
      if (event.source) event.source.postMessage({ type: 'ETA_CACHE_CLEARED' });
    })());
  }
  if (data.type === 'ETA_SKIP_WAITING') self.skipWaiting();
});
