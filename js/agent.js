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
  search_wikipedia: { type: 'search_wikipedia', field: 'query' },
  search_hackernews: { type: 'search_hackernews', field: 'query' },
  search_pubmed: { type: 'search_pubmed', field: 'query' },
  search_stackexchange: { type: 'search_stackexchange', field: 'query' },
  fetch_page: { type: 'fetch', field: 'url' },
  ctx_read: { type: 'ctx_read', field: 'id' },
  ctx_search: { type: 'ctx_search', field: 'query' },
  ctx_delete: { type: 'ctx_delete', field: 'id' },
  run_python: { type: 'run_python', field: 'code' },
  run_js: { type: 'run_js', field: 'code' },
  memory_write: { type: 'memory_write', field: 'content' },
  memory_delete: { type: 'memory_delete', field: 'id' },
};

// 搜索类工具受"联网开关"控制；代码执行工具受独立的"代码执行开关"控制
function isSearchToolsEnabled() {
  return !!(STATE.searchMode && $('cfgSearchEnabled') && $('cfgSearchEnabled').checked);
}
function isCodeToolsEnabled() {
  return !!($('cfgCodeEnabled') && $('cfgCodeEnabled').checked);
}
/* 本轮是否存在任何可用工具。doGenerate 用它决定"收到 tool_calls 却无工具"时是否退出循环；
   记忆与自定义 HTTP 工具不受联网/代码开关管辖，所以不能只看那两个开关。 */
function isAnyToolsEnabled() {
  if (STATE.toolChoice === 'none') return false;
  if (isSearchToolsEnabled() || isCodeToolsEnabled()) return true;
  if (typeof memEnabled === 'function' && memEnabled()) return true;
  if (typeof ctGetAll === 'function' && ctGetAll().some(t => t.enabled)) return true;
  return false;
}

