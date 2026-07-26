/* ============================================================
   ETA (Edge Thin Agent) — 第四期公共层：可配置参数 / 价目表 / 渲染钩子
   ------------------------------------------------------------
   为什么需要它：Agent 循环的轮数与各级超时原先硬编码在三个文件里，
   用户改不了；成本估算也需要一份可编辑的价目表。这里统一存放，
   用带前缀的 key 写进 storage.js 现有的 main store（不动 DB 版本号）。

   另外提供 etaAfterRender()：renderChat() 每次重绘会整体覆盖 innerHTML，
   第四期的时间线 / 竞技场卡片都要在重绘后补挂。这里用一次性猴补丁包住
   renderChat，避免每个模块各自去改 render.js。
   ============================================================ */

// ── 循环参数与开关默认值（UI 在设置模态框里改）──
const ETA_CFG_KEY = 'p4:config';
const ETA_CFG_DEFAULTS = {
  maxRounds: 20,          // doGenerate 最大工具轮数
  apiTimeout: 120000,     // 单次 chat/completions 无响应上限
  readTimeout: 90000,     // 流式读取两次 chunk 之间的上限
  perCmdTimeout: 30000,   // 单条普通工具（搜索/抓取）超时
  codeCmdTimeout: 180000, // 单条代码类工具超时（首次要下 ~10MB Pyodide）
  roundTimeout: 60000,    // 整轮工具兜底超时
  codeRoundTimeout: 200000, // 含代码工具时的整轮兜底超时
  planMode: false,        // 计划模式（正式回答前先产出 TODO）
  costShow: true,         // 消息与顶栏显示成本估算
  timelineShow: true,     // 消息内嵌步骤时间线
  arenaModels: [],        // 竞技场并发模型列表
  plannerEnabled: false,  // Planner/Executor 分工
  plannerModel: '',       // 贵模型：定计划
  executorModel: '',      // 便宜模型：跑工具循环
};

// 数值项的合法区间，防止用户填 0 或天文数字把循环卡死
const ETA_CFG_RANGE = {
  maxRounds: [1, 60], apiTimeout: [10000, 900000], readTimeout: [10000, 900000],
  perCmdTimeout: [3000, 600000], codeCmdTimeout: [5000, 900000],
  roundTimeout: [5000, 900000], codeRoundTimeout: [5000, 1200000],
};

let ETA_CFG = Object.assign({}, ETA_CFG_DEFAULTS);

// 同步读取：循环里要用，不能等 IndexedDB。未加载完成时拿到的就是默认值
function etaCfg(key) {
  const v = ETA_CFG[key];
  if (v === undefined || v === null || v === '') return ETA_CFG_DEFAULTS[key];
  const range = ETA_CFG_RANGE[key];
  if (range) {
    const n = Number(v);
    if (!Number.isFinite(n)) return ETA_CFG_DEFAULTS[key];
    return Math.min(range[1], Math.max(range[0], Math.round(n)));
  }
  return v;
}

function etaCfgSet(patch) {
  Object.assign(ETA_CFG, patch || {});
  return etaCfgSave();
}

async function etaCfgSave() {
  try { await idbSet(ETA_CFG_KEY, ETA_CFG); }
  catch (e) { console.warn('[ETA Cfg] 保存失败:', e); }
}

async function etaCfgLoad() {
  try {
    const saved = await idbGet(ETA_CFG_KEY);
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(ETA_CFG_DEFAULTS)) {
        if (saved[k] !== undefined) ETA_CFG[k] = saved[k];
      }
    }
  } catch (e) { console.warn('[ETA Cfg] 读取失败（用默认值）:', e); }
  return ETA_CFG;
}

function etaCfgReset() {
  ETA_CFG = Object.assign({}, ETA_CFG_DEFAULTS);
  return etaCfgSave();
}

/* ── 模型价目表 ──
   单位：USD / 1M tokens。match 为模型名的子串（小写比较），
   命中多条时取最长的那条，所以 'gpt-4o-mini' 会优先于 'gpt-4o'。 */
