/* ============================================================
   ETA (Edge Thin Agent) — Python 沙箱（Pyodide WASM，懒加载）
   ------------------------------------------------------------
   · 首次调用 runPythonCode() 时才下载 Pyodide（约 10MB），之后常驻复用
   · 捕获 stdout / stderr，执行完毕后自动把 matplotlib 图表转 base64 PNG
   · 知识缓存区里 type='file' 的文本条目写入虚拟文件系统 /data/，Python 可 open() 读取
   · 代码跑在 WASM 沙箱内：无法访问本机文件系统，只能看到显式挂载的缓存区内容
   ============================================================ */

const PYODIDE_VERSION = '0.26.4';
const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v' + PYODIDE_VERSION + '/full/';
const PY_TIMEOUT_MS = 30000;

let _pyodide = null;        // Pyodide 实例（常驻）
let _pyLoading = null;      // 加载中的 promise，并发调用复用它，避免重复下载 10MB
let _pyTainted = false;     // 上次执行超时 → 解释器状态不可信，下次调用前重建
let _pyInterruptBuf = null; // 中断标志缓冲区（仅在 crossOriginIsolated 下可用）
const _pyLoadedPkgs = new Set();

/* Python 标准库（无需下载）——命中这里的 import 直接忽略 */
const PY_STDLIB = new Set(['sys','os','io','re','json','csv','math','cmath','random','statistics',
  'datetime','time','calendar','itertools','functools','collections','heapq','bisect','array',
  'decimal','fractions','string','textwrap','unicodedata','struct','copy','pprint','pathlib',
  'typing','dataclasses','enum','abc','contextlib','operator','warnings','traceback','types',
  'hashlib','hmac','base64','binascii','secrets','uuid','zlib','gzip','bz2','lzma','tarfile',
  'zipfile','sqlite3','pickle','shelve','glob','shutil','tempfile','fnmatch','filecmp','stat',
  'asyncio','threading','queue','concurrent','subprocess','signal','socket','select','ssl',
  'urllib','http','email','html','xml','unittest','doctest','argparse','logging','inspect',
  'importlib','pkgutil','ast','dis','gc','weakref','numbers','keyword','builtins','__future__',
  'difflib','locale','gettext','codecs','encodings','platform','getpass','pty','turtle']);

/* Pyodide 自带预编译包：import 名 → 包名。走 loadPackage 比 micropip 快得多 */
const PY_BUILTIN_PKGS = {
  numpy: 'numpy', pandas: 'pandas', matplotlib: 'matplotlib', mpl_toolkits: 'matplotlib',
  scipy: 'scipy', sympy: 'sympy', networkx: 'networkx', statsmodels: 'statsmodels',
  sklearn: 'scikit-learn', skimage: 'scikit-image', PIL: 'pillow', bs4: 'beautifulsoup4',
  lxml: 'lxml', html5lib: 'html5lib', soupsieve: 'soupsieve', regex: 'regex',
  yaml: 'pyyaml', dateutil: 'python-dateutil', pytz: 'pytz', six: 'six',
  attrs: 'attrs', cffi: 'cffi', cytoolz: 'cytoolz', toolz: 'toolz',
  pyparsing: 'pyparsing', packaging: 'packaging', jinja2: 'Jinja2', markupsafe: 'MarkupSafe',
  nltk: 'nltk', PIL_Image: 'pillow', openpyxl: 'openpyxl', xlrd: 'xlrd',
  micropip: 'micropip', pytest: 'pytest', sqlalchemy: 'SQLAlchemy', astropy: 'astropy',
  numexpr: 'numexpr', bokeh: 'bokeh', pillow: 'pillow', imageio: 'imageio',
};

/* ── 从代码里提取顶层 import 的模块名（纯逻辑，可在 node 中单测） ── */
function detectPyImports(code) {
  const mods = new Set();
  const src = String(code || '').replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, '');
  for (let line of src.split(/\r?\n/)) {
    line = line.replace(/#.*$/, '').trim();
    if (!line) continue;
    let m = /^import\s+(.+)$/.exec(line);
    if (m) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim().split('.')[0];
        if (/^[A-Za-z_]\w*$/.test(name)) mods.add(name);
      }
      continue;
    }
    m = /^from\s+([A-Za-z_][\w.]*)\s+import\s+/.exec(line);
    if (m) mods.add(m[1].split('.')[0]);
  }
  return Array.from(mods);
}