function getToolDefinitions() {
  const fn = (name, description, props, required) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: props, required } },
  });
  const tools = [];
  if (isCodeToolsEnabled()) {
    tools.push(fn('run_python', 'Run Python code in an in-browser Pyodide (WASM) sandbox and return stdout/stderr/return value. numpy/pandas/matplotlib/scipy/sympy are auto-installed on demand. matplotlib figures are captured and shown to the user automatically (use Agg backend, plt.show() not required). Knowledge-buffer file entries are mounted read-only under /data/, so open("/data/<name>") works. Use this for exact arithmetic, data processing and plotting instead of computing by hand.',
      { code: { type: 'string', description: 'Python source code. Use print() to output results.' } }, ['code']));
    tools.push(fn('run_js', 'Run JavaScript in a zero-dependency Web Worker sandbox (no DOM, no network to the host page) and return console output and the returned value. 10s timeout. Best for quick calculations, JSON/string processing and regex checks.',
      { code: { type: 'string', description: 'JavaScript source. Body of an async function; use console.log or return a value.' } }, ['code']));
  }
  // 知识库读写不属于"联网"，只要有任一类工具开启且缓存区非空就提供
  const ctxTools = () => {
    const buf = getCtxBuffer();
    if (!buf.length) return;
    tools.push(fn('ctx_search', 'BM25 keyword search across ALL knowledge-buffer entries of this conversation. Returns only the matching passages with surrounding context, plus the source entry ID and character offsets. Use this FIRST to locate relevant material instead of reading whole entries.',
      { query: { type: 'string', description: 'Keywords to look for inside the cached documents' },
        top_k: { type: 'integer', description: 'Number of passages to return (default 5, max 50)' } }, ['query']));
    tools.push(fn('ctx_read', 'Read a knowledge-buffer entry by ID, with pagination. Pass offset/length to read a specific window (large documents exceed one page); the result always states the total length and the next offset to continue from.',
      { id: { type: 'string', description: 'Buffer entry ID from the index' },
        offset: { type: 'integer', description: 'Start character offset, default 0' },
        length: { type: 'integer', description: 'Number of characters to read, default and max 15000' } }, ['id']));
    tools.push(fn('ctx_delete', 'Delete a knowledge-buffer entry no longer needed, by its ID.',
      { id: { type: 'string', description: 'Buffer entry ID from the index' } }, ['id']));
  };
  // 用户自定义 HTTP 工具（js/custom-tools.js）：与内置开关无关，启用即注册
  const customTools = (typeof ctGetToolDefinitions === 'function') ? ctGetToolDefinitions() : [];
  // 长期记忆工具（js/memory.js）：由记忆自身的开关控制，与联网/代码无关
  const memTools = (typeof memGetToolDefinitions === 'function') ? memGetToolDefinitions() : [];
  const extraTools = customTools.concat(memTools);
  if (!isSearchToolsEnabled()) {
    if (tools.length || extraTools.length) ctxTools();
    return tools.concat(extraTools);
  }
  const q = { query: { type: 'string', description: 'Search keywords' } };
  tools.push(...[
    fn('search_web', 'General web search (Google via SerpAPI, Brave fallback). Use for general information.', q, ['query']),
    fn('search_google', 'High-quality Google search (SerpAPI). Prefer this for general info.', q, ['query']),
    fn('search_arxiv', 'Search arXiv papers (returns title, authors, abstract).', q, ['query']),
    fn('search_scholar', 'Academic paper search (Semantic Scholar / OpenAlex / CrossRef).', q, ['query']),
    fn('search_github', 'Search GitHub repositories, sorted by stars.', q, ['query']),
    fn('search_wikipedia', 'Search Wikipedia and return article intros (plain text). Best for encyclopedic facts, definitions of concepts, historical/geographic/biographical background. Auto-selects the zh site for Chinese queries, en otherwise.', q, ['query']),
    fn('search_hackernews', 'Search Hacker News discussions (Algolia). Best for tech-community opinions, tool comparisons, launch news and developer sentiment; returns points and comment counts.', q, ['query']),
    fn('search_pubmed', 'Search PubMed biomedical literature (NCBI). Best for medicine, biology, clinical and life-science papers; returns title, authors, journal, year, DOI and PMID.', q, ['query']),
    fn('search_stackexchange', 'Search Stack Overflow questions. Best for concrete programming errors, API usage and implementation problems; returns score, answered status and tags.', q, ['query']),
    fn('fetch_page', 'Fetch and extract the readable content of a web page. arXiv links auto-return metadata + full text. Do NOT use on Google/Scholar result pages.',
      { url: { type: 'string', description: 'Full URL starting with http(s)://' } }, ['url']),
  ]);
  ctxTools();
  return tools.concat(extraTools);
}

// 把流式累积的 tool_calls（arguments 为 JSON 字符串）解析为内部 cmd 列表
function toolCallsToCommands(toolCalls) {
  const cmds = [];
  for (const tc of (toolCalls || [])) {
    const name = tc.function?.name;
    const mapping = TOOL_NAME_TO_CMD[name];
    let args = {};
    // 自定义工具名是运行时才知道的，未命中内置映射时先查自定义工具表，再判定未知
    if (!mapping) {
      const custom = (typeof ctFindByName === 'function') ? ctFindByName(name) : null;
      if (!custom) { console.warn('[Tools] 未知工具:', name); continue; }
      try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
      catch (e) { console.warn(`[Tools] 解析 arguments 失败 (${name}): ${e.message}`, tc.function?.arguments); continue; }
      const missing = custom.params.filter(p => p.required && !String(args[p.name] || '').trim());
      if (missing.length) { console.warn(`[Tools] 自定义工具 ${name} 缺少参数: ${missing.map(p => p.name).join(', ')}`); continue; }
      cmds.push({ type: 'custom_tool', customId: custom.id, args, toolCallId: tc.id, toolName: name });
      continue;
    }
    try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
    catch (e) { console.warn(`[Tools] 解析 arguments 失败 (${name}): ${e.message}`, tc.function?.arguments); continue; }
    const val = (args[mapping.field] || '').toString().trim();
    if (!val) { console.warn(`[Tools] 工具 ${name} 缺少字段 ${mapping.field}`); continue; }
    const cmd = { type: mapping.type, [mapping.field]: val, toolCallId: tc.id, toolName: name };
    // ctx_read 的分页参数是可选的，不走 mapping.field 主字段
    if (mapping.type === 'ctx_read') {
      if (args.offset !== undefined) cmd.offset = args.offset;
      if (args.length !== undefined) cmd.length = args.length;
    }
    if (mapping.type === 'ctx_search' && args.top_k !== undefined) cmd.topK = args.top_k;
    // memory_write 的 id 是可选的：带 id 表示覆盖更新已有条目而不是新增
    if (mapping.type === 'memory_write' && args.id !== undefined) cmd.memId = String(args.id || '').trim();
    cmds.push(cmd);
  }
  return cmds;
}

