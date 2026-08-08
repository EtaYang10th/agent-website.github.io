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

/* ── 滚动到底 ──
   只在用户本来就贴着底部时才自动跟随。生成期间无条件置底会把主动上翻查看前文的
   用户每帧拽回去，等于锁死滚动条。阈值与 debug.js 的日志面板保持一致。 */
function scrollChatToBottom(force) {
  const el = $('chatArea');
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (force || atBottom) el.scrollTop = el.scrollHeight;
}

/* ── HTML 属性值转义 ──
   escHtml 走 textContent→innerHTML，按 HTML 序列化规范只转义 & < >，
   引号原样保留。放进 title="..." / href="..." 这类属性里时，取值一旦含双引号
   就能突破属性边界（搜索结果的 link/title、模型给的工具参数都是外部输入）。
   属性位置必须用这个函数。 */
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* 只允许安全协议的 URL 进 href。javascript: / data: 一律拦掉，
   相对链接与锚点保持原样放行。返回空串表示调用方应降级为纯文本。 */
function safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  // 去掉控制字符后再判协议，防 "java\tscript:" 这类绕过
  const probe = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').toLowerCase();
  if (/^(?:javascript|data|vbscript|file):/.test(probe)) return '';
  return s;
}

/* ── 文件下载 ──
   曾有四处各写一遍这段，且都犯同一个错：<a> 没插进文档，且 click() 后同步
   revokeObjectURL。下载在部分浏览器是异步取 blob 的，URL 已吊销会导致
   下载静默失败或存出 0 字节。这里统一走"插入 → 点击 → 移除 → 延迟吊销"。
   文件名同时做非法字符清洗，否则标题带 / 的对话导不出来。 */
function downloadBlob(content, filename, mime) {
  const blob = (content instanceof Blob) ? content : new Blob([content], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = String(filename || 'download').replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// 导出 JSON 的快捷方式（记忆 / 档案 / 自定义工具 / 全部对话都用它）
function downloadJson(obj, filename) {
  downloadBlob(JSON.stringify(obj, null, 2), filename, 'application/json');
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

/* ── 对话数据持久化（IndexedDB，见 js/storage.js） ──
   saveState() 保持同步签名不变（全项目 20+ 处同步调用），
   内部 debounce 600ms 后异步落盘；需要立即写入时用 flushState()。 */
const SAVE_DEBOUNCE_MS = 600;
let _saveTimer = null;
let _savePending = false;
let _saveInFlight = null;
let _saveErrorNotified = false;

function saveState() {
  _savePending = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; _doSaveState(); }, SAVE_DEBOUNCE_MS);
}

async function _doSaveState() {
  if (_saveInFlight) return _saveInFlight.then(() => { if (_savePending) return _doSaveState(); });
  if (!_savePending) return;
  _savePending = false;
  _saveInFlight = storageSaveChatState(STATE.conversations, STATE.activeConvId)
    .then(() => { _saveErrorNotified = false; })
    .catch(e => {
      console.error('[State] 保存失败:', e);
      // 不再静默：写不进去意味着用户会丢数据，必须告知
      if (!_saveErrorNotified) {
        _saveErrorNotified = true;
        const isQuota = /quota|exceed/i.test(e && (e.name + ' ' + e.message));
        toast(STATE.lang === 'en'
          ? ('Save failed: ' + (isQuota ? 'storage quota exceeded, please delete old chats' : (e.message || e.name)))
          : ('保存失败：' + (isQuota ? '存储空间已满，请删除旧对话' : (e.message || e.name))), 'fail');
      }
    })
    .finally(() => { _saveInFlight = null; });
  return _saveInFlight;
}

// 立即落盘（beforeunload / visibilitychange / 关键操作后调用）
function flushState() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _savePending = true;
  return _doSaveState();
}

async function loadState() {
  try {
    const r = await storageLoadChatState();
    STATE.conversations = r.conversations || {};
    STATE.activeConvId = r.activeConvId || null;
    if (r.migrated) toast(STATE.lang === 'en' ? 'Chat data migrated to IndexedDB' : '对话数据已迁移到 IndexedDB', 'ok');
    return r;
  } catch (e) {
    console.error('[State] 加载失败:', e);
    toast(STATE.lang === 'en' ? 'Failed to load chat data' : '对话数据加载失败', 'fail');
    return { conversations: {}, activeConvId: null };
  }
}

