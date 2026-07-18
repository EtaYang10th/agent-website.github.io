/* ============================================================
   ETA (Edge Thin Agent) — Global State, Utils, Config Persistence
   ============================================================ */

// ── Marked + Highlight.js 配置 ──
marked.setOptions({
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  },
  breaks: true, gfm: true,
});

// ── 全局状态 ──
const STATE = {
  conversations: {},
  activeConvId: null,
  searchMode: true,
  toolChoice: 'auto', // 'auto'(模型自行决定) | 'required'(强制至少调一次工具) | 'none'(禁用工具)
  generating: false,
  abortCtrl: null,
  attachments: [],
  modelList: [],
  theme: 'dark',   // 'dark' | 'light'
  lang: 'zh',      // 'zh' | 'en'
};

// ── 工具函数 ──
const $ = id => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const escHtml = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
const now = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const safeJson = t => { try { return JSON.parse(t); } catch { return null; } };

function getConfig() {
  return {
    baseUrl: $('cfgBaseUrl').value.trim(),
    apiKey: $('cfgApiKey').value.trim(),
    model: $('modelSelect').value,
    system: $('cfgSystem').value.trim(),
    temperature: parseFloat($('cfgTemp').value) || 0.7,
    maxTokens: parseInt($('cfgMaxTok').value) || 4096,
  };
}

function joinUrl(base, path) { return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''); }
function headers(key) { return { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }; }

// ── Toast 通知 ──
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

// ── LocalStorage 持久化 ──
function saveState() {
  try {
    const data = { conversations: STATE.conversations, activeConvId: STATE.activeConvId };
    localStorage.setItem('ai-chat-studio', JSON.stringify(data));
  } catch(e) { /* quota exceeded, ignore */ }
}
function loadState() {
  try {
    const raw = localStorage.getItem('ai-chat-studio');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.conversations) STATE.conversations = data.conversations;
    if (data.activeConvId) STATE.activeConvId = data.activeConvId;
  } catch(e) { /* corrupt, ignore */ }
}
function saveConfig() {
  try {
    localStorage.setItem('ai-chat-cfg', JSON.stringify({
      baseUrl: $('cfgBaseUrl').value, apiKey: $('cfgApiKey').value,
      system: $('cfgSystem').value, temp: $('cfgTemp').value, maxTok: $('cfgMaxTok').value,
      model: $('modelSelect').value,
      searchEnabled: $('cfgSearchEnabled').checked,
      searchMode: STATE.searchMode,
      toolChoice: STATE.toolChoice,
      serpApiKey: $('cfgSerpApiKey').value,
      braveKey: $('cfgBraveKey').value,
      theme: STATE.theme,
      lang: STATE.lang,
    }));
  } catch(e) {}
}
function loadConfig() {
  const env = window.ENV || {};
  try {
    const raw = localStorage.getItem('ai-chat-cfg');
    const c = raw ? JSON.parse(raw) : {};
    // For each field: localStorage > env.js > empty
    $('cfgBaseUrl').value = c.baseUrl || env.BASE_URL || '';
    $('cfgApiKey').value = c.apiKey || env.API_KEY || '';
    if (c.system) $('cfgSystem').value = c.system;
    if (c.temp) $('cfgTemp').value = c.temp;
    if (c.maxTok) $('cfgMaxTok').value = c.maxTok;
    if (c.model) {
      const sel = $('modelSelect');
      // 确保 option 存在再设值（模型列表可能还没拉取到）
      if (!Array.from(sel.options).some(o => o.value === c.model)) {
        sel.innerHTML = `<option value="${c.model}">${c.model}</option>`;
      }
      sel.value = c.model;
    }
    if (c.searchEnabled !== undefined) $('cfgSearchEnabled').checked = c.searchEnabled;
    if (c.searchMode !== undefined) STATE.searchMode = c.searchMode;
    if (c.toolChoice !== undefined) STATE.toolChoice = c.toolChoice;
    if ($('cfgToolChoice')) $('cfgToolChoice').value = STATE.toolChoice || 'auto';
    $('cfgSerpApiKey').value = c.serpApiKey || env.SERP_API_KEY || '';
    $('cfgBraveKey').value = c.braveKey || env.BRAVE_SEARCH_KEY || '';
    if (c.theme) STATE.theme = c.theme;
    if (c.lang) STATE.lang = c.lang;
    applyTheme(STATE.theme);
    applyLang(STATE.lang);
  } catch(e) {}
}

// ── 主题切换 ──
function applyTheme(theme) {
  STATE.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  // Switch highlight.js theme
  const darkSheet = document.getElementById('hljs-theme');
  const lightSheet = document.getElementById('hljs-theme-light');
  if (darkSheet && lightSheet) {
    darkSheet.disabled = (theme === 'light');
    lightSheet.disabled = (theme === 'dark');
  }
  saveConfig();
}