// 代码执行工具的使用指南（独立开关，与联网能力互不依赖）
function getCodeToolsPrompt() {
  if (!isCodeToolsEnabled()) return '';
  if (STATE.lang === 'zh') {
    return `\n\n[代码执行工具使用指南]
你可以在用户浏览器的本地沙箱里执行代码：run_python（Pyodide WASM，自带 numpy / pandas / matplotlib / scipy / sympy）、run_js（Web Worker，零依赖，10 秒超时）。

使用原则：
- 涉及数值计算、统计、单位换算、日期推算、大数运算时一律用 run_python 实算，禁止心算或手推，避免算错。
- 数据处理（CSV / JSON / 表格清洗、聚合、排序）优先 run_python 的 pandas。
- 需要图表时用 matplotlib 直接画，图片会自动截取并展示给用户，不需要 plt.show()，也不要尝试保存到本地路径。
- 知识库中 type 为文件的条目会挂载到 /data/ 目录，用 open('/data/文件名') 或 pandas.read_csv('/data/文件名') 读取；先看知识库索引里的文件名。
- 用 print() 输出结果，否则你看不到中间过程；错误信息会原样回传，可据此修正后重试。
- 轻量的字符串处理、正则验证、JSON 变换可以用 run_js，更快；重活交给 run_python。
- 沙箱无法访问本机文件系统和你的网络，不要在代码里尝试联网或读写用户磁盘，需要网页内容请用 fetch_page。`;
  }
  return `\n\n[Code Execution Tools]
You can execute code in a local sandbox inside the user's browser: run_python (Pyodide WASM, with numpy / pandas / matplotlib / scipy / sympy available on demand) and run_js (Web Worker, zero dependency, 10s timeout).

Principles:
- For any arithmetic, statistics, unit conversion, date math or big-number work, compute it with run_python instead of doing mental math; this avoids calculation errors.
- For data wrangling (CSV / JSON / table cleaning, aggregation, sorting) prefer pandas via run_python.
- To produce charts just use matplotlib; figures are captured and displayed to the user automatically. plt.show() is unnecessary and do not try to save to a local path.
- Knowledge-buffer file entries are mounted under /data/; read them with open('/data/<name>') or pandas.read_csv('/data/<name>'). Check the buffer index for exact names.
- Always print() results, otherwise you cannot see them. Error output is returned verbatim so you can fix and retry.
- Use run_js for light string/regex/JSON work (faster); use run_python for anything heavy.
- The sandbox cannot access the local filesystem or the network. Do not attempt network calls or disk writes; use fetch_page when you need web content.`;
}

