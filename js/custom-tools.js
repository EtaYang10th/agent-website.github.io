/* ============================================================
   ETA (Edge Thin Agent) — User-defined HTTP Tools
   ------------------------------------------------------------
   让用户不改代码就能给 Agent 加接口：填 URL 模板 + 提取路径，
   运行时自动生成 OpenAI 规范的 tool schema 合入 getToolDefinitions()。

   响应提取路径语法（够用子集，见 ctFormatDoc / README 说明）：
     a.b.c        —— 逐级取对象字段
     a.0.b        —— 数字段视为数组下标
     a[].b        —— 对数组每个元素取 b，结果展开为列表
     a.*.b        —— 对对象的每个 value 取 b（Firebase/HN 风格的 map）
     留空         —— 直接把整份响应 JSON 序列化回传（截断保护）
   多条路径用换行分隔，每行可写 `标题|路径` 给字段起名。

   安全：URL 必须 http/https；占位符替换一律 encodeURIComponent，
   防止参数值里塞 `&admin=1` 或 `../` 改写 URL 结构；导出 JSON 默认排除 headers
   （里面常有用户的 API key）。CORS 走 search.js 的 fetchViaProxy。
   ============================================================ */

// ── 常量 ──
const CT_STORE_KEY = 'custom-tools:v1';   // STORE_MAIN 内的键（复用现有 store，不动 DB 版本）
const CT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/; // OpenAI 函数命名约束
const CT_MAX_RESULT_CHARS = 8000;
const CT_TIMEOUT_MS = 20000;

// 运行时缓存：[{ id, name, description, url, method, headers, bodyTemplate, extract, params, enabled }]
let CT_TOOLS = [];
let _ctLoaded = false;

// ── 加载 / 保存（IndexedDB）──
async function ctLoad() {
  try {
    const list = await idbGet(CT_STORE_KEY, STORE_MAIN);
    CT_TOOLS = Array.isArray(list) ? list.map(ctNormalize) : [];
  } catch (e) {
    console.warn('[CustomTools] 读取失败:', e);
    CT_TOOLS = [];
  }
  _ctLoaded = true;
  return CT_TOOLS;
}

async function ctSave() {
  try { await idbSet(CT_STORE_KEY, CT_TOOLS, STORE_MAIN); }
  catch (e) { console.warn('[CustomTools] 保存失败:', e); toast(STATE.lang === 'en' ? 'Failed to save custom tools' : '自定义工具保存失败', 'fail'); }
}

function ctNormalize(t) {
  return {
    id: t.id || uid(),
    name: String(t.name || '').trim(),
    description: String(t.description || '').trim(),
    url: String(t.url || '').trim(),
    method: (String(t.method || 'GET').toUpperCase() === 'POST') ? 'POST' : 'GET',
    headers: (t.headers && typeof t.headers === 'object') ? t.headers : {},
    bodyTemplate: String(t.bodyTemplate || ''),
    extract: String(t.extract || ''),
    params: Array.isArray(t.params) && t.params.length ? t.params.map(p => ({
      name: String(p.name || 'query').trim() || 'query',
      description: String(p.description || '').trim(),
      required: p.required !== false,
    })) : [{ name: 'query', description: 'Query keywords', required: true }],
    enabled: t.enabled !== false,
  };
}

function ctGetAll() { return CT_TOOLS; }
function ctFindByName(name) { return CT_TOOLS.find(t => t.enabled && t.name === name) || null; }

// ── 内置工具名清单（自定义工具不得与之重名）──
function ctBuiltinNames() {
  const names = (typeof TOOL_NAME_TO_CMD === 'object' && TOOL_NAME_TO_CMD) ? Object.keys(TOOL_NAME_TO_CMD) : [];
  // ctx_search 等后续新增的内置名也会自动出现在 TOOL_NAME_TO_CMD 里
  return new Set(names);
}

/* ── 校验（纯函数，可单测）──
   返回 null 表示通过，否则返回错误信息字符串。 */
