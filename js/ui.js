/* ============================================================
   ETA (Edge Thin Agent) — UI (Modal, Export, Settings, Balance, Model List)
   ============================================================ */

// ── 模型列表 ──
async function showModelListModal() {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.apiKey) { toast(STATE.lang === 'zh' ? '请先配置 Base URL 和 API Key' : 'Please configure Base URL and API Key first', 'fail'); return; }
  toast(STATE.lang === 'zh' ? '正在获取模型列表...' : 'Fetching model list...', 'info');
  try {
    const url = joinUrl(cfg.baseUrl, 'models');
    const resp = await fetch(url, { headers: headers(cfg.apiKey) });
    const data = await resp.json();
    const models = (data.data || []).map(m => m.id).sort();
    STATE.modelList = models;
    const select = $('modelSelect');
    const currentVal = select.value;
    select.innerHTML = models.map(m =>
      `<option value="${escHtml(m)}" ${m === currentVal ? 'selected' : ''}>${escHtml(m)}</option>`
    ).join('');
    if (!models.includes(currentVal) && models.length) select.value = models[0];
    showModal('📋 可用模型 (' + models.length + ')', `
      <div style="max-height:400px;overflow-y:auto">
        <input id="modelSearch" placeholder="搜索模型..." style="width:100%;margin-bottom:8px;background:var(--input-bg);
          border:1px solid var(--border);border-radius:6px;padding:8px;color:var(--text);outline:none"
          oninput="filterModelList(this.value)">
        <div id="modelListBody">${models.map(m =>
          `<div class="conv-item" onclick="selectModel('${escHtml(m)}')" style="cursor:pointer">${escHtml(m)}</div>`
        ).join('')}</div>
      </div>
    `);
    toast(`${STATE.lang === 'zh' ? '找到' : 'Found'} ${models.length} ${STATE.lang === 'zh' ? '个模型' : 'models'}`, 'ok');
  } catch (e) { toast((STATE.lang === 'zh' ? '获取模型列表失败: ' : 'Failed to fetch models: ') + e.message, 'fail'); }
}

function filterModelList(query) {
  const q = query.toLowerCase();
  const filtered = STATE.modelList.filter(m => m.toLowerCase().includes(q));
  $('modelListBody').innerHTML = filtered.map(m =>
    `<div class="conv-item" onclick="selectModel('${escHtml(m)}')" style="cursor:pointer">${escHtml(m)}</div>`
  ).join('');
}

function selectModel(model) {
  $('modelSelect').value = model;
  if (!Array.from($('modelSelect').options).some(o => o.value === model)) {
    const opt = document.createElement('option');
    opt.value = model; opt.textContent = model;
    $('modelSelect').appendChild(opt);
    $('modelSelect').value = model;
  }
  closeModal();
  saveConfig();
  toast((STATE.lang === 'zh' ? '已切换到 ' : 'Switched to ') + model, 'ok');
}

// ── 余额查询 ──
async function checkBalance() {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.apiKey) { toast(STATE.lang === 'zh' ? '请先配置' : 'Please configure first', 'fail'); return; }
  toast(STATE.lang === 'zh' ? '正在查询余额...' : 'Checking balance...', 'info');
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const bases = [base];
  if (base.endsWith('/v1')) bases.push(base.slice(0, -3).replace(/\/+$/, ''));
  const paths = ['/user/dashboard','/dashboard/billing/credit_grants','/dashboard/billing/subscription',
    '/billing/credit_grants','/billing/subscription','/balance'];
  for (const b of bases) {
    for (const p of paths) {
      try {
        const r = await fetch(b + p, { headers: headers(cfg.apiKey) });
        if (!r.ok) continue;
        const data = await r.json();
        const summary = extractBalanceSummary(data);
        if (summary.length) {
          showModal('💰 余额信息', `<div style="font-size:.9rem;line-height:2">${summary.map(s => `<div>${escHtml(s)}</div>`).join('')}</div>
            <details style="margin-top:12px"><summary style="cursor:pointer;color:var(--text3);font-size:.8rem">原始数据</summary>
            <pre style="background:var(--input-bg);padding:12px;border-radius:8px;font-size:.78rem;overflow:auto;max-height:300px;margin-top:8px">${escHtml(JSON.stringify(data, null, 2))}</pre></details>`);
          return;
        }
      } catch(e) {}
    }
  }
  toast(STATE.lang === 'zh' ? '未找到余额接口' : 'Balance endpoint not found', 'fail');
}

