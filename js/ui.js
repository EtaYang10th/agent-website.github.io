/* ============================================================
   ETA (Edge Thin Agent) — UI (Modal, Export, Settings, Balance, Model List)
   ============================================================ */

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
  // /user/dashboard 优先（reAPI 风格代理，含 credits / remaining_days）
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
          const note = (data.total_input_tokens && data.total_output_tokens && data.total_input_tokens > data.total_output_tokens * 100)
            ? `<div style="margin-top:10px;font-size:.75rem;color:var(--text3);line-height:1.6">ℹ️ 注：该代理上报的输入 token 统计存在已知虚高 bug（经实测不影响实际扣费），此处输入/累计 token 数字仅供参考。</div>`
            : '';
          showModal('💰 余额信息', `<div style="font-size:.9rem;line-height:2">${summary.map(s => `<div>${escHtml(s)}</div>`).join('')}</div>${note}
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
  if (avail !== undefined) s.push('💰 剩余额度: ' + avail.toFixed(2) + ' credits');
  if (total !== undefined) s.push('📊 累计获得: ' + total.toFixed(2) + ' credits');
  if (used !== undefined) s.push('📈 累计消费: ' + used.toFixed(2) + ' credits');
  // reAPI 风格：套餐信息
  if (typeof data.plan === 'string') s.push('🎫 套餐: ' + data.plan + (data.status ? ` (${data.status})` : ''));
  if (typeof data.remaining_days === 'number') s.push('⏳ 剩余天数: ' + data.remaining_days + ' 天');
  if (typeof data.total_requests === 'number') s.push('🔢 累计请求: ' + data.total_requests.toLocaleString() + ' 次');
  if (typeof data.total_output_tokens === 'number') s.push('📤 累计输出: ' + data.total_output_tokens.toLocaleString() + ' tokens');
  return s;
}

/* ── 搜索 Key 用量查询 ──
   Brave 没有用量接口，只能发一次探测搜索验证 Key 有效性，再给出 Dashboard 链接。
   探测走 doBraveSearch，即直连 + 请求头带 Key，不经任何第三方代理。 */
async function checkSearchKeyUsage() {
  const braveKey = $('cfgBraveKey').value.trim();
  if (!braveKey) {
    toast('请先配置 Brave Search Key', 'fail');
    return;
  }

  let html = '<div><div style="font-weight:600;font-size:.95rem;margin-bottom:8px">🦁 Brave Search</div>';
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
  html += `<div style="font-size:.78rem;color:var(--text3);margin-top:6px">Brave 不提供用量 API，详细用量请访问 <a href="https://api-dashboard.search.brave.com/app/subscriptions/usage-limits" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">Brave Dashboard</a></div></div>`;

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

function exportConversation() {
  const conv = getActiveConv();
  if (!conv) { toast(STATE.lang === 'zh' ? '没有活跃对话' : 'No active conversation', 'fail'); return; }
  const path = getActivePath(conv);
  let md = `# ${conv.title}\n\n`;
  for (const node of path) {
    const role = node.role === 'user' ? '👤 User' : '🤖 Assistant';
    md += `## ${role} (${node.time})\n\n${node.content}\n\n---\n\n`;
  }
  downloadBlob(md, (conv.title || 'chat') + '.md', 'text/markdown');
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
      <label>${isZh ? '个人信息与长期记忆' : 'Personal Info & Memory'}</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px">
        <button class="btn btn-ghost btn-sm" onclick="showProfileModal()">👤 ${isZh ? '个人信息' : 'Personal info'}</button>
        <button class="btn btn-ghost btn-sm" onclick="showMemoryModal()">🧠 ${isZh ? '长期记忆' : 'Memory'}</button>
        <span style="font-size:.72rem;color:var(--text3)">${(typeof memSettingsSummary === 'function') ? memSettingsSummary(isZh) : ''}</span>
      </div>
    </div>
    <div class="config-row" style="margin-top:12px">
      <label>${isZh ? '自定义 HTTP 工具' : 'Custom HTTP Tools'}</label>
      <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
        <button class="btn btn-ghost btn-sm" onclick="showCustomToolsModal()">🔧 ${isZh ? '管理工具' : 'Manage tools'}</button>
        <span style="font-size:.72rem;color:var(--text3)">${(typeof ctGetAll === 'function' ? ctGetAll().filter(x => x.enabled).length : 0)} ${isZh ? '个已启用' : 'enabled'}</span>
      </div>
    </div>
    <div class="config-row" style="margin-top:12px">
      <label>${t('quickActions')}</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
        <button class="btn btn-ghost btn-sm" onclick="clearAllConversations()">${t('clearAll')}</button>
        <button class="btn btn-ghost btn-sm" onclick="exportAllConversations()">${t('exportAll')}</button>
      </div>
    </div>
    ${(typeof etaSettingsSectionHtml === 'function') ? etaSettingsSectionHtml() : ''}
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
  if (typeof retrClearAllIndexes === 'function') retrClearAllIndexes();
  if (typeof storageClearAll === 'function') {
    storageClearAll().then(() => flushState()).catch(e => console.warn('[Storage] 清空失败:', e));
  } else {
    saveState();
  }
  renderConvList();
  renderChat();
  closeModal();
  toast(STATE.lang === 'zh' ? '已清空所有对话' : 'All conversations cleared', 'ok');
}

function exportAllConversations() {
  downloadJson(STATE.conversations, 'eta-export.json');
  toast(STATE.lang === 'zh' ? '已导出全部对话' : 'All conversations exported', 'ok');
}
