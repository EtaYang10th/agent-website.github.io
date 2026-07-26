/* ============================================================
   ETA (Edge Thin Agent) — Agent 循环可视化（步骤时间线 / 计划模式 / 成本）
   ------------------------------------------------------------
   为什么需要它：doGenerate 的多轮工具循环对用户是黑盒，只有 console 能看。
   这里把每轮的工具调用名、参数摘要、耗时、结果大小、成败记进
   conv.tree[aiMsgId].timeline，随对话一起持久化，并在消息气泡里折叠展示。

   埋点是软依赖：agent-generate.js / agent-commands.js 里全部用
   typeof timelineXxx === 'function' 包住，本文件加载失败也不影响聊天。

   数据结构：
     timeline = {
       startedAt, endedAt,
       plan: { items:[{text, done}], raw } | null,
       rounds: [{ i, startedAt, endedAt, chars, note,
                  tools:[{ id, name, type, arg, startedAt, endedAt, ok, size, err }] }]
     }
   ============================================================ */

const TL_ARG_MAX = 90;   // 参数摘要截断长度
const TL_MAX_ROUNDS_KEPT = 60; // 防御：异常情况下不让 timeline 无限膨胀

// ── 按 msgId 找到节点（生成中一定在活跃对话，兜底再全库扫）──
function _tlNode(aiMsgId) {
  if (!aiMsgId || typeof STATE === 'undefined') return null;
  const active = STATE.conversations && STATE.conversations[STATE.activeConvId];
  if (active && active.tree && active.tree[aiMsgId]) return active.tree[aiMsgId];
  for (const conv of Object.values(STATE.conversations || {})) {
    if (conv && conv.tree && conv.tree[aiMsgId]) return conv.tree[aiMsgId];
  }
  return null;
}

function _tlGet(aiMsgId, create) {
  const node = _tlNode(aiMsgId);
  if (!node) return null;
  if (!node.timeline && create) node.timeline = { startedAt: Date.now(), endedAt: null, plan: null, rounds: [] };
  return node.timeline || null;
}

// 参数摘要：不同工具的主字段不同，取第一个有值的
function tlArgSummary(cmd) {
  if (!cmd) return '';
  const raw = cmd.query || cmd.url || cmd.id || cmd.code
    || (cmd.args ? Object.values(cmd.args).filter(v => typeof v === 'string')[0] : '') || '';
  const s = String(raw).replace(/\s+/g, ' ').trim();
  return s.length > TL_ARG_MAX ? s.slice(0, TL_ARG_MAX) + '…' : s;
}

// ── 埋点：一次生成开始 ──
function timelineStart(aiMsgId) {
  const tl = _tlGet(aiMsgId, true);
  if (!tl) return null;
  tl.startedAt = Date.now();
  tl.endedAt = null;
  tl.rounds = [];
  return tl;
}

// ── 埋点：一轮开始 ──
function timelineRoundStart(aiMsgId, roundIdx, note) {
  const tl = _tlGet(aiMsgId, true);
  if (!tl) return null;
  if (tl.rounds.length >= TL_MAX_ROUNDS_KEPT) return tl.rounds[tl.rounds.length - 1];
  const round = { i: roundIdx, startedAt: Date.now(), endedAt: null, chars: 0, note: note || '', tools: [] };
  tl.rounds.push(round);
  tlScheduleRefresh(aiMsgId);
  return round;
}

// ── 埋点：一轮结束（chars = 本轮模型输出字符数，note 记退出原因等）──
function timelineRoundEnd(aiMsgId, roundIdx, info) {
  const tl = _tlGet(aiMsgId, false);
  if (!tl) return;
  const round = tl.rounds.filter(r => r.i === roundIdx).pop() || tl.rounds[tl.rounds.length - 1];
  if (!round) return;
  round.endedAt = Date.now();
  if (info && info.chars !== undefined) round.chars = info.chars;
  if (info && info.note) round.note = info.note;
  tlScheduleRefresh(aiMsgId);
}

// ── 埋点：整次生成结束 ──
function timelineEnd(aiMsgId) {
  const tl = _tlGet(aiMsgId, false);
  if (!tl) return;
  tl.endedAt = Date.now();
  for (const r of tl.rounds) {
    if (!r.endedAt) r.endedAt = tl.endedAt;
    for (const t of r.tools) if (!t.endedAt) { t.endedAt = tl.endedAt; if (t.ok === undefined) t.ok = false; }
  }
  tlScheduleRefresh(aiMsgId);
}

/* ── 埋点：单条工具开始 / 结束 ──
   executeSingleCommand 拿不到 conv，只有 aiMsgId，所以这里靠 _tlNode 反查。
   返回的 handle 只是个字符串 id，调用方原样传回给 timelineToolEnd。 */