function extractBalanceSummary(data) {
  if (!data || typeof data !== 'object') return [];
  const pick = (paths) => {
    for (const p of paths) {
      let v = data;
      for (const k of p) { if (!v || typeof v !== 'object') { v = undefined; break; } v = v[k]; }
      if (typeof v === 'number') return v;
      if (typeof v === 'string') { const n = parseFloat(v.replace(/,/g,'')); if (!isNaN(n)) return n; }
    }
    return undefined;
  };
  let avail = pick([['credits'],['total_available'],['balance'],['available_balance'],['remaining']]);
  let total = pick([['credits_total_received'],['total_granted'],['hard_limit_usd'],['total']]);
  let used = pick([['credits_total_consumed'],['total_used'],['used'],['spent']]);
  if (total === undefined && avail !== undefined && used !== undefined) total = avail + used;
  if (used === undefined && total !== undefined && avail !== undefined) used = total - avail;
  const s = [];
  if (avail !== undefined) s.push('💰 可用余额: $' + avail.toFixed(4));
  if (total !== undefined) s.push('📊 总额度: $' + total.toFixed(4));
  if (used !== undefined) s.push('📈 已使用: $' + used.toFixed(4));
  return s;
}

// ── SerpAPI 用量查询（新标签页打开 JSON）──
function checkSerpApiUsage() {
  const key = $('cfgSerpApiKey').value.trim();
  if (!key) { toast('请先填写 SerpAPI Key', 'fail'); return; }
  window.open(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`, '_blank');
}

// ── Brave Search 用量查询（打开 Dashboard）──
function checkBraveUsage() {
  const key = $('cfgBraveKey').value.trim();
  if (!key) { toast('请先填写 Brave Search Key', 'fail'); return; }
  window.open('https://api-dashboard.search.brave.com/app/subscriptions/usage-limits', '_blank');
}

// ── 搜索 Key 用量统一查询 ──
async function checkSearchKeyUsage() {
  const serpKey = $('cfgSerpApiKey').value.trim();
  const braveKey = $('cfgBraveKey').value.trim();
  if (!serpKey && !braveKey) {
    toast('请先配置 SerpAPI Key 或 Brave Search Key', 'fail');
    return;
  }

  let html = '';

  // SerpAPI
  if (serpKey) {
    html += '<div style="margin-bottom:16px">';
    html += '<div style="font-weight:600;font-size:.95rem;margin-bottom:8px">🔍 SerpAPI</div>';
    try {
      toast('正在查询 SerpAPI 用量...', 'info');
      const text = await fetchViaProxy(`https://serpapi.com/account.json?api_key=${encodeURIComponent(serpKey)}`, 15000);
      const d = JSON.parse(text);
      const used = d.this_month_usage || 0;
      const total = d.searches_per_month || 0;
      const left = d.plan_searches_left ?? d.total_searches_left ?? (total - used);
      const pct = total > 0 ? Math.round((used / total) * 100) : 0;
      const barColor = pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#22c55e';
      html += `<div style="font-size:.85rem;color:var(--text2);margin-bottom:6px">${escHtml(d.plan_name || 'Unknown Plan')} · ${escHtml(d.account_email || '')}</div>`;
      html += `<div style="background:var(--input-bg);border-radius:8px;height:20px;overflow:hidden;margin-bottom:6px">`;
      html += `<div style="height:100%;width:${pct}%;background:${barColor};border-radius:8px;transition:width .3s"></div></div>`;
      html += `<div style="display:flex;justify-content:space-between;font-size:.82rem;color:var(--text3)">`;
      html += `<span>已用 ${used} / ${total} 次 (${pct}%)</span><span>剩余 ${left} 次</span></div>`;
      html += `<div style="font-size:.78rem;color:var(--text3);margin-top:4px">⏱ 本小时: ${d.this_hour_searches ?? '?'} 次 · 上小时: ${d.last_hour_searches ?? '?'} 次 · 限制: ${d.account_rate_limit_per_hour ?? '?'}/h</div>`;
    } catch (e) {
      html += `<div style="color:var(--warn);font-size:.85rem">❌ 查询失败: ${escHtml(e.message)}</div>`;
      html += `<div style="font-size:.78rem;margin-top:4px"><a href="https://serpapi.com/account.json?api_key=${encodeURIComponent(serpKey)}" target="_blank" style="color:var(--accent)">在新标签页查看</a></div>`;
    }
    html += '</div>';
  }

  // Brave
  if (braveKey) {
    html += '<div>';
    html += '<div style="font-weight:600;font-size:.95rem;margin-bottom:8px">🦁 Brave Search</div>';
    try {
      toast('正在验证 Brave Key...', 'info');
      const result = await doBraveSearch('test', 1);
      if (result.error) {
        html += `<div style="color:var(--warn);font-size:.85rem">❌ Key 无效或已过期: ${escHtml(result.error)}</div>`;
      } else {
        html += `<div style="font-size:.85rem;color:#22c55e">✅ Key 有效，搜索功能正常</div>`;
      }
    } catch (e) {
      html += `<div style="color:var(--warn);font-size:.85rem">❌ 验证失败: ${escHtml(e.message)}</div>`;
    }
    html += `<div style="font-size:.78rem;color:var(--text3);margin-top:6px">Brave 不提供用量 API，详细用量请访问 <a href="https://api-dashboard.search.brave.com/app/subscriptions/usage-limits" target="_blank" style="color:var(--accent)">Brave Dashboard</a></div>`;
    html += '</div>';
  }

  if (!serpKey) html += '<div style="font-size:.82rem;color:var(--text3)">💡 SerpAPI Key 未配置</div>';
  if (!braveKey) html += '<div style="font-size:.82rem;color:var(--text3);margin-top:8px">💡 Brave Search Key 未配置</div>';

  showModal('🔍 搜索 Key 用量', html);
}