const ETA_PRICE_KEY = 'p4:pricing';
const ETA_PRICE_DEFAULTS = [
  { match: 'gpt-4o-mini', in: 0.15, out: 0.6 },
  { match: 'gpt-4o', in: 2.5, out: 10 },
  { match: 'gpt-4.1-mini', in: 0.4, out: 1.6 },
  { match: 'gpt-4.1', in: 2, out: 8 },
  { match: 'o3-mini', in: 1.1, out: 4.4 },
  { match: 'claude-3-5-haiku', in: 0.8, out: 4 },
  { match: 'claude-3-5-sonnet', in: 3, out: 15 },
  { match: 'claude-sonnet-4', in: 3, out: 15 },
  { match: 'claude-opus-4', in: 15, out: 75 },
  { match: 'claude-opus', in: 15, out: 75 },
  { match: 'deepseek-chat', in: 0.27, out: 1.1 },
  { match: 'deepseek-reasoner', in: 0.55, out: 2.19 },
  { match: 'gemini-2.5-flash', in: 0.3, out: 2.5 },
  { match: 'gemini-2.5-pro', in: 1.25, out: 10 },
  { match: 'qwen', in: 0.4, out: 1.2 },
  { match: 'glm-4', in: 0.6, out: 0.6 },
];

let ETA_PRICES = ETA_PRICE_DEFAULTS.map(p => Object.assign({}, p));

async function etaPriceLoad() {
  try {
    const saved = await idbGet(ETA_PRICE_KEY);
    if (Array.isArray(saved) && saved.length) ETA_PRICES = saved.map(etaPriceNormalize).filter(Boolean);
  } catch (e) { console.warn('[ETA Price] 读取失败（用默认表）:', e); }
  return ETA_PRICES;
}

async function etaPriceSave() {
  try { await idbSet(ETA_PRICE_KEY, ETA_PRICES); }
  catch (e) { console.warn('[ETA Price] 保存失败:', e); }
}

function etaPriceNormalize(row) {
  if (!row || typeof row !== 'object') return null;
  const match = String(row.match || '').trim().toLowerCase();
  if (!match) return null;
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
  return { match, in: num(row.in), out: num(row.out) };
}

function etaPriceList() { return ETA_PRICES; }

function etaPriceSetAll(rows) {
  ETA_PRICES = (rows || []).map(etaPriceNormalize).filter(Boolean);
  return etaPriceSave();
}

function etaPriceResetAll() {
  ETA_PRICES = ETA_PRICE_DEFAULTS.map(p => Object.assign({}, p));
  return etaPriceSave();
}

// 最长子串匹配；找不到返回 null（调用方据此显示"未配置价格"）
function etaPriceFor(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  let best = null;
  for (const row of ETA_PRICES) {
    if (!row || !row.match) continue;
    if (m.indexOf(row.match) === -1) continue;
    if (!best || row.match.length > best.match.length) best = row;
  }
  return best;
}

/* ── 成本估算 ──
   代理上报的 prompt_tokens 已知虚高（见 render.js 注释），因此 usd 只按
   completion_tokens 计算；输入侧单独给 usdIn，并在 UI 上明确标注不可信。 */
function etaCostOf(model, usage) {
  const price = etaPriceFor(model);
  const out = Math.max(0, (usage && usage.completion_tokens) || 0);
  const inp = Math.max(0, (usage && usage.prompt_tokens) || 0);
  if (!price) return { known: false, out, in: inp, usd: 0, usdIn: 0, model: model || '' };
  return {
    known: true, out, in: inp, model: model || '', price,
    usd: out * price.out / 1e6,
    usdIn: inp * price.in / 1e6,
  };
}

