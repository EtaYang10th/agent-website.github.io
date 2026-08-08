/* ============================================================
   ETA (Edge Thin Agent) — 第四期设置项（循环参数 / 价目表 / 模板 / Planner / PWA）
   ------------------------------------------------------------
   js/ui.js 的 showSettingsModal() 以追加方式调用 etaSettingsSectionHtml()，
   所以这里只负责产出一段 HTML 与其配套的读写函数，不改动原函数结构。
   ============================================================ */

// ── 设置模态框内追加的区块 ──
function etaSettingsSectionHtml() {
  if (typeof etaCfg !== 'function') return '';
  const isZh = STATE.lang !== 'en';
  const v = k => etaCfg(k);
  const num = (id, key, label) =>
    `<div><label>${label}</label><input type="number" id="${id}" value="${v(key)}"></div>`;
  const planner = (typeof mmRoleSummary === 'function') ? mmRoleSummary() : '';
  const pwaStat = (typeof pwaStatusText === 'function') ? pwaStatusText() : '';
  return `
    <div class="config-row" style="margin-top:14px">
      <label>${isZh ? 'Agent 循环参数' : 'Agent loop parameters'}</label>
      <div class="p4-grid">
        ${num('p4Rounds', 'maxRounds', isZh ? '最大工具轮数' : 'Max tool rounds')}
        ${num('p4ApiTo', 'apiTimeout', isZh ? 'API 超时 (ms)' : 'API timeout (ms)')}
        ${num('p4ReadTo', 'readTimeout', isZh ? '流式读取超时 (ms)' : 'Stream read timeout (ms)')}
        ${num('p4CmdTo', 'perCmdTimeout', isZh ? '单条工具超时 (ms)' : 'Per-tool timeout (ms)')}
        ${num('p4CodeTo', 'codeCmdTimeout', isZh ? '代码工具超时 (ms)' : 'Code tool timeout (ms)')}
        ${num('p4RoundTo', 'roundTimeout', isZh ? '整轮兜底超时 (ms)' : 'Round timeout (ms)')}
        ${num('p4CodeRoundTo', 'codeRoundTimeout', isZh ? '含代码整轮超时 (ms)' : 'Code round timeout (ms)')}
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="etaSettingsSave()">${isZh ? '保存参数' : 'Save'}</button>
        <button class="btn btn-ghost btn-sm" onclick="etaSettingsResetCfg()">${isZh ? '恢复默认' : 'Reset'}</button>
      </div>
      <div class="p4-note">${isZh
        ? '代码类工具（run_python / run_js）单独用更宽的超时，首次调用要下载约 10MB Pyodide。'
        : 'Code tools use the wider timeouts; the first run_python call downloads ~10MB of Pyodide.'}</div>
    </div>
    <div class="setting-row">
      <div><div class="setting-label">${isZh ? '步骤时间线' : 'Step timeline'}</div>
        <div class="setting-hint">${isZh ? '消息内嵌工具调用过程，可折叠' : 'Inline tool-call trace in each message'}</div></div>
      <input type="checkbox" id="p4Timeline" ${v('timelineShow') ? 'checked' : ''} onchange="etaSettingsToggle('timelineShow',this.checked)">
    </div>
    <div class="setting-row">
      <div><div class="setting-label">${isZh ? '计划模式' : 'Plan mode'}</div>
        <div class="setting-hint">${isZh ? '回答前先产出 TODO 列表并逐项勾选（多一次 LLM 调用）' : 'Produce a TODO list first (one extra LLM call)'}</div></div>
      <input type="checkbox" id="p4Plan" ${v('planMode') ? 'checked' : ''} onchange="etaSettingsToggle('planMode',this.checked)">
    </div>
    <div class="setting-row">
      <div><div class="setting-label">${isZh ? '成本估算' : 'Cost estimate'}</div>
        <div class="setting-hint">${isZh ? '按价目表估算，仅计输出 token（输入侧代理上报虚高）' : 'From the price table, output tokens only'}</div></div>
      <input type="checkbox" id="p4Cost" ${v('costShow') ? 'checked' : ''} onchange="etaSettingsToggle('costShow',this.checked)">
    </div>
    <div class="config-row" style="margin-top:12px">
      <label>${isZh ? '模型价目表 / Planner 分工 / 模板库' : 'Pricing / Planner / Templates'}</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
        <button class="btn btn-ghost btn-sm" onclick="showPricingModal()">💲 ${isZh ? '价目表' : 'Pricing'}</button>
        <button class="btn btn-ghost btn-sm" onclick="showPlannerModal()">🧩 ${isZh ? 'Planner/Executor' : 'Planner/Executor'}</button>
        <button class="btn btn-ghost btn-sm" onclick="showPromptLibraryModal()">📝 ${isZh ? '模板库' : 'Templates'}</button>
        <button class="btn btn-ghost btn-sm" onclick="showArenaModal()">⚔️ ${isZh ? '竞技场' : 'Arena'}</button>
      </div>
      <div class="p4-note">${isZh ? '分工当前: ' : 'Planner split: '}${escHtml(planner)}</div>
    </div>
    <div class="config-row" style="margin-top:12px">
      <label>${isZh ? '离线安装 (PWA)' : 'Offline install (PWA)'}</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
        <button class="btn btn-ghost btn-sm" id="pwaInstallBtn" onclick="pwaInstall()"
          style="${(typeof pwaCanInstall === 'function' && pwaCanInstall()) ? '' : 'display:none'}">⬇ ${isZh ? '安装到桌面' : 'Install'}</button>
        <button class="btn btn-ghost btn-sm" onclick="pwaClearCache()">🧹 ${isZh ? '清空离线缓存' : 'Clear cache'}</button>
      </div>
      <div class="p4-note">${isZh ? '状态: ' : 'Status: '}${escHtml(pwaStat)}${isZh
        ? '。本地文件用 stale-while-revalidate，CDN 库长期缓存，API 请求一律不缓存。'
        : '. Local files use stale-while-revalidate; CDN libs are cached; API calls are never cached.'}</div>
    </div>`;
}