window.addEventListener('beforeunload', () => { if (_savePending || _saveTimer) flushState(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && (_savePending || _saveTimer)) flushState();
});
/* ── 侧栏配置面板折叠状态 ──
   四个 <details> 分组的展开状态存进 'ai-chat-cfg' 的 groups 字段（跟随 config 现状，
   不引入新的存储位置）。未配置 API 时强制展开「API 连接」，保证首次配置浮层能用。 */
const CFG_GROUP_IDS = ['grpApi', 'grpModel', 'grpAgent', 'grpSearch'];
const CFG_GROUP_DEFAULTS = { grpApi: true, grpModel: false, grpAgent: false, grpSearch: false };

/* 落盘的是"用户偏好"而不是当前 DOM 状态。两者会短暂不一致：未配置 API 时我们强制
   展开「API 连接」，但这属于引导行为，不该覆盖用户自己收起过的偏好。
   另外 <details> 的 toggle 事件是异步派发的，同步的 mute 标志盖不住，所以
   cfgApplyGroups 里的批量赋值靠 _cfgGroupsMuted + 一次 setTimeout 归零来兜住。 */
let _cfgGroupPrefs = Object.assign({}, CFG_GROUP_DEFAULTS);
let _cfgGroupsMuted = false;

function cfgGroupState() {
  return Object.assign({}, _cfgGroupPrefs);
}

function saveConfig() {
  try {
    localStorage.setItem('ai-chat-cfg', JSON.stringify({
      baseUrl: $('cfgBaseUrl').value, apiKey: $('cfgApiKey').value,
      system: $('cfgSystem').value, temp: $('cfgTemp').value, maxTok: $('cfgMaxTok').value,
      model: $('modelSelect').value,
      searchEnabled: $('cfgSearchEnabled').checked,
      codeEnabled: $('cfgCodeEnabled') ? $('cfgCodeEnabled').checked : false,
      searchMode: STATE.searchMode,
      toolChoice: STATE.toolChoice,
      braveKey: $('cfgBraveKey').value,
      theme: STATE.theme,
      lang: STATE.lang,
      groups: cfgGroupState(),
    }));
  } catch(e) {}
  cfgSyncGroupBadges();
}

// <details> 的 ontoggle 回调：把用户的展开/折叠动作记进偏好并落盘
function cfgGroupToggled(ev) {
  if (_cfgGroupsMuted) return;
  const el = ev && ev.target;
  if (el && CFG_GROUP_IDS.includes(el.id)) {
    _cfgGroupPrefs[el.id] = !!el.open;
  } else {
    // 没拿到事件对象时退化为全量同步，保证偏好不会与界面脱节
    for (const id of CFG_GROUP_IDS) {
      const g = $(id);
      if (g) _cfgGroupPrefs[id] = !!g.open;
    }
  }
  saveConfig();
}

/* 分组标题右侧的状态徽标：折叠后用户仍能一眼看出该组是否已配置/已开启。
   不改任何配置值，只读 DOM。 */
function cfgSyncGroupBadges() {
  const isZh = STATE.lang !== 'en';
  const set = (id, text, on) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('on', !!on);
  };
  const has = id => !!($(id) && $(id).value.trim());
  const apiOk = has('cfgBaseUrl') && has('cfgApiKey');
  set('grpApiBadge', apiOk ? (isZh ? '已配置' : 'set') : (isZh ? '未配置' : 'not set'), apiOk);

  const tp = $('cfgTemp'), mt = $('cfgMaxTok');
  const modelBadge = (tp && mt) ? ('T ' + (tp.value || '-') + ' · ' + (mt.value || '-')) : '';
  set('grpModelBadge', modelBadge, false);

  const caps = [];
  if ($('cfgSearchEnabled') && $('cfgSearchEnabled').checked) caps.push('🔍');
  if ($('cfgCodeEnabled') && $('cfgCodeEnabled').checked) caps.push('⚙');
  set('grpAgentBadge', caps.length ? caps.join(' ') : (isZh ? '关' : 'off'), caps.length > 0);

  const hasBrave = has('cfgBraveKey');
  set('grpSearchBadge', hasBrave ? (isZh ? '已配置' : 'set') : (isZh ? '无 Key' : 'no key'), hasBrave);
}