// ── 模态框 ──
function showModal(title, bodyHtml) {
  const existing = document.querySelector('.modal-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = e => { if (e.target === overlay) closeModal(); };
  overlay.innerHTML = `<div class="modal">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h3 style="margin:0">${title}</h3>
      <button class="icon-btn" onclick="closeModal()" style="font-size:1.2rem">✕</button>
    </div>
    <div>${bodyHtml}</div>
  </div>`;
  document.body.appendChild(overlay);
}

function closeModal() {
  const overlay = document.querySelector('.modal-overlay');
  if (overlay) overlay.remove();
}

// ── 导出对话 ──
function exportConversation() {
  const conv = getActiveConv();
  if (!conv) { toast(STATE.lang === 'zh' ? '没有活跃对话' : 'No active conversation', 'fail'); return; }
  const path = getActivePath(conv);
  let md = `# ${conv.title}\n\n`;
  for (const node of path) {
    const role = node.role === 'user' ? '👤 User' : '🤖 Assistant';
    md += `## ${role} (${node.time})\n\n${node.content}\n\n---\n\n`;
  }
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (conv.title || 'chat') + '.md';
  a.click();
  URL.revokeObjectURL(url);
  toast(STATE.lang === 'zh' ? '已导出对话' : 'Conversation exported', 'ok');
}

// ── 设置模态框 ──
function showSettingsModal() {
  const isDark = STATE.theme === 'dark';
  const isZh = STATE.lang === 'zh';
  showModal(t('settingsTitle'), `
    <div class="setting-row">
      <div>
        <div class="setting-label">${t('themeLabel')}</div>
      </div>
      <select class="setting-select" id="settingTheme" onchange="applyTheme(this.value)">
        <option value="dark" ${isDark ? 'selected' : ''}>${t('themeDark')}</option>
        <option value="light" ${!isDark ? 'selected' : ''}>${t('themeLight')}</option>
      </select>
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-label">${t('langLabel')}</div>
        <div class="setting-hint">${t('langHint')}</div>
      </div>
      <select class="setting-select" id="settingLang" onchange="applyLang(this.value);closeModal();showSettingsModal()">
        <option value="zh" ${isZh ? 'selected' : ''}>${t('langZh')}</option>
        <option value="en" ${!isZh ? 'selected' : ''}>${t('langEn')}</option>
      </select>
    </div>
    <div class="config-row" style="margin-top:14px">
      <label>${t('customModel')}</label>
      <div style="display:flex;gap:6px">
        <input id="customModel" placeholder="${t('customModelPlaceholder')}" style="flex:1;background:var(--input-bg);
          border:1px solid var(--border);border-radius:6px;padding:8px;color:var(--text);outline:none">
        <button class="btn btn-primary btn-sm" onclick="addCustomModel()">${t('addModel')}</button>
      </div>
    </div>
    <div class="config-row" style="margin-top:12px">
      <label>${t('quickActions')}</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
        <button class="btn btn-ghost btn-sm" onclick="clearAllConversations()">${t('clearAll')}</button>
        <button class="btn btn-ghost btn-sm" onclick="exportAllConversations()">${t('exportAll')}</button>
      </div>
    </div>
    <div style="margin-top:16px;font-size:.75rem;color:var(--text3);line-height:1.6">
      <div>${t('shortcutInfo')}</div>
      <div>${t('treeInfo')}</div>
      <div>${t('modelSwitchInfo')}</div>
    </div>
  `);
}

function addCustomModel() {
  const name = document.getElementById('customModel')?.value?.trim();
  if (!name) return;
  selectModel(name);
  closeModal();
}

function clearAllConversations() {
  if (!confirm(STATE.lang === 'zh' ? '确定清空所有对话？此操作不可撤销。' : 'Clear all conversations? This cannot be undone.')) return;
  STATE.conversations = {};
  STATE.activeConvId = null;
  saveState();
  renderConvList();
  renderChat();
  closeModal();
  toast(STATE.lang === 'zh' ? '已清空所有对话' : 'All conversations cleared', 'ok');
}

function exportAllConversations() {
  const data = JSON.stringify(STATE.conversations, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'eta-export.json';
  a.click();
  URL.revokeObjectURL(url);
  toast(STATE.lang === 'zh' ? '已导出全部对话' : 'All conversations exported', 'ok');
}
