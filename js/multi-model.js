/* ============================================================
   ETA (Edge Thin Agent) — 多模型并行（竞技场 / Planner-Executor）
   ------------------------------------------------------------
   竞技场：同一问题并发发给 N 个模型，结果并排对比，选中一个继续对话。

   为什么用对话树承载：js/conversation.js 的树天然支持同一 parent 下多个
   兄弟节点（getSiblings / navBranch 已有 ◀▶ 切换）。因此 N 个候选回答
   直接作为同一 userMsgId 的 N 个 assistant 子节点，"选中"就是把
   conv.activeLeaf 指向它 —— 未选中的候选留在树里，随时用 ◀▶ 翻回来。
   不另造数据结构，导出/持久化/分支导航全部自动复用。

   并发隔离：STATE.abortCtrl / STATE.generating 是全局单例，竞技场不碰它们，
   改用独立的 controller 集合 _arenaCtrls。同时猴补丁 abortGeneration，
   让顶栏「停止生成」也能一并中断所有竞技场请求。
   ============================================================ */

// 本轮竞技场的运行态（同一时刻只允许一场，避免用户误开一堆并发请求）
let _arenaCtrls = [];
let _arenaRunning = false;
let _arenaSession = null; // { convId, userMsgId, cands:[{model, msgId, ok, err, chars}] }

function arenaIsRunning() { return _arenaRunning; }

function arenaAbortAll() {
  for (const c of _arenaCtrls) { try { c.abort(); } catch (e) {} }
  _arenaCtrls = [];
  _arenaRunning = false;
  arenaSyncStopBtn();
}

// 让全局「停止生成」连带中断竞技场（agent.js 的 abortGeneration 不可修改，改为包装）
(function patchAbort() {
  if (typeof abortGeneration !== 'function' || abortGeneration.__etaArenaPatched) return;
  const orig = abortGeneration;
  const wrapped = function () { arenaAbortAll(); return orig.apply(this, arguments); };
  wrapped.__etaArenaPatched = true;
  try { window.abortGeneration = wrapped; }
  catch (e) { console.warn('[Arena] 无法包装 abortGeneration:', e); }
})();

// 竞技场进行中也把发送键变成停止键（复用 updateSendBtn 的样式约定）
function arenaSyncStopBtn() {
  const btn = $('sendBtn');
  if (!btn) return;
  if (_arenaRunning) { btn.innerHTML = '⏹'; btn.classList.add('stop'); btn.title = '停止生成'; }
  else if (typeof updateSendBtn === 'function') updateSendBtn();
}

/* ── 单个候选的流式读取 ──
   刻意不复用 handleStreamResponseAgent：它绑定 STATE、会写 search status、
   并按 msg-content-<id> 直接改 DOM，而竞技场候选大多不在活跃分支上。
   这里只做最小的 SSE 解析，工具调用一律不启用（候选先比裸回答质量）。 */
