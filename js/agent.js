/* ============================================================
   ETA (Edge Thin Agent) — Agent Loop, Stream, Command Parsing, Send
   ============================================================ */

// ── 工具定义（OpenAI 原生 function calling） ──
// 工具名 → 内部指令类型的映射（executeSingleCommand 使用）
const TOOL_NAME_TO_CMD = {
  search_web: { type: 'search', field: 'query' },
  search_google: { type: 'search_google', field: 'query' },
  search_arxiv: { type: 'search_arxiv', field: 'query' },
  search_scholar: { type: 'search_scholar', field: 'query' },
  search_github: { type: 'search_github', field: 'query' },
  fetch_page: { type: 'fetch', field: 'url' },
  ctx_read: { type: 'ctx_read', field: 'id' },
  ctx_delete: { type: 'ctx_delete', field: 'id' },
};

function getToolDefinitions() {
  if (!STATE.searchMode || !$('cfgSearchEnabled').checked) return [];
  const fn = (name, description, props, required) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: props, required } },
  });
  const q = { query: { type: 'string', description: 'Search keywords' } };
  const tools = [
    fn('search_web', 'General web search (Google via SerpAPI, Brave fallback). Use for general information.', q, ['query']),
    fn('search_google', 'High-quality Google search (SerpAPI). Prefer this for general info.', q, ['query']),
    fn('search_arxiv', 'Search arXiv papers (returns title, authors, abstract).', q, ['query']),
    fn('search_scholar', 'Academic paper search (Semantic Scholar / OpenAlex / CrossRef).', q, ['query']),
    fn('search_github', 'Search GitHub repositories, sorted by stars.', q, ['query']),
    fn('fetch_page', 'Fetch and extract the readable content of a web page. arXiv links auto-return metadata + full text. Do NOT use on Google/Scholar result pages.',
      { url: { type: 'string', description: 'Full URL starting with http(s)://' } }, ['url']),
  ];
  const buf = getCtxBuffer();
  if (buf.length) {
    tools.push(fn('ctx_read', 'Read the full content of a knowledge-buffer entry by its ID.',
      { id: { type: 'string', description: 'Buffer entry ID from the index' } }, ['id']));
    tools.push(fn('ctx_delete', 'Delete a knowledge-buffer entry no longer needed, by its ID.',
      { id: { type: 'string', description: 'Buffer entry ID from the index' } }, ['id']));
  }
  return tools;
}

// 把流式累积的 tool_calls（arguments 为 JSON 字符串）解析为内部 cmd 列表
function toolCallsToCommands(toolCalls) {
  const cmds = [];
  for (const tc of (toolCalls || [])) {
    const name = tc.function?.name;
    const mapping = TOOL_NAME_TO_CMD[name];
    if (!mapping) { console.warn('[Tools] 未知工具:', name); continue; }
    let args = {};
    try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
    catch (e) { console.warn(`[Tools] 解析 arguments 失败 (${name}): ${e.message}`, tc.function?.arguments); continue; }
    const val = (args[mapping.field] || '').toString().trim();
    if (!val) { console.warn(`[Tools] 工具 ${name} 缺少字段 ${mapping.field}`); continue; }
    cmds.push({ type: mapping.type, [mapping.field]: val, toolCallId: tc.id, toolName: name });
  }
  return cmds;
}

// 联网工具的使用指南（原生 function calling，工具 schema 单独通过 tools 字段传递）
function getSearchSystemPrompt() {
  if (!STATE.searchMode || !$('cfgSearchEnabled').checked) return '';
  const isZh = STATE.lang === 'zh';
  if (isZh) {
    return `\n\n[联网工具使用指南]
你拥有联网能力，可通过 function calling 调用以下工具：search_web / search_google（通用搜索）、search_arxiv / search_scholar（学术论文）、search_github（代码仓库）、fetch_page（抓取网页正文）、ctx_read / ctx_delete（知识库缓存读写）。

使用原则：
- 搜索一般信息时优先用 search_google（质量最高），search_web 作为备选。
- 搜索学术论文用 search_arxiv 或 search_scholar；搜代码/项目用 search_github。
- 用户提到 URL 时用 fetch_page 抓取；arXiv 链接会自动返回元数据和全文。
- 不要用 fetch_page 抓取 Google 搜索结果页或 Google Scholar 页面（会被反爬拦截），请改用对应的 search_* 工具。
- 需要多个信息时可以在一次回复中并行调用多个工具；大规模文献调研可分多轮、换关键词和来源。
- 知识库有缓存时先看标题索引，需要详细内容再用 ctx_read 按需读取，不要一次性全部读取；确认某条不再需要时用 ctx_delete 清理。
- 工具结果返回后基于结果继续回答，并引用来源链接。不需要时不要调用工具。`;
  } else {
    return `\n\n[Web Tools Usage]
You have internet access via function calling. Available tools: search_web / search_google (general search), search_arxiv / search_scholar (academic papers), search_github (repositories), fetch_page (scrape a page), ctx_read / ctx_delete (knowledge-buffer read/delete).

Principles:
- For general info prefer search_google (highest quality), search_web as fallback.
- For academic papers use search_arxiv or search_scholar; for code/projects use search_github.
- When the user mentions a URL, use fetch_page; arXiv links auto-return metadata and full text.
- Do NOT use fetch_page on Google search-result pages or Google Scholar pages (blocked by anti-scraping); use the corresponding search_* tool instead.
- You may call multiple tools in one turn; for large literature surveys, search in multiple rounds with different keywords and sources.
- When the knowledge buffer has entries, check the title index first and use ctx_read only when details are needed; use ctx_delete to remove entries no longer needed.
- After tools return, continue answering based on the results and cite source links. Do not call tools when not needed.`;
  }
}