function ctValidate(tool, existingList, builtinNames) {
  const t = ctNormalize(tool || {});
  if (!CT_NAME_RE.test(t.name)) return '工具名必须匹配 ^[a-zA-Z0-9_-]{1,64}$（字母/数字/下划线/连字符）';
  if (builtinNames && builtinNames.has(t.name)) return `工具名 "${t.name}" 与内置工具冲突，请换一个名字`;
  if ((existingList || []).some(x => x.name === t.name && x.id !== t.id)) return `工具名 "${t.name}" 已存在`;
  if (!t.description) return '请填写工具描述（模型靠它判断何时调用）';
  const urlErr = ctValidateUrl(t.url);
  if (urlErr) return urlErr;
  if (t.method === 'POST' && t.bodyTemplate) {
    // 占位符替换后才是合法 JSON，这里用假值探测一次
    const probe = ctFillTemplate(t.bodyTemplate, { query: 'x' }, false);
    if (!/^\s*[\[{]/.test(probe)) return '请求体模板应为 JSON 对象或数组';
    try { JSON.parse(probe); } catch (e) { return '请求体模板不是合法 JSON: ' + e.message; }
  }
  if (!t.params.length) return '至少需要一个参数';
  for (const p of t.params) {
    if (!CT_NAME_RE.test(p.name)) return `参数名 "${p.name}" 非法，须匹配 ^[a-zA-Z0-9_-]{1,64}$`;
  }
  return null;
}

function ctValidateUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '请填写 URL 模板';
  // 模板里的占位符不影响协议判断，先做协议白名单
  if (!/^https?:\/\//i.test(u)) return 'URL 必须以 http:// 或 https:// 开头';
  if (/^javascript:/i.test(u) || /^data:/i.test(u)) return 'URL 协议不被允许';
  // 剥掉占位符后应能被 URL 解析，避免拼出畸形地址
  try { new URL(u.replace(/\{\{\s*[\w-]+\s*\}\}/g, 'x')); }
  catch (e) { return 'URL 模板格式无效: ' + e.message; }
  return null;
}

/* ── 占位符替换（纯函数，可单测）──
   encode=true 用于 URL：值一律 encodeURIComponent，
   `&`、`?`、`#`、`/`、空格都会被转义，参数值无法改变 URL 结构。
   encode=false 用于 JSON 请求体：走 JSON 字符串转义后去掉外层引号，
   防止值里的引号/反斜杠破坏 JSON。 */
function ctFillTemplate(template, args, encode) {
  return String(template == null ? '' : template).replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key) => {
    const raw = args && args[key] != null ? String(args[key]) : '';
    if (encode) return encodeURIComponent(raw);
    return JSON.stringify(raw).slice(1, -1);
  });
}

function ctBuildUrl(tool, args) {
  const url = ctFillTemplate(tool.url, args, true);
  const err = ctValidateUrl(url);
  if (err) throw new Error(err);
  // 二次确认：替换后仍必须是 http/https，且 origin 与模板一致（防 host 被顶掉）
  const filled = new URL(url);
  if (filled.protocol !== 'http:' && filled.protocol !== 'https:') throw new Error('URL 协议不被允许');
  const tplHost = new URL(String(tool.url).replace(/\{\{\s*[\w-]+\s*\}\}/g, 'x')).host;
  if (filled.host !== tplHost) throw new Error(`URL 主机被参数改写（模板 ${tplHost} → 实际 ${filled.host}），已拦截`);
  return url;
}

/* ── 响应提取路径（纯函数，可单测）──
   段类型：普通字段名 / 数字下标 / `[]` 展开数组 / `*` 展开对象 values。
   `[]` 与 `*` 之后的取值会对每个元素分别执行，结果始终摊平成一维数组。
   路径找不到时返回空数组，不抛错（接口结构变了也不能让工具整体挂掉）。 */