async function arenaStreamOne(cfg, model, messages, ctrl, onDelta) {
  const resp = await fetch(joinUrl(cfg.baseUrl, 'chat/completions'), {
    method: 'POST', headers: headers(cfg.apiKey), signal: ctrl.signal,
    body: JSON.stringify({
      model, messages, temperature: cfg.temperature, max_tokens: cfg.maxTokens,
      stream: true, stream_options: { include_usage: true },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    const d = safeJson(t);
    throw new Error(`HTTP ${resp.status}: ${((d && d.error && d.error.message) || t || '').slice(0, 160)}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      const chunk = safeJson(payload);
      if (!chunk) continue;
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens || 0,
          completion_tokens: chunk.usage.completion_tokens || 0,
          total_tokens: chunk.usage.total_tokens || 0,
        };
      }
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      const piece = delta && typeof delta.content === 'string' ? delta.content : '';
      if (piece) { text += piece; onDelta(piece, text); }
    }
  }
  return { text, usage };
}

/* ── 跑一场竞技场 ──
   每个模型一个 assistant 兄弟节点挂在 userMsgId 下；
   activeLeaf 先指向第一个候选，用户点「继续用这个」再改指向。 */
async function arenaRun(models) {
  if (_arenaRunning) { toast(STATE.lang === 'en' ? 'Arena already running' : '竞技场正在运行中', 'fail'); return; }
  if (STATE.generating) { toast(STATE.lang === 'en' ? 'Wait for current generation' : '请等待当前生成结束', 'fail'); return; }
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.apiKey) { toast(STATE.lang === 'en' ? 'Configure Base URL and API Key first' : '请先配置 Base URL 和 API Key', 'fail'); return; }
  const list = (models || []).map(m => String(m || '').trim()).filter(Boolean);
  const uniq = Array.from(new Set(list));
  if (uniq.length < 2) { toast(STATE.lang === 'en' ? 'Pick at least 2 models' : '请至少选择 2 个模型', 'fail'); return; }

  const text = $('userInput').value.trim();
  let conv = getActiveConv();
  if (!conv) { newConversation(); conv = getActiveConv(); }
  let userMsgId;
  if (text) {
    userMsgId = addMessageToTree(conv, conv.activeLeaf, 'user', text, '', []);
    if (Object.keys(conv.tree).length <= 2) {
      conv.title = text.slice(0, 30) + (text.length > 30 ? '...' : '');
      renderConvList();
    }
    $('userInput').value = '';
    autoResize($('userInput'));
  } else {
    // 没有新输入时，就对当前最后一条用户消息重跑（等价于多模型「重新生成」）
    const path = getActivePath(conv);
    const lastUser = path.filter(n => n.role === 'user').pop();
    if (!lastUser) { toast(STATE.lang === 'en' ? 'Type a question first' : '请先输入问题', 'fail'); return; }
    userMsgId = lastUser.id;
  }

  const messages = buildApiMessages(conv, userMsgId);
  const cands = uniq.map(model => ({
    model,
    msgId: addMessageToTree(conv, userMsgId, 'assistant', '', model, []),
    ok: null, err: '', chars: 0, usage: null,
  }));
  // addMessageToTree 会把 activeLeaf 移到最后一个；统一先落在第一个候选上
  conv.activeLeaf = cands[0].msgId;
  _arenaSession = { convId: conv.id, userMsgId, cands };
  _arenaRunning = true;
  _arenaCtrls = [];
  arenaSyncStopBtn();
  saveState();
  renderChat();
  arenaMount();

  const tasks = cands.map(async cand => {
    const ctrl = new AbortController();
    _arenaCtrls.push(ctrl);
    const node = conv.tree[cand.msgId];
    try {
      const r = await arenaStreamOne(cfg, cand.model, messages, ctrl, (_piece, full) => {
        node.content = full;
        cand.chars = full.length;
        arenaScheduleRefresh();
      });
      node.content = r.text || '';
      node.usage = r.usage;
      cand.usage = r.usage;
      cand.chars = node.content.length;
      cand.ok = true;
    } catch (e) {
      cand.ok = false;
      cand.err = (e.name === 'AbortError') ? (STATE.lang === 'en' ? 'aborted' : '已中断') : (e.message || String(e));
      node.content = (node.content || '') + `\n\n⚠️ ${cand.err}`;
    } finally {
      arenaScheduleRefresh();
    }
  });

  await Promise.allSettled(tasks);
  _arenaRunning = false;
  _arenaCtrls = [];
  arenaSyncStopBtn();
  saveState();
  renderChat();
  arenaMount();
  const okCount = cands.filter(c => c.ok).length;
  toast(STATE.lang === 'en'
    ? `Arena done: ${okCount}/${cands.length} succeeded`
    : `竞技场完成：${okCount}/${cands.length} 个模型返回`, okCount ? 'ok' : 'fail');
}

/* ── 选中某个候选继续对话 ──
   只需把 activeLeaf 指向它：其余候选仍是兄弟节点，◀▶ 可随时翻回。 */
function arenaPick(msgId) {
  const conv = getActiveConv();
  if (!conv || !conv.tree[msgId]) return;
  conv.activeLeaf = msgId;
  _arenaSession = null;
  saveState();
  renderChat();
  toast(STATE.lang === 'en'
    ? 'Continuing with ' + (conv.tree[msgId].model || 'this answer')
    : '已选定 ' + (conv.tree[msgId].model || '该回答') + ' 继续对话', 'ok');
}

/* ── 并排对比面板 ──
   候选是兄弟节点，同一时刻聊天区只能显示其中一个（活跃路径），
   所以对比视图独立挂在活跃候选的气泡下方，用等宽列展示全部候选。 */
function arenaMount() {
  const s = _arenaSession;
  if (!s) return;
  const conv = getActiveConv();
  if (!conv || conv.id !== s.convId) return;
  const contentEl = document.getElementById('msg-content-' + (conv.activeLeaf || s.cands[0].msgId));
  if (!contentEl) return;
  // 挂在 .msg-content 之外：流式写入会每帧重置 .msg-content 的 innerHTML
  const host = contentEl.parentElement || contentEl;
  let box = host.querySelector(':scope > .arena-box');
  if (!box) {
    box = document.createElement('div');
    box.className = 'arena-box';
    const actions = host.querySelector(':scope > .msg-actions');
    if (actions) host.insertBefore(box, actions); else host.appendChild(box);
  }
  box.innerHTML = arenaRenderHtml(conv, s);
}

function arenaRenderHtml(conv, s) {
  const isZh = STATE.lang !== 'en';
  const cols = s.cands.map(c => {
    const node = conv.tree[c.msgId];
    const content = node ? (node.content || '') : '';
    const state = c.ok === null ? 'run' : (c.ok ? 'ok' : 'bad');
    const badge = state === 'run' ? (isZh ? '生成中' : 'running')
      : (state === 'ok' ? (isZh ? '完成' : 'done') : (isZh ? '失败' : 'failed'));
    const cost = (node && node.usage && typeof etaCostOf === 'function') ? etaCostOf(c.model, node.usage) : null;
    const costTag = (cost && cost.known && cost.usd)
      ? `<span class="arena-cost">~${etaFormatUsd(cost.usd)}</span>` : '';
    return `<div class="arena-col arena-${state}">
      <div class="arena-col-head">
        <span class="arena-model" title="${escAttr(c.model)}">${escHtml(c.model)}</span>
        <span class="arena-badge arena-badge-${state}">${badge}</span>
      </div>
      <div class="arena-meta">${content.length} ${isZh ? '字符' : 'chars'}${costTag}</div>
      <div class="arena-body">${escHtml(content.slice(0, 4000)) || '<span class="arena-wait">…</span>'}</div>
      <div class="arena-ops">
        <button class="btn btn-primary btn-sm" onclick="arenaPick('${c.msgId}')"
          ${state === 'run' ? 'disabled' : ''}>${isZh ? '✓ 用这个继续' : '✓ Continue with this'}</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="arena-head">⚔️ ${isZh ? '模型竞技场' : 'Model Arena'}
      <span class="arena-hint">${isZh
        ? '候选已作为同一提问下的分支保存，选定后其余分支仍可用 ◀▶ 翻看'
        : 'Candidates are stored as branches; use ◀▶ to revisit the others'}</span>
      <button class="btn btn-ghost btn-sm" onclick="arenaDismiss()">✕</button></div>
    <div class="arena-cols">${cols}</div>`;
}

function arenaDismiss() {
  _arenaSession = null;
  for (const box of document.querySelectorAll('.arena-box')) box.remove();
}

let _arenaRefreshTimer = null;
function arenaScheduleRefresh() {
  if (_arenaRefreshTimer) return;
  _arenaRefreshTimer = setTimeout(() => { _arenaRefreshTimer = null; arenaMount(); }, 300);
}

if (typeof etaAfterRender === 'function') etaAfterRender(arenaMount);

// ── 竞技场配置模态框 ──
function showArenaModal() {
  const isZh = STATE.lang !== 'en';
  const models = (STATE.modelList && STATE.modelList.length)
    ? STATE.modelList
    : Array.from($('modelSelect').options).map(o => o.value).filter(Boolean);
  const chosen = new Set(etaCfg('arenaModels') || []);
  if (!chosen.size && $('modelSelect').value) chosen.add($('modelSelect').value);
  const rows = models.map(m => `<label class="arena-pick-row">
    <input type="checkbox" value="${escHtml(m)}" ${chosen.has(m) ? 'checked' : ''}>
    <span>${escHtml(m)}</span></label>`).join('');
  showModal(isZh ? '⚔️ 模型竞技场' : '⚔️ Model Arena', `
    <div class="arena-cfg">
      <div class="arena-cfg-hint">${isZh
        ? '勾选 2 个以上模型，同一问题会并发发给它们，结果并排对比。候选作为对话分支保存，选定一个后其余仍可用 ◀▶ 翻看。竞技场模式下不启用工具调用。'
        : 'Pick 2+ models. The same question goes to all of them concurrently and answers are compared side by side. Candidates are stored as conversation branches. Tool calls are disabled in arena mode.'}</div>
      <input id="arenaFilter" class="arena-filter" placeholder="${isZh ? '筛选模型…' : 'Filter models…'}"
        oninput="arenaFilterRows(this.value)">
      <div class="arena-pick-list" id="arenaPickList">${rows
        || `<div class="arena-cfg-hint">${isZh ? '模型列表尚未加载' : 'Model list not loaded yet'}</div>`}</div>
      <div class="ct-bar" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="arenaStartFromModal()">${isZh ? '▶ 开始对比' : '▶ Run arena'}</button>
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">${isZh ? '取消' : 'Cancel'}</button>
      </div>
    </div>`);
}

function arenaFilterRows(q) {
  const needle = String(q || '').toLowerCase();
  const list = $('arenaPickList');
  if (!list) return;
  for (const row of list.querySelectorAll('.arena-pick-row')) {
    const v = (row.querySelector('input') || {}).value || '';
    row.style.display = v.toLowerCase().includes(needle) ? '' : 'none';
  }
}

function arenaStartFromModal() {
  const list = $('arenaPickList');
  if (!list) return;
  const picked = Array.from(list.querySelectorAll('input:checked')).map(i => i.value);
  if (picked.length < 2) { toast(STATE.lang === 'en' ? 'Pick at least 2 models' : '请至少选择 2 个模型', 'fail'); return; }
  etaCfgSet({ arenaModels: picked });
  closeModal();
  arenaRun(picked);
}

/* ── Planner / Executor 分工 ──
   贵模型只做一次非流式的计划调用，便宜模型跑多轮工具循环（token 消耗大头）。
   两个模型在设置里各自选择；任一为空则回退顶栏当前模型。
   doGenerate 调用 mmRoleModels(cfg) 拿到分工结果，不改动其它逻辑。 */
function mmPlannerEnabled() {
  return !!(typeof etaCfg === 'function' && etaCfg('plannerEnabled'));
}

function mmRoleModels(cfg) {
  const fallback = (cfg && cfg.model) || '';
  if (!mmPlannerEnabled()) return { planner: fallback, executor: fallback, active: false };
  const planner = String(etaCfg('plannerModel') || '').trim() || fallback;
  const executor = String(etaCfg('executorModel') || '').trim() || fallback;
  return { planner, executor, active: planner !== executor };
}

// 设置界面用：把两个角色模型写进配置
function mmSetRoles(planner, executor, enabled) {
  return etaCfgSet({
    plannerModel: String(planner || '').trim(),
    executorModel: String(executor || '').trim(),
    plannerEnabled: !!enabled,
  });
}

function mmRoleSummary() {
  const isZh = STATE.lang !== 'en';
  if (!mmPlannerEnabled()) return isZh ? '未启用' : 'Disabled';
  const p = etaCfg('plannerModel') || (isZh ? '（当前模型）' : '(current)');
  const e = etaCfg('executorModel') || (isZh ? '（当前模型）' : '(current)');
  return `${p} → ${e}`;
}
