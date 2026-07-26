/* ============================================================
   ETA (Edge Thin Agent) — PWA 注册与安装入口
   ------------------------------------------------------------
   GitHub Pages 项目页部署在 /<repo>/ 子路径下，因此 sw 的注册路径与
   scope 都由当前页面 URL 推导（相对路径），不写死 '/'。
   file:// 打开时 service worker 不可用，静默跳过。
   ============================================================ */

// 当前页面所在目录，形如 /agent-website.github.io/
function pwaBaseDir() {
  const p = location.pathname;
  return p.endsWith('/') ? p : p.slice(0, p.lastIndexOf('/') + 1);
}

let _pwaReg = null;
let _pwaInstallEvent = null;

async function pwaRegister() {
  if (!('serviceWorker' in navigator)) return null;
  if (location.protocol === 'file:') {
    console.log('[PWA] file:// 下 service worker 不可用，跳过注册');
    return null;
  }
  const base = pwaBaseDir();
  try {
    _pwaReg = await navigator.serviceWorker.register(base + 'js/sw.js', { scope: base });
    console.log('[PWA] service worker 已注册, scope:', _pwaReg.scope);
    return _pwaReg;
  } catch (e) {
    console.warn('[PWA] 注册失败:', e.message);
    return null;
  }
}

// 浏览器判定可安装时才会触发；据此显示安装按钮
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _pwaInstallEvent = e;
    pwaSyncInstallBtn();
  });
  window.addEventListener('appinstalled', () => {
    _pwaInstallEvent = null;
    pwaSyncInstallBtn();
    toast(STATE.lang === 'en' ? 'ETA installed' : 'ETA 已安装到桌面', 'ok');
  });
}

function pwaCanInstall() { return !!_pwaInstallEvent; }

async function pwaInstall() {
  if (!_pwaInstallEvent) {
    const isZh = STATE.lang !== 'en';
    toast(isZh
      ? '当前浏览器未提供安装入口，可用地址栏的「安装/添加到主屏幕」'
      : 'No install prompt available; use the browser menu instead', 'info');
    return;
  }
  _pwaInstallEvent.prompt();
  try { await _pwaInstallEvent.userChoice; } catch (e) {}
  _pwaInstallEvent = null;
  pwaSyncInstallBtn();
}

function pwaSyncInstallBtn() {
  const btn = $('pwaInstallBtn');
  if (btn) btn.style.display = _pwaInstallEvent ? '' : 'none';
}

// 清空离线缓存（CDN 换版本或调试时用）
async function pwaClearCache() {
  const isZh = STATE.lang !== 'en';
  if (!('caches' in window)) { toast(isZh ? '当前浏览器不支持 Cache API' : 'Cache API unavailable', 'fail'); return; }
  try {
    const names = await caches.keys();
    await Promise.all(names.map(n => caches.delete(n)));
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'ETA_CLEAR_CACHE' });
    }
    toast(isZh ? '离线缓存已清空，刷新后重新下载' : 'Offline cache cleared', 'ok');
  } catch (e) {
    toast((isZh ? '清空失败: ' : 'Failed: ') + e.message, 'fail');
  }
}

async function pwaUnregister() {
  if (!('serviceWorker' in navigator)) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
  _pwaReg = null;
  toast(STATE.lang === 'en' ? 'Service worker unregistered' : '已注销 service worker', 'ok');
}

function pwaStatusText() {
  const isZh = STATE.lang !== 'en';
  if (!('serviceWorker' in navigator)) return isZh ? '浏览器不支持' : 'Unsupported';
  if (location.protocol === 'file:') return isZh ? 'file:// 下不可用' : 'Unavailable on file://';
  if (!_pwaReg) return isZh ? '未注册' : 'Not registered';
  return isZh ? '已启用（离线可用）' : 'Active (offline ready)';
}

// 注册放在 load 之后，不与首屏资源抢带宽
if (typeof window !== 'undefined') {
  if (document.readyState === 'complete') setTimeout(pwaRegister, 500);
  else window.addEventListener('load', () => setTimeout(pwaRegister, 500));
}