// 联网工具的使用指南（原生 function calling，工具 schema 单独通过 tools 字段传递）
function getSearchSystemPrompt() {
  if (!isSearchToolsEnabled()) return getCodeToolsPrompt();
  const isZh = STATE.lang === 'zh';
  if (isZh) {
    return getCodeToolsPrompt() + `\n\n[联网工具使用指南]
你拥有联网能力，可通过 function calling 调用以下工具：search_web / search_google（通用搜索）、search_arxiv / search_scholar（学术论文）、search_github（代码仓库）、search_wikipedia（百科条目）、search_hackernews（技术圈讨论）、search_pubmed（生物医学文献）、search_stackexchange（编程问答）、fetch_page（抓取网页正文）、ctx_search / ctx_read / ctx_delete（知识库检索与读写）。此外用户可能配置了自定义 HTTP 工具，它们的描述里标注了 "user-defined HTTP tool"，按描述正常调用即可。

使用原则：
- 搜索一般信息时优先用 search_google（质量最高），search_web 作为备选。
- 搜索学术论文用 search_arxiv 或 search_scholar；搜代码/项目用 search_github。
- 查百科事实、概念定义、人物/地理/历史背景用 search_wikipedia（中文提问自动走中文维基）。
- 想了解技术圈的讨论、观点与工具口碑用 search_hackernews。
- 医学、生物、临床相关文献用 search_pubmed，比通用学术搜索更准。
- 具体的编程报错、API 用法、实现方案用 search_stackexchange。
- 用户提到 URL 时用 fetch_page 抓取；arXiv 链接会自动返回元数据和全文，维基百科链接会返回条目纯文本全文。
- 不要用 fetch_page 抓取 Google 搜索结果页或 Google Scholar 页面（会被反爬拦截），请改用对应的 search_* 工具。
- 需要多个信息时可以在一次回复中并行调用多个工具；大规模文献调研可分多轮、换关键词和来源。
- 知识库有缓存时，先用 ctx_search 定位：它对全部缓存条目做关键词检索，只回传命中片段及其上下文，并给出来源条目 ID 与在原文中的字符位置。不要凭标题猜内容，也不要一上来就读全文。
- 需要片段之外的上下文时，再用 ctx_read 分页读取：传入 ctx_search 给出的 ID 与 offset（片段起点附近），每次最多 15000 字符。返回文本会告知总长度与下一段 offset，需要继续时用新的 offset 再调一次。大文档请这样逐段推进，而不是反复读同一页。
- 确认某条不再需要时用 ctx_delete 清理。
- 工具结果返回后基于结果继续回答，并引用来源链接。不需要时不要调用工具。`;
  } else {
    return getCodeToolsPrompt() + `\n\n[Web Tools Usage]
You have internet access via function calling. Available tools: search_web / search_google (general search), search_arxiv / search_scholar (academic papers), search_github (repositories), search_wikipedia (encyclopedia articles), search_hackernews (tech-community discussions), search_pubmed (biomedical literature), search_stackexchange (programming Q&A), fetch_page (scrape a page), ctx_search / ctx_read / ctx_delete (knowledge-buffer search and read/delete). The user may also have configured custom HTTP tools; their descriptions are marked "user-defined HTTP tool" — call them normally per their description.

Principles:
- For general info prefer search_google (highest quality), search_web as fallback.
- For academic papers use search_arxiv or search_scholar; for code/projects use search_github.
- For encyclopedic facts, concept definitions and people/place/history background use search_wikipedia (Chinese queries auto-use the zh site).
- For tech-community discussion, opinions and tool reputation use search_hackernews.
- For medical, biological and clinical literature use search_pubmed; it is more precise than general academic search.
- For concrete programming errors, API usage and implementation questions use search_stackexchange.
- When the user mentions a URL, use fetch_page; arXiv links auto-return metadata and full text, Wikipedia links return the plain-text article body.
- Do NOT use fetch_page on Google search-result pages or Google Scholar pages (blocked by anti-scraping); use the corresponding search_* tool instead.
- You may call multiple tools in one turn; for large literature surveys, search in multiple rounds with different keywords and sources.
- When the knowledge buffer has entries, locate material with ctx_search first: it keyword-searches every cached entry and returns only the matching passages with context, plus the source entry ID and character offsets. Do not guess content from titles and do not read whole entries up front.
- When you need more context than a passage gives, use ctx_read with pagination: pass the ID from ctx_search plus an offset near the passage start; each call returns at most 15000 characters and always states the total length and the next offset. Walk long documents forward page by page instead of re-reading the same page.
- Use ctx_delete to remove entries no longer needed.
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

function setToolChoice(val) {
  // 白名单校验，避免 required 被吞掉或写入非法值
  const ALLOWED = ['auto', 'required', 'none'];
  STATE.toolChoice = ALLOWED.includes(val) ? val : 'auto';
  saveConfig();
  const labels = STATE.lang === 'zh'
    ? { auto: '自动', required: '强制调用', none: '禁用工具' }
    : { auto: 'Auto', required: 'Required', none: 'Disabled' };
  toast((STATE.lang === 'zh' ? '工具调用策略: ' : 'Tool choice: ') + (labels[STATE.toolChoice] || STATE.toolChoice), 'info');
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