/* ── 把模块名分流为「Pyodide 自带包」与「需要 micropip 装」 ── */
function pyPackagesFor(mods) {
  const builtin = new Set();
  const micropip = [];
  for (const mod of (mods || [])) {
    if (PY_STDLIB.has(mod)) continue;
    if (PY_BUILTIN_PKGS[mod]) { builtin.add(PY_BUILTIN_PKGS[mod]); continue; }
    if (micropip.length < 3) micropip.push(mod); // 防止模型乱 import 拖慢执行
  }
  return { builtin: Array.from(builtin), micropip };
}

/* ── 文件名净化：缓存区条目名 → 虚拟文件系统安全路径 ── */
function pyFsSafeName(name) {
  // 保留中日韩字符（Python open() 支持 UTF-8 文件名），去掉路径分隔符与前导点
  const s = String(name || 'file')
    .replace(/[^\w.\-\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, '_')
    .replace(/^[._]+|_+$/g, '');
  return (s || 'file').slice(0, 80);
}

/* ── 懒加载 Pyodide 主体（并发复用同一个 promise） ── */
function ensurePyodide() {
  if (_pyodide && !_pyTainted) return Promise.resolve(_pyodide);
  if (_pyLoading) return _pyLoading;
  _pyLoading = (async () => {
    if (_pyTainted) {
      // 上次执行超时，同步代码无法中断，只能丢弃旧解释器重建
      console.warn('[Pyodide] 上次执行超时，重建解释器');
      _pyodide = null; _pyLoadedPkgs.clear(); _pyTainted = false;
    }
    if (typeof loadPyodide === 'undefined') {
      toast(STATE.lang === 'en' ? 'Downloading Python runtime (~10MB), first time only...'
        : '正在下载 Python 运行时（约 10MB，仅首次）...', 'info');
      await pyLoadScript(PYODIDE_CDN + 'pyodide.js');
    }
    if (typeof loadPyodide === 'undefined') throw new Error('Pyodide CDN 加载失败');
    const py = await loadPyodide({ indexURL: PYODIDE_CDN });
    _pyodide = py;
    toast(STATE.lang === 'en' ? 'Python runtime ready' : 'Python 运行时已就绪', 'ok');
    return py;
  })().finally(() => { _pyLoading = null; });
  return _pyLoading;
}

/* ── 动态插入 <script>（CDN 懒加载通用工具） ── */
function pyLoadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-lazy-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('脚本加载失败: ' + src)), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.dataset.lazySrc = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error('脚本加载失败: ' + src));
    document.head.appendChild(s);
  });
}

/* ── 按需装包：自带包走 loadPackage，其余交给 micropip ── */
async function pyEnsurePackages(py, code) {
  const { builtin, micropip } = pyPackagesFor(detectPyImports(code));
  const todo = builtin.filter(p => !_pyLoadedPkgs.has(p));
  if (todo.length) {
    toast((STATE.lang === 'en' ? 'Loading Python packages: ' : '正在加载 Python 包: ') + todo.join(', '), 'info');
    try {
      await py.loadPackage(todo);
      todo.forEach(p => _pyLoadedPkgs.add(p));
    } catch (e) { console.warn('[Pyodide] loadPackage 失败:', e.message); }
  }
  const pipTodo = micropip.filter(p => !_pyLoadedPkgs.has(p));
  if (pipTodo.length) {
    try {
      if (!_pyLoadedPkgs.has('micropip')) { await py.loadPackage('micropip'); _pyLoadedPkgs.add('micropip'); }
      const mp = py.pyimport('micropip');
      for (const p of pipTodo) {
        try { await mp.install(p); _pyLoadedPkgs.add(p); }
        catch (e) { console.warn(`[Pyodide] micropip 安装 ${p} 失败: ${e.message}`); }
      }
    } catch (e) { console.warn('[Pyodide] micropip 不可用:', e.message); }
  }
}

/* ── 把知识缓存区的文本文件挂进 /data/，返回已挂载的文件名列表 ── */
function pyMountCtxFiles(py) {
  const mounted = [];
  let buf = [];
  try { buf = (typeof getCtxBuffer === 'function' ? getCtxBuffer() : []) || []; } catch (e) { buf = []; }
  try { py.FS.mkdirTree('/data'); } catch (e) { /* 已存在 */ }
  for (const item of buf) {
    if (item.type !== 'file' || typeof item.content !== 'string' || !item.content) continue;
    const fname = pyFsSafeName(item.name);
    try {
      py.FS.writeFile('/data/' + fname, item.content, { encoding: 'utf8' });
      mounted.push(fname);
    } catch (e) { console.warn(`[Pyodide] 写入 /data/${fname} 失败: ${e.message}`); }
  }
  return mounted;
}