function ctExtractPath(data, path) {
  const p = String(path == null ? '' : path).trim();
  if (!p) return data === undefined ? [] : [data];
  const segs = ctParsePath(p);
  let cur = [data];
  for (const seg of segs) {
    const next = [];
    for (const v of cur) {
      if (v === undefined || v === null) continue;
      if (seg.expandArray) {
        if (Array.isArray(v)) for (const x of v) next.push(x);
        continue;
      }
      if (seg.expandObject) {
        if (typeof v === 'object') for (const x of Object.values(v)) next.push(x);
        continue;
      }
      if (typeof v !== 'object') continue;
      const got = v[seg.key];
      if (got !== undefined) next.push(got);
    }
    cur = next;
    if (!cur.length) return [];
  }
  return cur;
}

// 把 'a[].b.*.c.0' 拆成段列表
function ctParsePath(path) {
  const segs = [];
  for (const rawPart of String(path).split('.')) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part === '*') { segs.push({ expandObject: true }); continue; }
    if (part === '[]') { segs.push({ expandArray: true }); continue; }
    // 支持 `name[]` 简写：先取字段再展开
    const m = /^(.*?)(\[\])+$/.exec(part);
    if (m) {
      if (m[1]) segs.push({ key: m[1] });
      const depth = (part.match(/\[\]/g) || []).length;
      for (let i = 0; i < depth; i++) segs.push({ expandArray: true });
      continue;
    }
    segs.push({ key: part });
  }
  return segs;
}

/* 按多行提取规则把响应转成给模型看的文本。
   每行格式 `标题|路径` 或纯 `路径`；全部留空则序列化整份 JSON。 */
function ctApplyExtract(data, extract) {
  const lines = String(extract || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) {
    const s = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return s.length > CT_MAX_RESULT_CHARS ? s.slice(0, CT_MAX_RESULT_CHARS) + '\n[...响应已截断]' : s;
  }
  const cols = lines.map(line => {
    const i = line.indexOf('|');
    const label = i > 0 ? line.slice(0, i).trim() : '';
    const path = i > 0 ? line.slice(i + 1).trim() : line;
    return { label: label || path, values: ctExtractPath(data, path) };
  });
  const rows = Math.max(0, ...cols.map(c => c.values.length));
  if (!rows) return '[未从响应中提取到任何字段，请检查提取路径是否匹配接口结构]';
  const out = [];
  for (let r = 0; r < rows; r++) {
    const parts = [];
    for (const c of cols) {
      if (r >= c.values.length) continue;
      const v = c.values[r];
      const text = (v === null || v === undefined) ? ''
        : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      if (text !== '') parts.push(`${c.label}: ${text}`);
    }
    if (parts.length) out.push(`${rows > 1 ? (r + 1) + '. ' : ''}${parts.join('\n   ')}`);
  }
  const s = out.join('\n');
  return s.length > CT_MAX_RESULT_CHARS ? s.slice(0, CT_MAX_RESULT_CHARS) + '\n[...结果已截断]' : s;
}

/* ── 生成 OpenAI 规范的 tool schema ──
   合入 getToolDefinitions()；无启用工具时返回空数组。 */
function ctGetToolDefinitions() {
  const out = [];
  for (const t of CT_TOOLS) {
    if (!t.enabled) continue;
    if (!CT_NAME_RE.test(t.name)) continue;
    const props = {};
    const required = [];
    for (const p of t.params) {
      props[p.name] = { type: 'string', description: p.description || p.name };
      if (p.required) required.push(p.name);
    }
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: (t.description || t.name) + ' (user-defined HTTP tool)',
        parameters: { type: 'object', properties: props, required },
      },
    });
  }
  return out;
}

/* ── 执行自定义工具 ──
   走 fetchViaProxy（search.js）解决 CORS；返回给模型的字符串。 */
