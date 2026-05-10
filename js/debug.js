/* ============================================================
   ETA (Edge Thin Agent) — Debug Log Panel + Console Hook
   ============================================================ */

const _debugLogs = [];
const _maxDebugLogs = 500;

function toggleDebugPanel() {
  const panel = document.getElementById('debugPanel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) {
    const badge = document.getElementById('debugBadge');
    if (badge) badge.classList.remove('show');
    const log = document.getElementById('debugLog');
    if (log) log.scrollTop = log.scrollHeight;
  }
}

function debugLog(msg, type = 'info') {
  const n = new Date();
  const ts = `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}`;
  _debugLogs.push({ ts, msg, type });
  if (_debugLogs.length > _maxDebugLogs) _debugLogs.shift();
  const log = document.getElementById('debugLog');
  if (!log) return;
  const el = document.createElement('div');
  el.className = `debug-entry ${type}`;
  el.innerHTML = `<span class="debug-time">${ts}</span>${_debugEscHtml(msg)}`;
  log.appendChild(el);
  if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) {
    log.scrollTop = log.scrollHeight;
  }
  const panel = document.getElementById('debugPanel');
  if (panel && !panel.classList.contains('open') && (type === 'warn' || type === 'err')) {
    const badge = document.getElementById('debugBadge');
    if (badge) badge.classList.add('show');
  }
}

function _debugEscHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function clearDebugLog() {
  _debugLogs.length = 0;
  const log = document.getElementById('debugLog');
  if (log) log.innerHTML = '';
}

function copyDebugLog() {
  const text = _debugLogs.map(e => `[${e.ts}] [${e.type.toUpperCase()}] ${e.msg}`).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('已复制日志', 'ok')).catch(() => toast('复制失败', 'fail'));
}

// ── 拦截 console，把 Agent 相关日志同步到面板 ──
(function hookConsole() {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  function classify(msg) {
    if (/\[Agent 循环\]/.test(msg)) {
      if (/发送 API|body 大小/.test(msg)) return 'step';
      if (/API 响应|Promise\.all 完成|allSettled 完成/.test(msg)) return 'ok';
      if (/超时|异常|无有效/.test(msg)) return 'warn';
      return 'step';
    }
    if (/\[搜索 #/.test(msg)) {
      if (/完成/.test(msg)) return 'ok';
      return 'search';
    }
    if (/\[Stream\]/.test(msg)) return 'info';
    return null;
  }

  console.log = function(...args) {
    origLog(...args);
    try {
      const msg = args.map(a => typeof a === 'string' ? a : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      const type = classify(msg);
      if (type) debugLog(msg, type);
    } catch(_) {}
  };

  console.warn = function(...args) {
    origWarn(...args);
    try {
      const msg = args.map(a => typeof a === 'string' ? a : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      const type = classify(msg) || 'warn';
      debugLog(msg, type);
    } catch(_) {}
  };

  console.error = function(...args) {
    origError(...args);
    try {
      const msg = args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ');
      debugLog(msg, 'err');
    } catch(_) {}
  };
})();