function loadConfig() {
  const env = window.ENV || {};
  let needResave = false;
  try {
    const raw = localStorage.getItem('ai-chat-cfg');
    const c = raw ? JSON.parse(raw) : {};
    // For each field: localStorage > env.js > empty
    $('cfgBaseUrl').value = c.baseUrl || env.BASE_URL || '';
    $('cfgApiKey').value = c.apiKey || env.API_KEY || '';
    if (c.system) $('cfgSystem').value = c.system;
    if (c.temp) $('cfgTemp').value = c.temp;
    if (c.maxTok) {
      // 一次性纠正历史遗留的超大 max_tokens（旧默认 200000 会让多数模型返回 400）
      const mt = parseInt(c.maxTok, 10);
      if (Number.isFinite(mt) && mt > 32768) {
        $('cfgMaxTok').value = 8192;
        c.maxTok = 8192;
        needResave = true;
      } else {
        $('cfgMaxTok').value = c.maxTok;
      }
    }
    if (c.model) {
      const sel = $('modelSelect');
      // 确保 option 存在再设值（模型列表可能还没拉取到）
      if (!Array.from(sel.options).some(o => o.value === c.model)) {
        sel.innerHTML = `<option value="${c.model}">${c.model}</option>`;
      }
      sel.value = c.model;
    }
    if (c.searchEnabled !== undefined) $('cfgSearchEnabled').checked = c.searchEnabled;
    // 代码执行默认关闭（首次调用要下载约 10MB Pyodide），只在用户明确开过时恢复
    if (c.codeEnabled !== undefined && $('cfgCodeEnabled')) $('cfgCodeEnabled').checked = !!c.codeEnabled;
    if (c.searchMode !== undefined) STATE.searchMode = c.searchMode;
    if (c.toolChoice !== undefined && ['auto', 'required', 'none'].includes(c.toolChoice)) {
      STATE.toolChoice = c.toolChoice;
    }
    if ($('cfgToolChoice')) $('cfgToolChoice').value = STATE.toolChoice || 'auto';
    $('cfgBraveKey').value = c.braveKey || env.BRAVE_SEARCH_KEY || '';
    if (c.theme) STATE.theme = c.theme;
    if (c.lang) STATE.lang = c.lang;
    cfgApplyGroups(c.groups);
    applyTheme(STATE.theme);
    applyLang(STATE.lang);
  } catch(e) {}
  if (needResave) { saveConfig(); }
}


function cfgApplyGroups(saved) {
  const s = (saved && typeof saved === 'object') ? saved : {};
  for (const id of CFG_GROUP_IDS) {
    _cfgGroupPrefs[id] = (s[id] !== undefined) ? !!s[id] : CFG_GROUP_DEFAULTS[id];
  }
  const base = $('cfgBaseUrl'), key = $('cfgApiKey');
  const configured = !!(base && base.value.trim() && key && key.value.trim());
  _cfgGroupsMuted = true;
  for (const id of CFG_GROUP_IDS) {
    const el = $(id);
    if (!el) continue;
    // 未配置 API 时强制展开该组（不写入偏好），否则首次使用的人看不到该填哪里
    el.open = (id === 'grpApi' && !configured) ? true : _cfgGroupPrefs[id];
  }
  // toggle 事件异步派发，等本轮任务队列清空后再放开监听
  setTimeout(() => { _cfgGroupsMuted = false; }, 0);
  cfgSyncGroupBadges();
}

// 供外部调用：程序化改写某个分组里的字段时把它展开，避免值悄悄变了用户看不见
function cfgOpenGroup(id) {
  const el = $(id);
  if (!el || el.open) return;
  el.open = true;
  if (CFG_GROUP_IDS.includes(id)) _cfgGroupPrefs[id] = true;
  saveConfig();
}

/* ── ⓘ 详情展开 ──
   长说明不再常驻版面，但绝不删除：一句话要点留在界面上，完整说明（含代码执行的
   安全边界）放在这里，点 ⓘ 展开、悬浮看 title，两条路径都能拿到全文。 */
