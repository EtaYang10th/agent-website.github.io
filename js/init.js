/* ============================================================
   ETA (Edge Thin Agent) — Initialization & Event Listeners
   ============================================================ */

// ── 配置变更监听 ──
['cfgBaseUrl', 'cfgApiKey', 'cfgSystem', 'cfgTemp', 'cfgMaxTok'].forEach(id => {
  $(id)?.addEventListener('change', saveConfig);
});
$('modelSelect')?.addEventListener('change', saveConfig);
$('cfgSearchEnabled')?.addEventListener('change', saveConfig);

// ── 启动时自动获取并探测模型列表 ──
async function fetchModelsOnStart() {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.apiKey) return;
  const select = $('modelSelect');
  const savedModel = cfg.model;
  try {
    const url = joinUrl(cfg.baseUrl, 'models');
    const resp = await fetch(url, { headers: headers(cfg.apiKey) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const models = (data.data || []).map(m => m.id).sort();
    if (!models.length) throw new Error('empty');
    STATE.modelList = models;
    // 先填充完整列表让用户可以立即选择
    select.innerHTML = models.map(m =>
      `<option value="${escHtml(m)}">${escHtml(m)}</option>`
    ).join('');
    if (savedModel && models.includes(savedModel)) {
      select.value = savedModel;
    } else if (savedModel) {
      const opt = document.createElement('option');
      opt.value = savedModel; opt.textContent = savedModel;
      select.appendChild(opt);
      select.value = savedModel;
    }
    // 后台探测每个模型的可用性
    probeModelsInBackground(models, cfg);
  } catch(e) {
    console.warn('[Init] 获取模型列表失败:', e.message);
    const fallback = ['claude-sonnet-4-20250514','gpt-4o','gpt-4o-mini','claude-3-5-sonnet-20241022'];
    select.innerHTML = fallback.map(m =>
      `<option value="${escHtml(m)}">${escHtml(m)}</option>`
    ).join('');
    if (savedModel) {
      if (!fallback.includes(savedModel)) {
        const opt = document.createElement('option');
        opt.value = savedModel; opt.textContent = savedModel;
        select.prepend(opt);
      }
      select.value = savedModel;
    }
  }
}

// ── 后台并发探测模型可用性 ──
async function probeModelsInBackground(models, cfg) {
  const chatUrl = joinUrl(cfg.baseUrl, 'chat/completions');
  const CONCURRENCY = 20;
  const available = [];
  const select = $('modelSelect');
  const savedModel = cfg.model;
  let idx = 0;

  async function probeOne(modelId) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(chatUrl, {
        method: 'POST',
        headers: headers(cfg.apiKey),
        signal: ctrl.signal,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        }),
      });
      clearTimeout(timer);
      return resp.ok;
    } catch(e) {
      return false;
    }
  }

  async function worker() {
    while (idx < models.length) {
      const i = idx++;
      const ok = await probeOne(models[i]);
      if (ok) available.push(models[i]);
    }
  }

  // 并发探测
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, models.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // 探测完成，更新下拉框只保留可用模型
  if (available.length > 0) {
    available.sort();
    STATE.modelList = available;
    select.innerHTML = available.map(m =>
      `<option value="${escHtml(m)}">${escHtml(m)}</option>`
    ).join('');
    if (savedModel && available.includes(savedModel)) {
      select.value = savedModel;
    } else if (savedModel) {
      // 上次选的模型探测不可用，但仍保留让用户自己决定
      const opt = document.createElement('option');
      opt.value = savedModel; opt.textContent = savedModel + ' (未响应)';
      select.prepend(opt);
      select.value = savedModel;
    } else {
      select.value = available[0];
    }
    saveConfig();
    console.log(`[Probe] 探测完成: ${available.length}/${models.length} 个模型可用`);
  } else {
    console.warn('[Probe] 所有模型探测均失败，保留原始列表');
  }
}

// ── 初始化 ──
(function init() {
  loadConfig();
  loadState();
  applyTheme(STATE.theme);
  applyLang(STATE.lang);
  for (const conv of Object.values(STATE.conversations)) {
    if (!conv.contextBuffer) conv.contextBuffer = [];
  }
  renderConvList();
  renderChat();
  updateSendBtn();
  $('searchToggle').style.color = STATE.searchMode ? 'var(--accent2)' : 'var(--text3)';
  $('searchToggle').title = (STATE.lang === 'zh' ? '搜索模式: ' : 'Search Mode: ') + (STATE.searchMode ? (STATE.lang === 'zh' ? '开' : 'ON') : (STATE.lang === 'zh' ? '关' : 'OFF'));
  if (!STATE.activeConvId) renderChat();
  renderCtxBuffer();
  updateCtxBtnBadge();
  // 异步拉取模型列表，不阻塞页面渲染
  fetchModelsOnStart();
})();