function etaSettingsSave() {
  const get = id => ($(id) ? $(id).value : '');
  etaCfgSet({
    maxRounds: parseInt(get('p4Rounds'), 10),
    apiTimeout: parseInt(get('p4ApiTo'), 10),
    readTimeout: parseInt(get('p4ReadTo'), 10),
    perCmdTimeout: parseInt(get('p4CmdTo'), 10),
    codeCmdTimeout: parseInt(get('p4CodeTo'), 10),
    roundTimeout: parseInt(get('p4RoundTo'), 10),
    codeRoundTimeout: parseInt(get('p4CodeRoundTo'), 10),
  });
  const isZh = STATE.lang !== 'en';
  toast(isZh ? '循环参数已保存（超出范围的值已自动收敛）' : 'Loop parameters saved', 'ok');
  closeModal();
  showSettingsModal();
}

function etaSettingsResetCfg() {
  etaCfgReset();
  closeModal();
  showSettingsModal();
  toast(STATE.lang === 'en' ? 'Reset to defaults' : '已恢复默认参数', 'ok');
}

function etaSettingsToggle(key, val) {
  const patch = {};
  patch[key] = !!val;
  etaCfgSet(patch);
  if (typeof renderChat === 'function') renderChat();
}

/* ── 价目表编辑 ──
   一行一个模型名子串 + 输入/输出单价（USD / 1M tokens）。 */
function showPricingModal() {
  const isZh = STATE.lang !== 'en';
  const rows = etaPriceList().map((p, i) => `<tr>
      <td><input value="${escHtml(p.match)}" data-price-match="${i}"></td>
      <td><input type="number" step="0.01" min="0" value="${p.in}" data-price-in="${i}"></td>
      <td><input type="number" step="0.01" min="0" value="${p.out}" data-price-out="${i}"></td>
      <td><button class="btn btn-ghost btn-sm" onclick="pricingRemoveRow(${i})">🗑</button></td>
    </tr>`).join('');
  showModal(isZh ? '💲 模型价目表' : '💲 Model Pricing', `
    <div class="price-wrap">
      <table class="price-table">
        <thead><tr>
          <th>${isZh ? '模型名包含' : 'Model contains'}</th>
          <th>${isZh ? '输入 $/1M' : 'In $/1M'}</th>
          <th>${isZh ? '输出 $/1M' : 'Out $/1M'}</th><th></th>
        </tr></thead>
        <tbody id="pricingBody">${rows}</tbody>
      </table>
    </div>
    <div class="ct-bar">
      <button class="btn btn-primary btn-sm" onclick="pricingSave()">${isZh ? '保存' : 'Save'}</button>
      <button class="btn btn-ghost btn-sm" onclick="pricingAddRow()">＋ ${isZh ? '添加一行' : 'Add row'}</button>
      <button class="btn btn-ghost btn-sm" onclick="pricingReset()">↺ ${isZh ? '恢复默认表' : 'Reset table'}</button>
    </div>
    <div class="p4-note">${isZh
      ? '匹配规则：模型名（小写）包含该字符串即命中，命中多条时取最长的那条，所以 gpt-4o-mini 会优先于 gpt-4o。'
        + '<br>⚠️ 显示的成本是<b>估算值</b>：只按 completion_tokens 计算，输入 token 因该代理上报虚高不计入，仅供参考。'
      : 'Longest matching substring wins, so gpt-4o-mini beats gpt-4o.'
        + '<br>⚠️ Costs are <b>estimates</b> from completion_tokens only; input tokens are over-reported by this proxy.'}</div>`);
}