function cfgToggleInfo(detailId, btn) {
  const box = $(detailId);
  if (!box) return;
  const show = box.hidden;
  box.hidden = !show;
  if (btn) btn.setAttribute('aria-expanded', show ? 'true' : 'false');
}

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

function applyLang(lang) {
  STATE.lang = lang;
  document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
  applyI18n();
  saveConfig();
}

const I18N = {
  zh: {
    newConv: '新对话', convList: '对话列表', baseUrl: 'Base URL', apiKey: 'API Key',
    systemPrompt: 'System Prompt', temperature: 'Temperature', maxTokens: 'Max Tokens',
    maxTokHint: '仅限单次<b>输出</b>长度，非上下文窗口。',
    maxTokDetail: '这是发给 API 的 max_tokens，只约束模型一次回复能写多长，与上下文窗口无关。多数模型上限在 4k–32k，填过大服务端会直接返回 400。',
    braveKey: 'Brave Search Key',
    enableSearch: '启用 Agent 联网能力（搜索+抓取网页）',
    enableCode: '启用 Agent 代码执行（Python / JS 本地沙箱）',
    codeHint: '代码在<b>你的浏览器沙箱</b>内运行，首次约 10MB。',
    codeDetail: '⚠ 安全说明：开启后模型可在你的浏览器里执行代码。Python 跑在 Pyodide WASM 沙箱内，无法访问本机文件系统，只能读取你显式放入缓存区的文件；JS 跑在 Web Worker 里，同样与页面隔离。代码不会上传到服务器。首次调用需下载约 10MB 运行时。',
    infoMore: '查看完整说明',
    groupApi: 'API 连接', groupModel: '模型参数', groupAgent: 'Agent 能力', groupSearch: '搜索服务',
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
    gsPlaceholder: '🔍 搜索所有对话...',
    arenaTitle: '模型竞技场（多模型并排对比）',
    promptLibTitle: 'Prompt 模板库',
    micTitle: '语音输入',
    profileTitle: '个人信息（用户自己填写）',
    memoryTitle: '长期记忆（Agent 自行维护，可编辑）',
  },
  en: {
    newConv: 'New Chat', convList: 'Conversations', baseUrl: 'Base URL', apiKey: 'API Key',
    systemPrompt: 'System Prompt', temperature: 'Temperature', maxTokens: 'Max Tokens',
    maxTokHint: 'Caps one <b>reply</b>, not the context window.',
    maxTokDetail: 'This is the API max_tokens: it only limits how long a single reply can be, and has nothing to do with the context window. Most models cap at 4k–32k; a value that is too large makes the server return 400.',
    braveKey: 'Brave Search Key',
    enableSearch: 'Enable Agent web access (search + scrape)',
    enableCode: 'Enable Agent code execution (Python / JS local sandbox)',
    codeHint: 'Code runs in <b>your browser sandbox</b>; ~10MB on first use.',
    codeDetail: '⚠ Security note: once enabled, the model can run code inside your browser. Python runs in the Pyodide WASM sandbox with no access to your local filesystem — only files you explicitly put in the context buffer; JS runs in a Web Worker, also isolated from the page. Code is never uploaded to a server. The first call downloads about 10MB of runtime.',
    infoMore: 'Show full details',
    groupApi: 'API Connection', groupModel: 'Model Parameters', groupAgent: 'Agent Capabilities', groupSearch: 'Search Services',
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
    gsPlaceholder: '🔍 Search all conversations...',
    arenaTitle: 'Model Arena (compare models side by side)',
    promptLibTitle: 'Prompt Library',
    micTitle: 'Voice input',
    profileTitle: 'Personal info (you fill this in)',
    memoryTitle: 'Long-term memory (agent-maintained, editable)',
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
    cfgBraveKey: 'braveKey',
  };
  for (const [id, key] of Object.entries(labels)) {
    const el = $(id);
    if (el) { const lbl = el.closest('.config-row')?.querySelector('label'); if (lbl) lbl.textContent = t(key); }
  }

  // Search toggle label
  const searchLabel = document.querySelector('#cfgSearchEnabled + label');
  if (searchLabel) searchLabel.textContent = t('enableSearch');
  const codeLabel = $('codeEnabledLabel');
  if (codeLabel) codeLabel.textContent = t('enableCode');
  const codeHint = $('codeEnabledHint');
  if (codeHint) codeHint.innerHTML = t('codeHint');
  const codeDetail = $('codeEnabledDetail');
  if (codeDetail) codeDetail.innerHTML = t('codeDetail');
  const codeInfoBtn = $('codeInfoBtn');
  if (codeInfoBtn) { codeInfoBtn.title = t('codeDetail').replace(/<[^>]+>/g, ''); codeInfoBtn.setAttribute('aria-label', t('infoMore')); }
  const toolChoiceLbl = $('toolChoiceLabel');
  if (toolChoiceLbl) toolChoiceLbl.textContent = t('toolChoiceLabel');
  // 按 value 覆盖三个选项文案，避免下标错位
  const tcSel = $('cfgToolChoice');
  if (tcSel) {
    const isZh = STATE.lang === 'zh';
    const TC_TEXT = {
      auto: isZh ? '自动（模型自行决定是否调用）' : 'Auto (model decides)',
      required: isZh ? '强制调用（至少调用一次工具）' : 'Required (force at least one tool call)',
      none: isZh ? '禁用工具（仅用已有知识回答）' : 'Disabled (use existing knowledge only)',
    };
    for (const opt of tcSel.options) if (TC_TEXT[opt.value]) opt.textContent = TC_TEXT[opt.value];
  }
  const maxTokHint = $('maxTokHint');
  if (maxTokHint) maxTokHint.innerHTML = t('maxTokHint');
  const maxTokDetail = $('maxTokDetail');
  if (maxTokDetail) maxTokDetail.innerHTML = t('maxTokDetail');
  const maxTokInfoBtn = $('maxTokInfoBtn');
  if (maxTokInfoBtn) { maxTokInfoBtn.title = t('maxTokDetail').replace(/<[^>]+>/g, ''); maxTokInfoBtn.setAttribute('aria-label', t('infoMore')); }

  // 侧栏配置分组标题（追加，不影响上面已有的 label 赋值）
  const GROUP_KEYS = { grpApiTitle: 'groupApi', grpModelTitle: 'groupModel', grpAgentTitle: 'groupAgent', grpSearchTitle: 'groupSearch' };
  for (const [id, key] of Object.entries(GROUP_KEYS)) {
    const el = $(id);
    if (el) el.textContent = t(key);
  }
  if (typeof cfgSyncGroupBadges === 'function') cfgSyncGroupBadges();

  // Topbar
  const modelLabel = document.querySelector('.topbar-model span');
  if (modelLabel) modelLabel.textContent = t('model');
  const toggleBtn = document.querySelector('.topbar-toggle');
  if (toggleBtn) toggleBtn.title = t('toggleSidebar');

  // Topbar action buttons
  const ctxBtn = $('ctxToggleBtn'); if (ctxBtn) ctxBtn.title = t('ctxBuffer');
  const debugBtn = $('debugToggleBtn'); if (debugBtn) debugBtn.title = t('debugLog');
  // 第四期把导出按钮换成了导出菜单（id=exportBtn），保留旧选择器做兼容
  const exportBtn = $('exportBtn')
    || document.querySelector('.topbar-actions .icon-btn[onclick="exportConversation()"]');
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

  // 第四期新增控件
  const gsInput = $('gsInput'); if (gsInput) gsInput.placeholder = t('gsPlaceholder');
  const arenaBtn = $('arenaBtn'); if (arenaBtn) arenaBtn.title = t('arenaTitle');
  const plBtn = $('promptLibBtn'); if (plBtn) plBtn.title = t('promptLibTitle');
  const profBtn = $('profileBtn'); if (profBtn) profBtn.title = t('profileTitle');
  const memBtn = $('memoryBtn'); if (memBtn) memBtn.title = t('memoryTitle');
  const micBtn = $('micBtn'); if (micBtn && typeof voiceSyncMicBtn === 'function') voiceSyncMicBtn();
  else if (micBtn) micBtn.title = t('micTitle');
}
