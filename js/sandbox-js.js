/* ============================================================
   ETA (Edge Thin Agent) — JavaScript 沙箱（Worker + Blob URL，零依赖）
   ------------------------------------------------------------
   · 代码在独立 Worker 里跑：无 DOM、无 localStorage、无法触碰主页面
   · console.log / warn / error 全部收集回传，超时 10s 强制 terminate
   · 适合快速计算、JSON 处理、字符串变换，重活交给 run_python
   ============================================================ */

const JS_TIMEOUT_MS = 10000;
const JS_MAX_LOG_CHARS = 20000;

/* Worker 内部的引导代码：包裹用户代码、劫持 console、回传结果 */
const JS_WORKER_BOOTSTRAP = `
self.onmessage = async (ev) => {
  const logs = [];
  const fmt = (args) => Array.prototype.map.call(args, a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.name + ': ' + a.message;
    try { return JSON.stringify(a, (k, v) => typeof v === 'bigint' ? String(v) : v, 2); }
    catch (e) { return String(a); }
  }).join(' ');
  const push = (level, args) => { if (logs.length < 500) logs.push({ level, text: fmt(args) }); };
  self.console = {
    log: function() { push('log', arguments); },
    info: function() { push('log', arguments); },
    debug: function() { push('log', arguments); },
    warn: function() { push('warn', arguments); },
    error: function() { push('error', arguments); },
    table: function() { push('log', arguments); },
    trace: function() { push('log', arguments); },
    group: function() {}, groupEnd: function() {}, time: function() {}, timeEnd: function() {},
  };
  let result, error = null;
  try {
    const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFn('"use strict";\\n' + ev.data.code);
    result = await fn();
  } catch (e) {
    error = (e && e.stack) ? String(e.stack).split('\\n').slice(0, 6).join('\\n') : String(e);
  }
  let ser = '';
  if (result !== undefined) {
    if (typeof result === 'string') ser = result;
    else { try { ser = JSON.stringify(result, null, 2); } catch (e) { ser = String(result); } }
  }
  self.postMessage({ logs: logs, result: ser === undefined ? '' : String(ser), error: error });
};
`;

/* ── 主入口：在 Worker 里执行 JS，返回 { stdout, stderr, result, error } ── */
function runJsCode(code, opts) {
  opts = opts || {};
  const timeout = opts.timeout || JS_TIMEOUT_MS;
  const empty = { stdout: '', stderr: '', result: '', error: null };
  if (!code || !String(code).trim()) return Promise.resolve({ ...empty, error: '代码为空' });

  return new Promise(resolve => {
    let url = null, worker = null, done = false;
    const cleanup = () => {
      if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
      if (url) { try { URL.revokeObjectURL(url); } catch (e) {} url = null; }
    };
    const finish = out => { if (done) return; done = true; clearTimeout(timer); cleanup(); resolve(out); };

    const timer = setTimeout(() => {
      finish({ ...empty, error: `执行超时（${Math.round(timeout / 1000)}s），Worker 已终止` });
    }, timeout);

    try {
      url = URL.createObjectURL(new Blob([JS_WORKER_BOOTSTRAP], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (e) {
      finish({ ...empty, error: 'Worker 创建失败: ' + e.message });
      return;
    }
    worker.onmessage = ev => finish(normalizeJsWorkerResult(ev.data));
    worker.onerror = ev => finish({ ...empty, error: 'Worker 错误: ' + (ev.message || 'unknown') });
    try { worker.postMessage({ code: String(code) }); }
    catch (e) { finish({ ...empty, error: '代码传入 Worker 失败: ' + e.message }); }
  });
}

/* ── Worker 回传数据 → 统一结果结构（纯逻辑，可在 node 中单测） ── */
function normalizeJsWorkerResult(data) {
  const logs = (data && Array.isArray(data.logs)) ? data.logs : [];
  const outLines = [], errLines = [];
  for (const l of logs) {
    const text = String(l && l.text !== undefined ? l.text : '');
    if (l && (l.level === 'warn' || l.level === 'error')) errLines.push((l.level === 'warn' ? '[warn] ' : '[error] ') + text);
    else outLines.push(text);
  }
  const clip = s => s.length > JS_MAX_LOG_CHARS ? s.slice(0, JS_MAX_LOG_CHARS) + '\n[...日志已截断]' : s;
  return {
    stdout: clip(outLines.join('\n')),
    stderr: clip(errLines.join('\n')),
    result: data && data.result ? String(data.result).slice(0, 8000) : '',
    error: data && data.error ? String(data.error).slice(0, 4000) : null,
  };
}

/* ── 结果 → 给 LLM 的纯文本 ── */
function formatJsResultForLLM(result) {
  const parts = [];
  if (result.stdout) parts.push('[console]\n' + result.stdout);
  if (result.stderr) parts.push('[console.error/warn]\n' + result.stderr);
  if (result.result) parts.push('[返回值]\n' + result.result);
  if (result.error) parts.push('[错误]\n' + result.error);
  if (!parts.length) parts.push('[代码执行完成，无输出。用 console.log 或 return 返回结果。]');
  return parts.join('\n\n');
}

/* 供 index.html 自检使用 */
const SANDBOX_JS_READY = true;