/* 执行前置：
   · 强制 matplotlib 用 Agg backend（无 DOM 依赖，可 savefig 到内存）
   · 掐掉字形缺失警告。Pyodide 的 matplotlib 只带 DejaVu Sans，图里出现中日韩
     字符时每个字都会 warn 一次「Glyph xxx missing from current font」，一张图
     刷出几十行，把 stderr 彻底淹掉。警告本身无法通过换字体消除（装一套 CJK 字体
     要额外下载十几 MB），所以这里直接静音，并在工具说明里要求模型给图表用
     ASCII 标签——那才是根治，否则中文标签渲染出来是一排方框。
   · font_manager 找不到字体时也会 log 一堆 findfont 警告，一并降级。 */
const PY_PRELUDE = [
  'import os, sys',
  "os.environ['MPLBACKEND'] = 'AGG'",
  "sys.path.insert(0, '/data') if '/data' not in sys.path else None",
  'import warnings, logging',
  "warnings.filterwarnings('ignore', message='.*missing from current font.*')",
  "warnings.filterwarnings('ignore', message='.*Glyph .* missing.*')",
  "warnings.filterwarnings('ignore', category=UserWarning, module='matplotlib')",
  "logging.getLogger('matplotlib.font_manager').setLevel(logging.ERROR)",
  "logging.getLogger('matplotlib').setLevel(logging.ERROR)",
].join('\n');

/* 兜底过滤：模型自己调 warnings.resetwarnings() 或用 -W 之类手段重新打开时，
   前置静音会失效，所以拿到 stderr 后再按行滤一遍。
   只滤已知无害的噪声行，真正的 Traceback / Error / 用户自己 print 到 stderr
   的内容一律保留——否则代码出错时用户和模型都看不到原因。 */
const PY_NOISE_PATTERNS = [
  /Glyph \d+ .*missing from current font/i,
  /findfont: .*(not found|falling back)/i,
  /UserWarning: Matplotlib is currently using agg/i,
  /^\s*(warnings\.warn|self\._warn_if_gui_out_of_main_thread)\(/,
];

function pyFilterStderr(text) {
  const src = String(text == null ? '' : text);
  if (!src) return '';
  const lines = src.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (PY_NOISE_PATTERNS.some(re => re.test(line))) {
      /* warnings 的输出是两行一组：第一行是 "<exec>:71: UserWarning: ..."，
         紧跟一行源码回显（常见是缩进的代码片段）。命中噪声时把紧随其后的
         那行源码回显也吃掉，否则会剩下一堆没有上文的孤立代码行。 */
      const next = lines[i + 1];
      if (next !== undefined && next.trim() && /^\s/.test(next) && !/error|traceback/i.test(next)) i++;
      continue;
    }
    kept.push(line);
  }
  // 全是噪声时返回空串，UI 与 LLM 都不会看到 stderr 区块
  return kept.join('\n').trim() ? kept.join('\n') : '';
}

/* 执行后置：遍历所有 figure 存成 base64 PNG（比拦截 plt.show 可靠得多） */
const PY_COLLECT_FIGS = [
  'def _eta_collect_figs():',
  '    try:',
  '        import matplotlib',
  '        import matplotlib.pyplot as plt',
  '    except Exception:',
  '        return []',
  '    import io, base64',
  '    out = []',
  '    for num in plt.get_fignums():',
  '        try:',
  '            fig = plt.figure(num)',
  '            bio = io.BytesIO()',
  '            fig.savefig(bio, format="png", dpi=110, bbox_inches="tight")',
  '            out.append(base64.b64encode(bio.getvalue()).decode("ascii"))',
  '        except Exception:',
  '            pass',
  '    plt.close("all")',
  '    return out',
  '_eta_collect_figs()',
].join('\n');

/* ── 主入口：执行 Python 代码 ──
   返回 { stdout, stderr, result, images: [base64...], mounted: [...], error }
   超时取舍：Pyodide 同步执行独占主线程，JS 侧无法抢占。若浏览器允许
   SharedArrayBuffer（需 COOP/COEP 头，GitHub Pages 默认没有），用
   setInterruptBuffer 可真正打断；否则只能超时告警并把解释器标记为 tainted，
   下次调用时整体重建，避免残留状态污染后续执行。 */