// ── 语言切换 ──
function applyLang(lang) {
  STATE.lang = lang;
  document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
  applyI18n();
  saveConfig();
}

// ── i18n 翻译表 ──
const I18N = {
  zh: {
    newConv: '新对话', convList: '对话列表', baseUrl: 'Base URL', apiKey: 'API Key',
    systemPrompt: 'System Prompt', temperature: 'Temperature', maxTokens: 'Max Tokens',
    serpApiKey: 'SerpAPI Key', braveKey: 'Brave Search Key',
    enableSearch: '启用 Agent 联网能力（搜索+抓取网页）',
    toolChoiceLabel: '工具调用策略',
    modelList: '📋 模型列表', balance: '💰 余额',
    ctxBuffer: '📚 对话缓存区', debugLog: '🐛 调试日志',
    exportConv: '导出对话', settings: '设置',
    inputPlaceholder: '输入消息... (Ctrl+Enter 发送, 可拖拽/粘贴图片)',
    inputHint: 'Ctrl+Enter 发送 · 支持拖拽/粘贴图片和文件 · 点击历史消息可编辑重发',
    welcomeTitle: 'ETA',
    welcomeSub: 'Edge Thin Agent — 支持连续对话、图片上传、对话分支回退、模型随时切换、🔍 Agent 网页搜索<br>Ctrl+Enter 发送 · 拖拽/粘贴上传文件 · 点击消息可编辑重发',
    model: '模型:', toggleSidebar: '切换侧边栏',
    searchMode: '搜索模式', ctxFetch: '抓取', ctxUpload: '📎 上传', ctxClear: '🗑 清空',
    ctxUrlPlaceholder: '粘贴 URL 抓取...',
    debugClear: '清空', debugCopy: '复制',
    settingsTitle: '⚙ 设置', themeLabel: '界面主题', themeDark: '🌙 深色', themeLight: '☀️ 浅色',
    langLabel: '界面语言', langZh: '中文', langEn: 'English',
    langHint: '⚠ 语言偏好会影响 Agent 的回复语言',
    customModel: '自定义模型（手动输入）', customModelPlaceholder: '输入模型名称', addModel: '添加',
    quickActions: '快捷操作', clearAll: '🗑 清空所有对话', exportAll: '📦 导出全部',
    shortcutInfo: '⌨️ 快捷键: Ctrl+Enter 发送 · 拖拽/粘贴上传图片',
    treeInfo: '🌳 对话树: 点击消息的编辑按钮可创建分支，用 ◀▶ 切换分支',
    modelSwitchInfo: '🔄 模型切换: 随时在顶栏切换模型，不同消息可用不同模型',
  },
  en: {
    newConv: 'New Chat', convList: 'Conversations', baseUrl: 'Base URL', apiKey: 'API Key',
    systemPrompt: 'System Prompt', temperature: 'Temperature', maxTokens: 'Max Tokens',
    serpApiKey: 'SerpAPI Key', braveKey: 'Brave Search Key',
    enableSearch: 'Enable Agent web access (search + scrape)',
    toolChoiceLabel: 'Tool call policy',
    modelList: '📋 Models', balance: '💰 Balance',
    ctxBuffer: '📚 Context Buffer', debugLog: '🐛 Debug Log',
    exportConv: 'Export Chat', settings: 'Settings',
    inputPlaceholder: 'Type a message... (Ctrl+Enter to send, drag/paste images)',
    inputHint: 'Ctrl+Enter to send · Drag/paste images and files · Click messages to edit & resend',
    welcomeTitle: 'ETA',
    welcomeSub: 'Edge Thin Agent — Multi-turn chat, image upload, conversation branching, model switching, 🔍 Agent web search<br>Ctrl+Enter to send · Drag/paste files · Click messages to edit & resend',
    model: 'Model:', toggleSidebar: 'Toggle Sidebar',
    searchMode: 'Search Mode', ctxFetch: 'Fetch', ctxUpload: '📎 Upload', ctxClear: '🗑 Clear',
    ctxUrlPlaceholder: 'Paste URL to fetch...',
    debugClear: 'Clear', debugCopy: 'Copy',
    settingsTitle: '⚙ Settings', themeLabel: 'Theme', themeDark: '🌙 Dark', themeLight: '☀️ Light',
    langLabel: 'Language', langZh: '中文', langEn: 'English',
    langHint: '⚠ Language preference affects Agent response language',
    customModel: 'Custom Model (manual input)', customModelPlaceholder: 'Enter model name', addModel: 'Add',
    quickActions: 'Quick Actions', clearAll: '🗑 Clear All Chats', exportAll: '📦 Export All',
    shortcutInfo: '⌨️ Shortcuts: Ctrl+Enter to send · Drag/paste to upload images',
    treeInfo: '🌳 Tree: Click edit on messages to branch, use ◀▶ to switch',
    modelSwitchInfo: '🔄 Models: Switch models anytime in the top bar',
  },
};