function pricingCollect() {
  const body = $('pricingBody');
  if (!body) return [];
  const out = [];
  for (const tr of body.querySelectorAll('tr')) {
    const m = tr.querySelector('[data-price-match]');
    const i = tr.querySelector('[data-price-in]');
    const o = tr.querySelector('[data-price-out]');
    if (!m || !String(m.value || '').trim()) continue;
    out.push({ match: m.value, in: i ? i.value : 0, out: o ? o.value : 0 });
  }
  return out;
}

async function pricingSave() {
  await etaPriceSetAll(pricingCollect());
  closeModal();
  if (typeof renderChat === 'function') renderChat();
  toast(STATE.lang === 'en' ? 'Pricing saved' : '价目表已保存', 'ok');
}

async function pricingAddRow() {
  await etaPriceSetAll(pricingCollect().concat([{ match: 'new-model', in: 0, out: 0 }]));
  showPricingModal();
}

async function pricingRemoveRow(idx) {
  const rows = pricingCollect();
  rows.splice(idx, 1);
  await etaPriceSetAll(rows);
  showPricingModal();
}

async function pricingReset() {
  await etaPriceResetAll();
  showPricingModal();
  toast(STATE.lang === 'en' ? 'Price table reset' : '已恢复默认价目表', 'ok');
}

// ── Planner / Executor 配置 ──
function showPlannerModal() {
  const isZh = STATE.lang !== 'en';
  const models = (STATE.modelList && STATE.modelList.length)
    ? STATE.modelList
    : Array.from($('modelSelect').options).map(o => o.value).filter(Boolean);
  const opts = (sel) => `<option value="">${isZh ? '（用顶栏当前模型）' : '(use current model)'}</option>`
    + models.map(m => `<option value="${escHtml(m)}" ${m === sel ? 'selected' : ''}>${escHtml(m)}</option>`).join('');
  showModal(isZh ? '🧩 Planner / Executor 分工' : '🧩 Planner / Executor', `
    <div class="ct-form">
      <div class="p4-note" style="margin-top:0">${isZh
        ? '贵模型只做一次计划调用（非流式、约几百 token），便宜模型跑多轮工具循环（token 消耗的大头）。计划会显示在消息的步骤时间线里。'
        : 'The expensive model plans once (non-streaming); the cheap model runs the tool loop. The plan shows up in the step timeline.'}</div>
      <label>${isZh ? 'Planner（定计划，贵模型）' : 'Planner (expensive)'}</label>
      <select id="p4Planner" class="p4-sel">${opts(etaCfg('plannerModel'))}</select>
      <label>${isZh ? 'Executor（跑工具循环，便宜模型）' : 'Executor (cheap)'}</label>
      <select id="p4Executor" class="p4-sel">${opts(etaCfg('executorModel'))}</select>
      <label style="display:flex;align-items:center;gap:8px;margin-top:10px">
        <input type="checkbox" id="p4PlannerOn" ${etaCfg('plannerEnabled') ? 'checked' : ''}>
        <span>${isZh ? '启用分工' : 'Enable split'}</span></label>
      <div class="ct-bar" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="plannerSave()">${isZh ? '保存' : 'Save'}</button>
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">${isZh ? '取消' : 'Cancel'}</button>
      </div>
    </div>`);
}

async function plannerSave() {
  const p = ($('p4Planner') || {}).value || '';
  const e = ($('p4Executor') || {}).value || '';
  const on = !!($('p4PlannerOn') && $('p4PlannerOn').checked);
  await mmSetRoles(p, e, on);
  closeModal();
  toast(STATE.lang === 'en' ? 'Planner settings saved' : '分工设置已保存', 'ok');
}