function timelineToolStart(aiMsgId, cmd, roundIdx) {
  const tl = _tlGet(aiMsgId, true);
  if (!tl) return null;
  let round = tl.rounds.filter(r => r.i === roundIdx).pop();
  if (!round) round = tl.rounds[tl.rounds.length - 1] || timelineRoundStart(aiMsgId, roundIdx || 0, '');
  if (!round) return null;
  const id = 't' + round.tools.length + '_' + Date.now().toString(36);
  round.tools.push({
    id, name: (cmd && cmd.toolName) || (cmd && cmd.type) || '?',
    type: (cmd && cmd.type) || '?', arg: tlArgSummary(cmd),
    startedAt: Date.now(), endedAt: null, ok: undefined, size: 0, err: '',
  });
  tlScheduleRefresh(aiMsgId);
  return id;
}

function timelineToolEnd(aiMsgId, handle, info) {
  const tl = _tlGet(aiMsgId, false);
  if (!tl || !handle) return;
  for (const r of tl.rounds) {
    const t = r.tools.find(x => x.id === handle);
    if (!t) continue;
    t.endedAt = Date.now();
    t.size = (info && info.size) || 0;
    t.err = (info && info.err) ? String(info.err).slice(0, 200) : '';
    // 工具结果以 '[' 开头是本项目约定的错误/空结果格式
    t.ok = info && info.ok !== undefined ? !!info.ok : !t.err;
    break;
  }
  tlScheduleRefresh(aiMsgId);
}

/* ── 计划模式：一次额外的非流式调用，要模型先产出 TODO JSON ──
   刻意不复用 doGenerate 的流式路径：计划只要结构化结果，
   非流式 + 低 max_tokens 更快也更省。失败时静默跳过，不阻断正式回答。 */