async function ctExecute(tool, args, signal) {
  if (!tool) return '[自定义工具不存在]';
  let url;
  try { url = ctBuildUrl(tool, args); }
  catch (e) { return `[自定义工具 ${tool.name} URL 构造失败: ${e.message}]`; }

  let text;
  try {
    if (tool.method === 'POST' || Object.keys(tool.headers || {}).length) {
      // 需要自定义方法/头时只能直连（CORS 代理普遍只支持 GET 且会丢 header）
      const body = tool.method === 'POST' ? ctFillTemplate(tool.bodyTemplate || '{}', args, false) : undefined;
      const resp = await fetch(url, {
        method: tool.method,
        headers: Object.assign(
          tool.method === 'POST' ? { 'Content-Type': 'application/json' } : {},
          tool.headers || {}),
        body,
        signal,
      });
      if (!resp.ok) return `[自定义工具 ${tool.name} 请求失败: HTTP ${resp.status}]`;
      text = await resp.text();
    } else {
      text = await fetchViaProxy(url, CT_TIMEOUT_MS, signal);
    }
  } catch (e) {
    return `[自定义工具 ${tool.name} 请求异常: ${e.message}]`;
  }

  let data;
  try { data = JSON.parse(text); }
  catch (e) {
    // 非 JSON 响应（HTML/纯文本）直接回传截断后的原文
    const s = String(text || '');
    return `[${tool.name} 响应（非 JSON）]\n` + (s.length > CT_MAX_RESULT_CHARS ? s.slice(0, CT_MAX_RESULT_CHARS) + '\n[...已截断]' : s);
  }
  const argsDesc = Object.entries(args || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  return `[${tool.name} 结果${argsDesc ? ' (' + argsDesc + ')' : ''}]\n` + ctApplyExtract(data, tool.extract);
}

/* ── 内置开箱模板 ──
   Wikipedia / Hacker News 已有同名内置原生工具，故模板名加 my_ 前缀避免冲突。 */
const CT_TEMPLATES = [
  {
    key: 'wikipedia',
    label: '📖 Wikipedia 摘要',
    tool: {
      name: 'my_wikipedia_summary',
      description: 'Fetch the intro summary of an English Wikipedia article by exact title.',
      url: 'https://en.wikipedia.org/api/rest_v1/page/summary/{{query}}',
      method: 'GET', headers: {}, bodyTemplate: '',
      extract: '标题|title\n摘要|extract\n链接|content_urls.desktop.page',
      params: [{ name: 'query', description: 'Exact article title, e.g. Transformer_(machine_learning)', required: true }],
    },
  },
  {
    key: 'hackernews',
    label: '🟠 Hacker News 搜索',
    tool: {
      name: 'my_hn_search',
      description: 'Search Hacker News stories via the Algolia API; returns titles, points and URLs.',
      url: 'https://hn.algolia.com/api/v1/search?query={{query}}&tags=story&hitsPerPage=10',
      method: 'GET', headers: {}, bodyTemplate: '',
      extract: '标题|hits[].title\n热度|hits[].points\n评论|hits[].num_comments\n链接|hits[].url',
      params: [{ name: 'query', description: 'Search keywords', required: true }],
    },
  },
  {
    key: 'openweather',
    label: '🌤 OpenWeather 天气',
    tool: {
      name: 'get_weather',
      description: 'Get current weather for a city name. Returns condition, temperature and humidity.',
      url: 'https://api.openweathermap.org/data/2.5/weather?q={{query}}&units=metric&appid=YOUR_API_KEY',
      method: 'GET', headers: {}, bodyTemplate: '',
      extract: '城市|name\n天气|weather[].description\n温度|main.temp\n体感|main.feels_like\n湿度|main.humidity',
      params: [{ name: 'query', description: 'City name in English, e.g. Beijing', required: true }],
    },
  },
  {
    key: 'reddit',
    label: '👽 Reddit 搜索',
    tool: {
      name: 'search_reddit',
      description: 'Search Reddit posts; returns title, subreddit, score and permalink.',
      url: 'https://www.reddit.com/search.json?q={{query}}&limit=10&sort=relevance',
      method: 'GET', headers: {}, bodyTemplate: '',
      extract: '标题|data.children[].data.title\n版块|data.children[].data.subreddit\n热度|data.children[].data.score\n链接|data.children[].data.permalink',
      params: [{ name: 'query', description: 'Search keywords', required: true }],
    },
  },
];

// ── 提取路径语法说明（UI 内展示）──
function ctFormatDoc() {
  return `<code>a.b.c</code> 逐级取字段 · <code>a.0.b</code> 数组下标 ·
    <code>a[].b</code> 对数组每项取 b · <code>a.*.b</code> 对对象每个 value 取 b ·
    留空则回传整份 JSON。每行一条规则，可写 <code>标题|路径</code>。`;
}

// ── 管理模态框 ──
function showCustomToolsModal() {
  const isZh = STATE.lang !== 'en';
  const rows = CT_TOOLS.length ? CT_TOOLS.map(t => `
    <div class="ct-row">
      <label class="ct-row-toggle" title="${isZh ? '启用/禁用' : 'Enable/disable'}">
        <input type="checkbox" ${t.enabled ? 'checked' : ''} onchange="ctToggle('${t.id}')"></label>
      <div class="ct-row-main">
        <div class="ct-row-name">${escHtml(t.name)} <span class="ct-row-method">${t.method}</span></div>
        <div class="ct-row-desc">${escHtml(t.description)}</div>
        <div class="ct-row-url">${escHtml(t.url)}</div>
      </div>
      <div class="ct-row-ops">
        <button class="btn btn-ghost btn-sm" onclick="ctEditTool('${t.id}')">✎</button>
        <button class="btn btn-ghost btn-sm" onclick="ctDeleteTool('${t.id}')">🗑</button>
      </div>
    </div>`).join('')
    : `<div class="ct-empty">${isZh ? '还没有自定义工具。从下面的模板快速开始，或手动新建。' : 'No custom tools yet. Start from a template below or create one manually.'}</div>`;

  showModal(isZh ? '🔧 自定义 HTTP 工具' : '🔧 Custom HTTP Tools', `
    <div class="ct-wrap">
      <div class="ct-list">${rows}</div>
      <div class="ct-bar">
        <button class="btn btn-primary btn-sm" onclick="ctEditTool('')">＋ ${isZh ? '新建' : 'New'}</button>
        <button class="btn btn-ghost btn-sm" onclick="ctExportTools(false)">📤 ${isZh ? '导出(不含 headers)' : 'Export (no headers)'}</button>
        <button class="btn btn-ghost btn-sm" onclick="ctExportTools(true)">📤 ${isZh ? '导出(含密钥)' : 'Export (with secrets)'}</button>
        <button class="btn btn-ghost btn-sm" onclick="ctImportTools()">📥 ${isZh ? '导入' : 'Import'}</button>
      </div>
      <div class="ct-tpl-title">${isZh ? '内置模板' : 'Templates'}</div>
      <div class="ct-bar">${CT_TEMPLATES.map(tp =>
        `<button class="btn btn-ghost btn-sm" onclick="ctAddTemplate('${tp.key}')">${tp.label}</button>`).join('')}</div>
      <div class="ct-note">${isZh
        ? '⚠️ headers 里若填了 API Key，导出时请用「不含 headers」，避免密钥随 JSON 泄露。'
        : '⚠️ If headers contain API keys, use "Export (no headers)" to avoid leaking secrets.'}</div>
    </div>`);
}

function ctToggle(id) {
  const t = CT_TOOLS.find(x => x.id === id);
  if (!t) return;
  t.enabled = !t.enabled;
  ctSave();
  showCustomToolsModal();
}

function ctDeleteTool(id) {
  const t = CT_TOOLS.find(x => x.id === id);
  if (!t) return;
  if (!confirm((STATE.lang === 'en' ? 'Delete tool ' : '确定删除工具 ') + t.name + ' ?')) return;
  CT_TOOLS = CT_TOOLS.filter(x => x.id !== id);
  ctSave();
  showCustomToolsModal();
  toast((STATE.lang === 'en' ? 'Deleted ' : '已删除 ') + t.name, 'ok');
}

function ctAddTemplate(key) {
  const tpl = CT_TEMPLATES.find(t => t.key === key);
  if (!tpl) return;
  const draft = ctNormalize(Object.assign({}, tpl.tool, { id: uid() }));
  // 重名时自动加后缀，省得用户自己改
  let n = 2;
  const taken = new Set([...ctBuiltinNames(), ...CT_TOOLS.map(t => t.name)]);
  while (taken.has(draft.name)) draft.name = tpl.tool.name + '_' + (n++);
  ctEditTool('', draft);
}

// ── 新建/编辑表单 ──
function ctEditTool(id, preset) {
  const isZh = STATE.lang !== 'en';
  const t = preset || CT_TOOLS.find(x => x.id === id) || ctNormalize({});
  const p0 = t.params[0] || { name: 'query', description: '', required: true };
  const inp = 'width:100%;background:var(--input-bg);border:1px solid var(--border);border-radius:6px;'
    + 'padding:7px 10px;color:var(--text);font-size:.8rem;outline:none;font-family:var(--font)';
  showModal((id ? (isZh ? '✎ 编辑工具' : '✎ Edit Tool') : (isZh ? '＋ 新建工具' : '＋ New Tool')), `
    <div class="ct-form">
      <input type="hidden" id="ctfId" value="${escHtml(t.id)}">
      <label>${isZh ? '工具名' : 'Name'} <span class="ct-hint">^[a-zA-Z0-9_-]{1,64}$</span></label>
      <input id="ctfName" style="${inp}" value="${escHtml(t.name)}" placeholder="my_tool">
      <label>${isZh ? '描述（模型据此决定何时调用）' : 'Description (guides the model)'}</label>
      <textarea id="ctfDesc" rows="2" style="${inp}">${escHtml(t.description)}</textarea>
      <label>${isZh ? 'URL 模板（占位符 {{query}}）' : 'URL template (placeholder {{query}})'}</label>
      <input id="ctfUrl" style="${inp}" value="${escHtml(t.url)}" placeholder="https://api.example.com/s?q={{query}}">
      <div class="ct-form-grid">
        <div><label>${isZh ? '方法' : 'Method'}</label>
          <select id="ctfMethod" style="${inp}">
            <option value="GET" ${t.method === 'GET' ? 'selected' : ''}>GET</option>
            <option value="POST" ${t.method === 'POST' ? 'selected' : ''}>POST</option>
          </select></div>
        <div><label>${isZh ? '参数名' : 'Param name'}</label>
          <input id="ctfParam" style="${inp}" value="${escHtml(p0.name)}"></div>
      </div>
      <label>${isZh ? '参数说明' : 'Param description'}</label>
      <input id="ctfParamDesc" style="${inp}" value="${escHtml(p0.description)}">
      <label>Headers (JSON) <span class="ct-hint">${isZh ? '含 API Key 时导出请排除' : 'exclude on export if it holds a key'}</span></label>
      <textarea id="ctfHeaders" rows="2" style="${inp}" placeholder='{"Authorization":"Bearer xxx"}'>${escHtml(Object.keys(t.headers || {}).length ? JSON.stringify(t.headers) : '')}</textarea>
      <label>${isZh ? '请求体模板（POST，JSON）' : 'Body template (POST, JSON)'}</label>
      <textarea id="ctfBody" rows="2" style="${inp}" placeholder='{"q":"{{query}}"}'>${escHtml(t.bodyTemplate)}</textarea>
      <label>${isZh ? '响应提取路径（每行一条）' : 'Response extraction paths (one per line)'}</label>
      <textarea id="ctfExtract" rows="4" style="${inp}" placeholder="标题|hits[].title">${escHtml(t.extract)}</textarea>
      <div class="ct-note">${ctFormatDoc()}</div>
      <div class="ct-bar" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="ctSubmitTool()">${isZh ? '保存' : 'Save'}</button>
        <button class="btn btn-ghost btn-sm" onclick="showCustomToolsModal()">${isZh ? '返回' : 'Back'}</button>
      </div>
    </div>`);
}

function ctSubmitTool() {
  const val = id => ($(id) ? $(id).value : '');
  let headers = {};
  const hRaw = val('ctfHeaders').trim();
  if (hRaw) {
    const parsed = safeJson(hRaw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast(STATE.lang === 'en' ? 'Headers must be a JSON object' : 'Headers 必须是 JSON 对象', 'fail');
      return;
    }
    headers = parsed;
  }
  const draft = ctNormalize({
    id: val('ctfId') || uid(),
    name: val('ctfName'), description: val('ctfDesc'), url: val('ctfUrl'),
    method: val('ctfMethod'), headers, bodyTemplate: val('ctfBody'), extract: val('ctfExtract'),
    params: [{ name: val('ctfParam') || 'query', description: val('ctfParamDesc'), required: true }],
    enabled: true,
  });
  const err = ctValidate(draft, CT_TOOLS, ctBuiltinNames());
  if (err) { toast(err, 'fail'); return; }
  const i = CT_TOOLS.findIndex(x => x.id === draft.id);
  if (i === -1) CT_TOOLS.push(draft); else CT_TOOLS[i] = draft;
  ctSave();
  showCustomToolsModal();
  toast((STATE.lang === 'en' ? 'Saved ' : '已保存 ') + draft.name, 'ok');
}

// ── 导出 / 导入 ──
function ctExportTools(withSecrets) {
  if (!CT_TOOLS.length) { toast(STATE.lang === 'en' ? 'Nothing to export' : '没有可导出的工具', 'fail'); return; }
  const hasSecret = CT_TOOLS.some(t => Object.keys(t.headers || {}).length);
  if (withSecrets && hasSecret) {
    const warn = STATE.lang === 'en'
      ? 'The exported JSON will include header values, which may contain API keys. Continue?'
      : '导出的 JSON 会包含 headers 原文，其中可能有你的 API Key。确定继续？';
    if (!confirm(warn)) return;
  }
  const payload = {
    kind: 'eta-custom-tools', version: 1, exportedAt: new Date().toISOString(),
    headersIncluded: !!withSecrets,
    tools: CT_TOOLS.map(t => {
      const c = Object.assign({}, t);
      delete c.id;
      if (!withSecrets) delete c.headers;
      return c;
    }),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'eta-custom-tools.json';
  a.click();
  URL.revokeObjectURL(url);
  toast(withSecrets
    ? (STATE.lang === 'en' ? 'Exported (headers included)' : '已导出（含 headers，注意保密）')
    : (STATE.lang === 'en' ? 'Exported without headers' : '已导出（不含 headers）'), 'ok');
}

function ctImportTools() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const list = Array.isArray(payload) ? payload : (payload && payload.tools);
      if (!Array.isArray(list)) throw new Error(STATE.lang === 'en' ? 'Unrecognized file format' : '文件格式无法识别');
      const builtin = ctBuiltinNames();
      let added = 0;
      const skipped = [];
      for (const raw of list) {
        const t = ctNormalize(Object.assign({}, raw, { id: uid() }));
        // 导入的名字可能与内置/已有冲突，自动改名而不是整批失败
        let n = 2;
        const base = t.name;
        const taken = new Set([...builtin, ...CT_TOOLS.map(x => x.name)]);
        while (taken.has(t.name) && CT_NAME_RE.test(base)) t.name = base + '_' + (n++);
        const err = ctValidate(t, CT_TOOLS, builtin);
        if (err) { skipped.push(`${base}: ${err}`); continue; }
        CT_TOOLS.push(t);
        added++;
      }
      await ctSave();
      showCustomToolsModal();
      toast((STATE.lang === 'en' ? `Imported ${added} tool(s)` : `已导入 ${added} 个工具`)
        + (skipped.length ? (STATE.lang === 'en' ? `, ${skipped.length} skipped` : `，跳过 ${skipped.length} 个`) : ''), added ? 'ok' : 'fail');
      if (skipped.length) console.warn('[CustomTools] 导入跳过:', skipped);
      if (payload && payload.headersIncluded === false) {
        toast(STATE.lang === 'en'
          ? 'This file had headers stripped; re-enter API keys if needed.'
          : '该文件导出时排除了 headers，如需鉴权请手动补填 API Key。', 'info');
      }
    } catch (e) {
      toast((STATE.lang === 'en' ? 'Import failed: ' : '导入失败: ') + e.message, 'fail');
    }
  };
  input.click();
}

// 启动时加载（index.html 里本文件在 agent.js 之前，getToolDefinitions 首次调用前已就绪）
ctLoad();