// ── 获取语言偏好 system prompt 后缀 ──
function getLangSystemSuffix() {
  if (STATE.lang === 'zh') {
    return '\n\nPlease always respond in Chinese (简体中文).';
  } else {
    return '\n\nPlease always respond in English.';
  }
}

// ── 输入处理 ──
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

function handleInputKey(event) {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    sendMessage();
  }
}

function toggleSearchMode() {
  STATE.searchMode = !STATE.searchMode;
  const isZh = STATE.lang === 'zh';
  $('searchToggle').title = (isZh ? '搜索模式: ' : 'Search Mode: ') + (STATE.searchMode ? (isZh ? '开' : 'ON') : (isZh ? '关' : 'OFF'));
  $('searchToggle').style.color = STATE.searchMode ? 'var(--accent2)' : 'var(--text3)';
  saveConfig();
  toast((isZh ? '搜索模式: ' : 'Search Mode: ') + (STATE.searchMode ? (isZh ? '已开启' : 'ON') : (isZh ? '已关闭' : 'OFF')), 'info');
}

function toggleSidebar() {
  $('sidebar').classList.toggle('collapsed');
}

// ── 发送消息 ──
async function sendMessage() {
  if (STATE.generating) { abortGeneration(); return; }
  const text = $('userInput').value.trim();
  if (!text && !STATE.attachments.length) return;

  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.apiKey) { toast(STATE.lang === 'zh' ? '请先配置 Base URL 和 API Key' : 'Please configure Base URL and API Key first', 'fail'); return; }

  let conv = getActiveConv();
  if (!conv) { newConversation(); conv = getActiveConv(); }

  let parentId = conv.activeLeaf;
  const editNodeId = $('userInput').dataset.editNodeId;
  if (editNodeId && conv.tree[editNodeId]) {
    parentId = conv.tree[editNodeId].parentId;
    delete $('userInput').dataset.editNodeId;
  }

  let finalText = text;
  let apiText = text;
  const imageAttachments = [];
  for (const att of STATE.attachments) {
    if (att.type && att.type.startsWith('image/')) {
      imageAttachments.push(att);
    } else if (att.textContent) {
      apiText += `\n\n--- ${att.name} ---\n${att.textContent}`;
    }
  }

  const userMsgId = addMessageToTree(conv, parentId, 'user', finalText, '', imageAttachments);
  conv.tree[userMsgId].apiContent = apiText;
  const fileNames = STATE.attachments.filter(a => !a.type?.startsWith('image/') && a.textContent).map(a => a.name);
  if (fileNames.length) conv.tree[userMsgId].fileNames = fileNames;

  if (Object.keys(conv.tree).length <= 2) {
    conv.title = finalText.slice(0, 30) + (finalText.length > 30 ? '...' : '');
    renderConvList();
  }

  $('userInput').value = '';
  STATE.attachments = [];
  renderAttachPreview();
  autoResize($('userInput'));
  saveState();
  renderChat();

  const ctxBuf = conv.contextBuffer || [];
  ctxBuf.forEach(i => { i.readThisTurn = false; });
  renderCtxBuffer();

  await doGenerate(conv, userMsgId);
}

function abortGeneration() {
  if (STATE.abortCtrl) { STATE.abortCtrl.abort(); STATE.abortCtrl = null; }
  STATE.generating = false;
  updateSendBtn();
}

function updateSendBtn() {
  const btn = $('sendBtn');
  if (STATE.generating) {
    btn.innerHTML = '⏹'; btn.classList.add('stop'); btn.title = '停止生成';
  } else {
    btn.innerHTML = '▶'; btn.classList.remove('stop'); btn.title = '发送';
  }
}

// ── LLM 上下文总结 ──
async function summarizeContext(cfg, messages) {
  let contentToSummarize = '';
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m.role === 'assistant' || (m.role === 'user' && text.length > 500)) {
      contentToSummarize += `\n[${m.role}]: ${text}\n`;
    }
  }
  if (contentToSummarize.length > 100000) {
    contentToSummarize = contentToSummarize.slice(0, 100000) + '\n[...后续内容已省略]';
  }
  const sumMessages = [
    { role: 'system', content: STATE.lang === 'zh'
      ? '你是一个信息压缩助手。请将以下对话和搜索结果总结为一份结构化的摘要，保留所有关键事实、数据、URL链接、论文标题/作者、代码仓库等具体信息。不要遗漏重要细节。用中文输出。控制在 3000 字以内。'
      : 'You are a summarization assistant. Summarize the following conversation and search results into a structured summary. Preserve all key facts, data, URLs, paper titles/authors, code repos, and other specifics. Do not omit important details. Output in English. Keep it under 3000 words.' },
    { role: 'user', content: contentToSummarize },
  ];
  const url = joinUrl(cfg.baseUrl, 'chat/completions');
  const resp = await fetch(url, {
    method: 'POST', headers: headers(cfg.apiKey),
    body: JSON.stringify({ model: cfg.model, messages: sumMessages, temperature: 0.3, max_tokens: 4000, stream: false }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`总结 API 错误 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const summary = data?.choices?.[0]?.message?.content;
  if (!summary) throw new Error('总结返回为空');
  return `[以下是前几轮搜索和分析的总结]\n\n${summary}\n\n[总结结束，请基于以上信息和新的搜索结果继续回答]`;
}