async function timelinePlan(aiMsgId, cfg, userText, force) {
  if (!force && !etaCfg('planMode')) return null;
  const tl = _tlGet(aiMsgId, true);
  if (!tl) return null;
  const isZh = STATE.lang !== 'en';
  const sys = isZh
    ? '你是任务规划器。把用户请求拆成 2-6 个可执行步骤，只输出 JSON：{"steps":["第一步","第二步"]}。不要输出解释、不要用 markdown 代码块。'
    : 'You are a task planner. Break the request into 2-6 actionable steps. Output ONLY JSON: {"steps":["step 1","step 2"]}. No prose, no markdown fences.';
  try {
    const resp = await fetch(joinUrl(cfg.baseUrl, 'chat/completions'), {
      method: 'POST', headers: headers(cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model, temperature: 0.2, max_tokens: 600, stream: false,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: String(userText || '').slice(0, 4000) }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const raw = data && data.choices && data.choices[0] && data.choices[0].message
      ? (data.choices[0].message.content || '') : '';
    const steps = tlParsePlanSteps(raw);
    if (!steps.length) throw new Error('计划为空');
    tl.plan = { items: steps.map(s => ({ text: s, done: false })), raw: String(raw).slice(0, 2000) };
    tlScheduleRefresh(aiMsgId);
    return tl.plan;
  } catch (e) {
    console.warn('[Timeline] 计划生成失败，跳过:', e.message);
    return null;
  }
}

// 模型常把 JSON 包在 ```json 里，或直接给条目列表，都要能吃下
function tlParsePlanSteps(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const tryJson = s => {
    const d = safeJson(s);
    if (!d) return null;
    const arr = Array.isArray(d) ? d : (Array.isArray(d.steps) ? d.steps : (Array.isArray(d.todo) ? d.todo : null));
    if (!arr) return null;
    return arr.map(x => (typeof x === 'string' ? x : (x && (x.text || x.step || x.title) || ''))).filter(Boolean);
  };
  let steps = tryJson(stripped);
  if (!steps) {
    // 退一步：从文本里抓第一个 {...} 片段
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) steps = tryJson(m[0]);
  }
  if (!steps) {
    // 再退一步：把 "1. xxx" / "- xxx" 形式的行当步骤
    steps = stripped.split('\n').map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter(l => l && l.length > 2 && !/^[{}[\]"]/.test(l));
  }
  return steps.slice(0, 8).map(s => String(s).slice(0, 160));
}

// 执行过程中按轮次推进勾选：第 n 轮结束就把第 n 项标记完成
function timelinePlanAdvance(aiMsgId, doneCount) {
  const tl = _tlGet(aiMsgId, false);
  if (!tl || !tl.plan) return;
  const items = tl.plan.items || [];
  const n = Math.min(items.length, Math.max(0, doneCount));
  for (let i = 0; i < items.length; i++) items[i].done = i < n;
  tlScheduleRefresh(aiMsgId);
}

function timelinePlanFinish(aiMsgId) {
  const tl = _tlGet(aiMsgId, false);
  if (!tl || !tl.plan) return;
  for (const it of tl.plan.items || []) it.done = true;
  tlScheduleRefresh(aiMsgId);
}

// 把计划作为提示注入正式请求，让回答顺着计划走
function timelinePlanPrompt(aiMsgId) {
  const tl = _tlGet(aiMsgId, false);
  if (!tl || !tl.plan || !(tl.plan.items || []).length) return '';
  const isZh = STATE.lang !== 'en';
  const list = tl.plan.items.map((it, i) => `${i + 1}. ${it.text}`).join('\n');
  return isZh
    ? `\n\n[执行计划] 你已为本次任务制定如下步骤，请按此推进并在最终回答中覆盖全部步骤：\n${list}`
    : `\n\n[Execution plan] Follow these steps and cover all of them in the final answer:\n${list}`;
}

// ── 展示辅助 ──
function tlFmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return n + 'ms';
  if (n < 60000) return (n / 1000).toFixed(1) + 's';
  return Math.floor(n / 60000) + 'm' + Math.round((n % 60000) / 1000) + 's';
}

function tlFmtSize(chars) {
  const n = Number(chars) || 0;
  if (n < 1000) return n + 'ch';
  return (n / 1000).toFixed(1) + 'k';
}

const TL_ICONS = {
  search: '🔍', fetch: '🌐', ctx_read: '📖', ctx_search: '🔎', ctx_delete: '🗑',
  run_python: '🐍', run_js: '🟨', custom_tool: '🔧',
};
function tlIcon(type) {
  if (TL_ICONS[type]) return TL_ICONS[type];
  if (String(type).startsWith('search')) return '🔍';
  return '⚙';
}

// 时间线折叠状态：按 msgId 记住，重绘后保持用户展开的状态
const _tlOpen = {};

function timelineToggle(msgId) {
  _tlOpen[msgId] = !_tlOpen[msgId];
  const el = document.getElementById('tl-' + msgId);
  if (el) el.classList.toggle('open', !!_tlOpen[msgId]);
}

// ── 渲染整条时间线（返回 HTML 字符串）──
function timelineRenderHtml(msgId, tl, node) {
  if (!tl) return '';
  const isZh = STATE.lang !== 'en';
  const rounds = tl.rounds || [];
  const toolCount = rounds.reduce((s, r) => s + r.tools.length, 0);
  const failCount = rounds.reduce((s, r) => s + r.tools.filter(t => t.ok === false).length, 0);
  const plan = tl.plan;
  if (!rounds.length && !plan) return '';
  const dur = (tl.endedAt || Date.now()) - (tl.startedAt || Date.now());
  const running = !tl.endedAt;
  const open = !!_tlOpen[msgId];

  let head = `<span class="tl-ico">${running ? '⏳' : '🧭'}</span>`
    + `<span class="tl-title">${isZh ? 'Agent 步骤' : 'Agent steps'}</span>`
    + `<span class="tl-sum">${rounds.length} ${isZh ? '轮' : 'rounds'} · ${toolCount} ${isZh ? '次工具' : 'tools'}`
    + (failCount ? ` · <span class="tl-bad">${failCount} ${isZh ? '失败' : 'failed'}</span>` : '')
    + ` · ${tlFmtMs(dur)}</span>`;
  head += timelineCostBadge(node);

  let body = '';
  if (plan && (plan.items || []).length) {
    body += `<div class="tl-plan"><div class="tl-plan-title">${isZh ? '📋 执行计划' : '📋 Plan'}</div>`
      + plan.items.map(it => `<div class="tl-plan-item${it.done ? ' done' : ''}">`
        + `<span class="tl-check">${it.done ? '☑' : '☐'}</span>${escHtml(it.text)}</div>`).join('')
      + `</div>`;
  }
  for (const r of rounds) {
    const rd = (r.endedAt || Date.now()) - r.startedAt;
    body += `<div class="tl-round"><div class="tl-round-head">`
      + `<span class="tl-round-no">${isZh ? '第' : 'R'} ${r.i + (isZh ? ' 轮' : '')}</span>`
      + `<span class="tl-round-meta">${tlFmtMs(rd)}`
      + (r.chars ? ` · ${isZh ? '输出' : 'out'} ${tlFmtSize(r.chars)}` : '')
      + (r.note ? ` · ${escHtml(r.note)}` : '') + `</span></div>`;
    for (const t of r.tools) {
      const td = (t.endedAt || Date.now()) - t.startedAt;
      const state = t.ok === undefined ? 'run' : (t.ok ? 'ok' : 'bad');
      const mark = state === 'run' ? '⋯' : (state === 'ok' ? '✓' : '✗');
      body += `<div class="tl-tool tl-${state}">`
        + `<span class="tl-tool-ico">${tlIcon(t.type)}</span>`
        + `<span class="tl-tool-name">${escHtml(t.name)}</span>`
        + (t.arg ? `<span class="tl-tool-arg" title="${escHtml(t.arg)}">${escHtml(t.arg)}</span>` : '')
        + `<span class="tl-tool-meta">${tlFmtMs(td)}${t.size ? ' · ' + tlFmtSize(t.size) : ''}</span>`
        + `<span class="tl-tool-mark">${mark}</span></div>`;
      if (t.err) body += `<div class="tl-tool-err">${escHtml(t.err)}</div>`;
    }
    body += `</div>`;
  }

  return `<div class="tl-box${open ? ' open' : ''}${running ? ' tl-running' : ''}" id="tl-${msgId}">`
    + `<div class="tl-head" data-tl-toggle="${msgId}">${head}<span class="tl-caret">▾</span></div>`
    + `<div class="tl-body">${body}</div></div>`;
}

// 成本徽标：只按输出 token 估算，标题里说明输入侧为何不计
function timelineCostBadge(node) {
  if (!etaCfg('costShow') || !node || !node.usage || !node.usage.completion_tokens) return '';
  const isZh = STATE.lang !== 'en';
  const c = etaCostOf(node.model, node.usage);
  if (!c.known) {
    return `<span class="tl-cost tl-cost-unknown" title="${isZh
      ? '该模型未配置价格，可在设置 → 模型价目表中添加' : 'No price configured for this model (Settings → Pricing)'}">${c.out} out</span>`;
  }
  const title = isZh
    ? `估算：输出 ${c.out} tokens × $${c.price.out}/1M = ${etaFormatUsd(c.usd)}\n`
      + `估算值，输入 token 因该代理上报虚高仅供参考（上报 ${c.in}，约 ${etaFormatUsd(c.usdIn)}）。`
    : `Estimate: ${c.out} out tokens × $${c.price.out}/1M = ${etaFormatUsd(c.usd)}\n`
      + `Estimate only; input tokens are over-reported by this proxy (${c.in}, ~${etaFormatUsd(c.usdIn)}).`;
  return `<span class="tl-cost" title="${escHtml(title)}">~${etaFormatUsd(c.usd)}</span>`;
}

/* ── 挂载：把时间线插到消息内容区最前面 ──
   renderChat 会整体重绘 innerHTML，所以走 etaAfterRender 钩子补挂；
   生成过程中另有 tlScheduleRefresh 做节流刷新。 */
function timelineMountAll() {
  if (!etaCfg('timelineShow')) return;
  const conv = getActiveConv();
  if (!conv) return;
  for (const node of getActivePath(conv)) {
    if (node.role !== 'assistant' || !node.timeline) continue;
    timelineMountOne(node.id, node);
  }
}

/* 刻意挂在 .msg-body 里（.msg-content 的兄弟位置）而不是 .msg-content 内部：
   流式生成时 agent-loop.js 每帧都会 contentEl.innerHTML = ...，
   放在里面会被反复冲掉导致闪烁。 */
function timelineMountOne(msgId, node) {
  const contentEl = document.getElementById('msg-content-' + msgId);
  if (!contentEl) return;
  const host = contentEl.parentElement || contentEl;
  const html = timelineRenderHtml(msgId, node.timeline, node);
  const existing = host.querySelector(':scope > .tl-box');
  if (!html) { if (existing) existing.remove(); return; }
  if (existing) {
    // 只换内部，避免每次刷新都把节点整体替换掉（会打断 CSS 过渡）
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const fresh = tmp.firstElementChild;
    existing.className = fresh.className;
    existing.innerHTML = fresh.innerHTML;
    return;
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const box = wrap.firstElementChild;
  if (box) host.insertBefore(box, contentEl);
}

// 生成过程中高频埋点，节流到每 250ms 刷一次
let _tlRefreshTimer = null;
let _tlRefreshIds = new Set();
function tlScheduleRefresh(msgId) {
  if (typeof document === 'undefined') return;
  if (msgId) _tlRefreshIds.add(msgId);
  if (_tlRefreshTimer) return;
  _tlRefreshTimer = setTimeout(() => {
    _tlRefreshTimer = null;
    const ids = Array.from(_tlRefreshIds);
    _tlRefreshIds = new Set();
    for (const id of ids) {
      const node = _tlNode(id);
      if (node && node.timeline && etaCfg('timelineShow')) timelineMountOne(id, node);
    }
  }, 250);
}

// 折叠交互用事件委托（消息区会被整体重绘，内联 onclick 会丢）
if (typeof document !== 'undefined') {
  document.addEventListener('click', e => {
    const head = e.target.closest && e.target.closest('[data-tl-toggle]');
    if (head) timelineToggle(head.getAttribute('data-tl-toggle'));
  });
}

if (typeof etaAfterRender === 'function') etaAfterRender(timelineMountAll);