function etaFormatUsd(usd) {
  const n = Number(usd) || 0;
  if (n === 0) return '$0';
  if (n < 0.0001) return '<$0.0001';
  if (n < 1) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

// 汇总一条路径（当前活跃分支）的输出 token 与成本
function etaCostOfPath(path) {
  let out = 0, usd = 0, unpriced = 0;
  for (const node of path || []) {
    if (!node || !node.usage) continue;
    const c = etaCostOf(node.model, node.usage);
    out += c.out;
    if (c.known) usd += c.usd; else if (c.out) unpriced++;
  }
  return { out, usd, unpriced };
}

/* ── 渲染后钩子 ──
   renderChat() 会重建 #chatMessages 的 innerHTML，任何后挂的卡片都会被冲掉。
   这里包一层，重绘完成后按注册顺序回调，模块各自补挂自己的 DOM。 */
const _etaAfterRender = [];

function etaAfterRender(fn) {
  if (typeof fn === 'function') _etaAfterRender.push(fn);
}

function etaRunAfterRender() {
  for (const fn of _etaAfterRender) {
    try { fn(); } catch (e) { console.warn('[ETA] afterRender 回调出错:', e); }
  }
}

(function patchRenderChat() {
  if (typeof renderChat !== 'function' || renderChat.__etaPatched) return;
  const orig = renderChat;
  const wrapped = function () {
    const r = orig.apply(this, arguments);
    etaRunAfterRender();
    return r;
  };
  wrapped.__etaPatched = true;
  try { window.renderChat = wrapped; }
  catch (e) { console.warn('[ETA] 无法包装 renderChat，第四期卡片将不会自动补挂:', e); }
})();

// ── 顶栏成本显示（renderChat 会覆盖 topbarInfo 的文本，故在钩子里追加）──
etaAfterRender(function updateTopbarCost() {
  const el = $('topbarInfo');
  if (!el || !etaCfg('costShow')) return;
  const conv = getActiveConv();
  if (!conv) return;
  const { out, usd, unpriced } = etaCostOfPath(getActivePath(conv));
  if (!out) return;
  const isZh = STATE.lang !== 'en';
  const span = document.createElement('span');
  span.className = 'eta-cost-tag';
  span.textContent = ' · ~' + etaFormatUsd(usd);
  span.title = isZh
    ? `估算成本（仅按输出 token 计，共 ${out} tokens）。输入 token 因代理上报虚高不计入，仅供参考。`
      + (unpriced ? `\n有 ${unpriced} 条消息的模型未配置价格。` : '')
    : `Estimated cost from output tokens only (${out} tokens). Input tokens are excluded because the proxy over-reports them.`
      + (unpriced ? `\n${unpriced} message(s) use models with no price configured.` : '');
  el.appendChild(span);
});

/* ── 移动端抽屉 ──
   窄屏下 .sidebar / .ctx-panel 变成覆盖式抽屉（CSS 里的 @media 负责定位），
   这里只管遮罩层的显隐。桌面宽度不显示遮罩，行为与原先完全一致。 */
const ETA_MOBILE_MAX = 768;

function etaIsNarrow() {
  return typeof window !== 'undefined' && window.innerWidth <= ETA_MOBILE_MAX;
}

function syncDrawerScrim() {
  const scrim = $('drawerScrim');
  if (!scrim) return;
  const sidebarOpen = !!($('sidebar') && !$('sidebar').classList.contains('collapsed'));
  const ctxOpen = !!($('ctxPanel') && $('ctxPanel').classList.contains('open'));
  scrim.classList.toggle('show', etaIsNarrow() && (sidebarOpen || ctxOpen));
}

function closeDrawers() {
  const sb = $('sidebar');
  if (sb) sb.classList.add('collapsed');
  const cp = $('ctxPanel');
  if (cp) cp.classList.remove('open');
  const btn = $('ctxToggleBtn');
  if (btn) btn.style.color = '';
  syncDrawerScrim();
}

/* toggleSidebar / toggleCtxPanel 在 agent.js 与 context-buffer.js 里（都在避让区），
   所以包一层同步遮罩，而不是改它们。 */
(function patchDrawerToggles() {
  const wrap = name => {
    const fn = (typeof window !== 'undefined') ? window[name] : null;
    if (typeof fn !== 'function' || fn.__etaDrawer) return;
    const wrapped = function () { const r = fn.apply(this, arguments); syncDrawerScrim(); return r; };
    wrapped.__etaDrawer = true;
    try { window[name] = wrapped; } catch (e) {}
  };
  wrap('toggleSidebar');
  wrap('toggleCtxPanel');
})();

if (typeof window !== 'undefined') {
  window.addEventListener('resize', syncDrawerScrim);
  // 窄屏首次进入默认收起侧栏，否则一上来就被抽屉盖住聊天区
  if (etaIsNarrow()) {
    const sb = $('sidebar');
    if (sb) sb.classList.add('collapsed');
  }
}

// ── 启动加载（异步，不阻塞首屏；加载完成后重绘一次以显示成本）──
(async function etaConfigBoot() {
  await Promise.all([etaCfgLoad(), etaPriceLoad()]);
  if (typeof renderChat === 'function' && STATE && STATE.activeConvId) renderChat();
})();