let _pyQueue = Promise.resolve();
function runPythonCode(code, opts) {
  // 单解释器共享 stdout/FS，多个 tool_call 并行会互相污染 → 串行排队
  const task = _pyQueue.then(() => _runPythonCodeInner(code, opts));
  _pyQueue = task.catch(() => {});
  return task;
}

async function _runPythonCodeInner(code, opts) {
  opts = opts || {};
  const timeout = opts.timeout || PY_TIMEOUT_MS;
  const out = { stdout: '', stderr: '', result: '', images: [], mounted: [], error: null };
  if (!code || !String(code).trim()) { out.error = '代码为空'; return out; }
  let py;
  try { py = await ensurePyodide(); }
  catch (e) { out.error = 'Python 运行时加载失败: ' + e.message; return out; }

  const stdoutChunks = [], stderrChunks = [];
  try { py.setStdout({ batched: s => stdoutChunks.push(s) }); } catch (e) {}
  try { py.setStderr({ batched: s => stderrChunks.push(s) }); } catch (e) {}
  // 中断缓冲区：仅在跨源隔离环境（SharedArrayBuffer 可用）下生效
  let interrupted = false;
  if (!_pyInterruptBuf && typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated) {
    try { _pyInterruptBuf = new Uint8Array(new SharedArrayBuffer(1)); py.setInterruptBuffer(_pyInterruptBuf); }
    catch (e) { _pyInterruptBuf = null; }
  }
  if (_pyInterruptBuf) _pyInterruptBuf[0] = 0;

  try { out.mounted = pyMountCtxFiles(py); } catch (e) { console.warn('[Pyodide] 挂载缓存文件失败:', e.message); }
  try { await pyEnsurePackages(py, code); } catch (e) { console.warn('[Pyodide] 装包阶段异常:', e.message); }

  const timer = setTimeout(() => {
    interrupted = true;
    if (_pyInterruptBuf) _pyInterruptBuf[0] = 2; // SIGINT → 抛 KeyboardInterrupt
    else _pyTainted = true;
  }, timeout);
  try {
    await py.runPythonAsync(PY_PRELUDE);
    const res = await py.runPythonAsync(String(code));
    if (res !== undefined && res !== null) {
      try { out.result = typeof res === 'object' && res.toString ? res.toString() : String(res); }
      catch (e) { out.result = ''; }
      if (res && typeof res.destroy === 'function') { try { res.destroy(); } catch (e) {} }
    }
  } catch (e) {
    out.error = interrupted
      ? `执行超时（${Math.round(timeout / 1000)}s）已中断`
      : String(e && e.message ? e.message : e).slice(0, 4000);
  } finally {
    clearTimeout(timer);
    if (_pyInterruptBuf) _pyInterruptBuf[0] = 0;
  }
  if (!out.error || interrupted) {
    try {
      const figs = await py.runPythonAsync(PY_COLLECT_FIGS);
      if (figs) { out.images = figs.toJs ? figs.toJs() : Array.from(figs); if (figs.destroy) figs.destroy(); }
    } catch (e) { console.warn('[Pyodide] 收集图表失败:', e.message); }
  }
  out.stdout = stdoutChunks.join('\n');
  out.stderr = pyFilterStderr(stderrChunks.join('\n'));
  return out;
}

/* ── 把执行结果整理成给 LLM 的纯文本（base64 图片绝不进上下文） ── */
function formatPyResultForLLM(result) {
  const parts = [];
  if (result.mounted && result.mounted.length) {
    parts.push(`[已挂载缓存文件到 /data/: ${result.mounted.join(', ')}]`);
  }
  if (result.stdout) parts.push('[stdout]\n' + result.stdout);
  if (result.stderr) parts.push('[stderr]\n' + result.stderr);
  if (result.result) parts.push('[返回值]\n' + String(result.result).slice(0, 2000));
  if (result.images && result.images.length) {
    parts.push(`[已生成 ${result.images.length} 张图表，已直接渲染给用户查看。图片数据不放入上下文，如需说明请用文字描述。]`);
  }
  if (result.error) parts.push('[错误]\n' + result.error);
  if (!parts.length) parts.push('[代码执行完成，无输出。如需查看结果请使用 print()。]');
  return parts.join('\n\n');
}

/* 供 index.html 自检使用 */
const SANDBOX_PYTHON_READY = true;