function t(key) { return (I18N[STATE.lang] || I18N.zh)[key] || key; }

function applyI18n() {
  // Sidebar
  const sidebarTitle = document.querySelector('.sidebar-section-title');
  if (sidebarTitle) sidebarTitle.textContent = t('convList');
  const newBtn = document.querySelector('.sidebar-header .icon-btn');
  if (newBtn) newBtn.title = t('newConv');

  // Config labels
  const labels = {
    cfgBaseUrl: 'baseUrl', cfgApiKey: 'apiKey', cfgSystem: 'systemPrompt',
    cfgTemp: 'temperature', cfgMaxTok: 'maxTokens',
    cfgSerpApiKey: 'serpApiKey', cfgBraveKey: 'braveKey',
  };
  for (const [id, key] of Object.entries(labels)) {
    const el = $(id);
    if (el) { const lbl = el.closest('.config-row')?.querySelector('label'); if (lbl) lbl.textContent = t(key); }
  }

  // Search toggle label
  const searchLabel = document.querySelector('#cfgSearchEnabled + label');
  if (searchLabel) searchLabel.textContent = t('enableSearch');
  const toolChoiceLbl = $('toolChoiceLabel');
  if (toolChoiceLbl) toolChoiceLbl.textContent = t('toolChoiceLabel');
  const tcSel = $('cfgToolChoice');
  if (tcSel && tcSel.options.length >= 2) {
    tcSel.options[0].textContent = STATE.lang === 'zh' ? '自动（模型自行决定是否调用）' : 'Auto (model decides)';
    tcSel.options[1].textContent = STATE.lang === 'zh' ? '禁用工具（仅用已有知识回答）' : 'Disabled (use existing knowledge only)';
  }

  // Topbar
  const modelLabel = document.querySelector('.topbar-model span');
  if (modelLabel) modelLabel.textContent = t('model');
  const toggleBtn = document.querySelector('.topbar-toggle');
  if (toggleBtn) toggleBtn.title = t('toggleSidebar');

  // Topbar action buttons
  const ctxBtn = $('ctxToggleBtn'); if (ctxBtn) ctxBtn.title = t('ctxBuffer');
  const debugBtn = $('debugToggleBtn'); if (debugBtn) debugBtn.title = t('debugLog');
  const exportBtn = document.querySelector('.topbar-actions .icon-btn[onclick="exportConversation()"]');
  if (exportBtn) exportBtn.title = t('exportConv');
  const settingsBtn = document.querySelector('.topbar-actions .icon-btn[onclick="showSettingsModal()"]');
  if (settingsBtn) settingsBtn.title = t('settings');

  // Input area
  const userInput = $('userInput');
  if (userInput) userInput.placeholder = t('inputPlaceholder');
  const inputHint = document.querySelector('.input-hint');
  if (inputHint) { const ctxH = $('ctxHint'); inputHint.innerHTML = ''; if (ctxH) inputHint.appendChild(ctxH); inputHint.append(t('inputHint')); }

  // Welcome screen
  const wTitle = document.querySelector('.welcome-title');
  if (wTitle) wTitle.textContent = t('welcomeTitle');
  const wSub = document.querySelector('.welcome-sub');
  if (wSub) wSub.innerHTML = t('welcomeSub');

  // Context panel
  const ctxTitle = document.querySelector('.ctx-panel-title');
  if (ctxTitle) ctxTitle.textContent = t('ctxBuffer');
  const ctxUrlInput = $('ctxUrlInput');
  if (ctxUrlInput) ctxUrlInput.placeholder = t('ctxUrlPlaceholder');
  const ctxFetchBtn = document.querySelector('.ctx-url-input .btn');
  if (ctxFetchBtn) ctxFetchBtn.textContent = t('ctxFetch');
  const ctxBtns = document.querySelectorAll('.ctx-actions .btn');
  if (ctxBtns[0]) ctxBtns[0].textContent = t('ctxUpload');
  if (ctxBtns[1]) ctxBtns[1].textContent = t('ctxClear');

  // Debug panel
  const debugTitle = document.querySelector('.debug-panel-header span');
  if (debugTitle) debugTitle.textContent = t('debugLog');
  const debugBtns = document.querySelectorAll('.debug-panel-actions button');
  if (debugBtns[0]) debugBtns[0].textContent = t('debugClear');
  if (debugBtns[1]) debugBtns[1].textContent = t('debugCopy');

  // Sidebar buttons
  const sidebarBtns = document.querySelectorAll('.config-panel .btn-ghost');
  if (sidebarBtns[0]) sidebarBtns[0].innerHTML = t('modelList');
  if (sidebarBtns[1]) sidebarBtns[1].innerHTML = t('balance');
}
