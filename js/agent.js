/* ============================================================
   ETA (Edge Thin Agent) — Agent Loop, Stream, Command Parsing, Send
   ============================================================ */

// ── 指令解析 ──
function parseAgentCommands(text) {
  const cmds = [];
  const seen = new Set();
  text = text.replace(/`(\[(?:SEARCH|SEARCH_ARXIV|SEARCH_SCHOLAR|SEARCH_GITHUB|SEARCH_GOOGLE|FETCH|CTX_READ|CTX_DELETE)[^\]]*\])`/gi, '$1');
  text = text.replace(/`(\[\/(?:SEARCH|SEARCH_ARXIV|SEARCH_SCHOLAR|SEARCH_GITHUB|SEARCH_GOOGLE|FETCH|CTX_READ|CTX_DELETE)\])`/gi, '$1');

  const tagTypes = [
    { tag: 'SEARCH', type: 'search', field: 'query' },
    { tag: 'SEARCH_ARXIV', type: 'search_arxiv', field: 'query' },
    { tag: 'SEARCH_SCHOLAR', type: 'search_scholar', field: 'query' },
    { tag: 'SEARCH_GITHUB', type: 'search_github', field: 'query' },
    { tag: 'SEARCH_GOOGLE', type: 'search_google', field: 'query' },
    { tag: 'FETCH', type: 'fetch', field: 'url' },
    { tag: 'CTX_READ', type: 'ctx_read', field: 'id' },
    { tag: 'CTX_DELETE', type: 'ctx_delete', field: 'id' },
  ];

  function addCmd(type, field, val) {
    val = val.trim().replace(/[\"\*\`\u201c\u201d]+$/g, '').replace(/^[\"\*\`\u201c\u201d]+/g, '').trim();
    if (!val) return;
    if ((field === 'query') && val.length < 5) return;
    const key = type + ':' + val;
    if (seen.has(key)) return;
    seen.add(key);
    cmds.push({ type, [field]: val });
  }

  for (const { tag, type, field } of tagTypes) {
    const closedRe = new RegExp(`\\[${tag}\\]\\s*([\\s\\S]*?)\\s*\\[\\/${tag}\\]`, 'gi');
    let m;
    while ((m = closedRe.exec(text)) !== null) { addCmd(type, field, m[1]); }
    const badCloseRe = new RegExp(`\\[${tag}\\]\\s*([\\s\\S]*?)\\s*(?:\\[\\\\${tag}\\]|\\[${tag}\\/\\])`, 'gi');
    while ((m = badCloseRe.exec(text)) !== null) { addCmd(type, field, m[1]); }
    const openRe = new RegExp(`\\[${tag}\\]\\s*([^\\[\\]]+?)(?:\\s*$|\\s*(?=\\[))`, 'gim');
    while ((m = openRe.exec(text)) !== null) {
      const fullMatch = m[0];
      const after = text.slice(m.index + fullMatch.length, m.index + fullMatch.length + 50);
      if (new RegExp(`^\\s*\\[\\/${tag}\\]`, 'i').test(after)) continue;
      addCmd(type, field, m[1]);
    }
  }
  return cmds;
}

function getSearchSystemPrompt() {
  if (!STATE.searchMode || !$('cfgSearchEnabled').checked) return '';
  const isZh = STATE.lang === 'zh';
  if (isZh) {
    return `\n\n[联网工具]
你拥有联网能力，可以搜索和抓取网页。当需要时请使用以下工具：

1. 通用网页搜索（Google via SerpAPI）：
[SEARCH]搜索关键词[/SEARCH]

2. Google 搜索（高质量，推荐优先使用）：
[SEARCH_GOOGLE]搜索关键词[/SEARCH_GOOGLE]

3. arXiv 论文搜索（直接查询 arXiv API，返回标题、作者、摘要）：
[SEARCH_ARXIV]搜索关键词[/SEARCH_ARXIV]

4. 学术论文搜索（Semantic Scholar，覆盖多个学术数据库）：
[SEARCH_SCHOLAR]搜索关键词[/SEARCH_SCHOLAR]

5. GitHub 仓库搜索（按 star 排序）：
[SEARCH_GITHUB]搜索关键词[/SEARCH_GITHUB]

6. 抓取指定网页内容：
[FETCH]https://example.com/page[/FETCH]

7. 读取知识库缓存条目（根据索引中的 ID）：
[CTX_READ]缓存ID[/CTX_READ]

8. 删除不再需要的知识库缓存条目：
[CTX_DELETE]缓存ID[/CTX_DELETE]

使用规则：
- 每个工具调用必须包含开始和闭合标签，例如 [SEARCH_GOOGLE]关键词[/SEARCH_GOOGLE]，不要省略闭合标签
- 不要用 [FETCH] 抓取 Google Scholar (scholar.google.com) 页面，它会被反爬拦截。查学术论文请用 [SEARCH_SCHOLAR] 或 [SEARCH_ARXIV]
- 不要用 [FETCH] 抓取 Google 搜索结果页面 (google.com/search)，会被反爬。用 [SEARCH_GOOGLE] 代替
- 搜索一般信息时，优先用 [SEARCH_GOOGLE]（质量最高），[SEARCH] 作为备选
- 用户提到 URL 链接时，用 [FETCH] 抓取该网页内容
- arXiv 链接会自动获取论文元数据和 HTML 全文，直接用 [FETCH] 即可
- 搜索学术论文时，优先用 [SEARCH_ARXIV] 和 [SEARCH_SCHOLAR]，它们返回结构化的论文信息
- 搜索代码/项目时，用 [SEARCH_GITHUB]
- 知识库中有缓存资料时，先看标题索引，需要详细内容再用 [CTX_READ] 按需读取，不要一次性全部读取
- 确认某条缓存不再需要时，用 [CTX_DELETE] 清理，保持知识库精简
- 可以在一次回复中同时使用多个不同类型的工具
- 大规模文献调研时，可以分多轮搜索，每轮用不同关键词和搜索源
- 工具执行后系统会返回结果，你需要基于结果继续回答
- 回答时请引用来源链接
- 不要在不需要时使用工具`;
  } else {
    return `\n\n[Web Tools]
You have internet access and can search and scrape web pages. Use the following tools when needed:

1. General web search (Google via SerpAPI):
[SEARCH]search keywords[/SEARCH]

2. Google Search (high quality, recommended):
[SEARCH_GOOGLE]search keywords[/SEARCH_GOOGLE]

3. arXiv paper search (queries arXiv API, returns title, authors, abstract):
[SEARCH_ARXIV]search keywords[/SEARCH_ARXIV]

4. Academic paper search (Semantic Scholar, covers multiple databases):
[SEARCH_SCHOLAR]search keywords[/SEARCH_SCHOLAR]

5. GitHub repository search (sorted by stars):
[SEARCH_GITHUB]search keywords[/SEARCH_GITHUB]

6. Fetch a specific web page:
[FETCH]https://example.com/page[/FETCH]

7. Read a knowledge buffer entry (by ID from the index):
[CTX_READ]bufferID[/CTX_READ]

8. Delete a knowledge buffer entry no longer needed:
[CTX_DELETE]bufferID[/CTX_DELETE]

Rules:
- Each tool call must include opening and closing tags, e.g. [SEARCH_GOOGLE]keywords[/SEARCH_GOOGLE]
- NEVER use [FETCH] on Google Scholar (scholar.google.com) pages — they will be blocked by anti-scraping. Use [SEARCH_SCHOLAR] or [SEARCH_ARXIV] instead
- NEVER use [FETCH] on Google search result pages (google.com/search) — they will be blocked. Use [SEARCH_GOOGLE] instead
- For general info, prefer [SEARCH_GOOGLE] (highest quality), [SEARCH] as fallback
- When the user mentions a URL, use [FETCH] to scrape it
- arXiv links auto-fetch metadata and HTML full text, just use [FETCH]
- For academic papers, prefer [SEARCH_ARXIV] and [SEARCH_SCHOLAR]
- For code/projects, use [SEARCH_GITHUB]
- When the knowledge buffer has cached items, check the title index first, use [CTX_READ] only when details are needed
- Use [CTX_DELETE] to clean up unneeded buffer entries
- You can use multiple tools in a single response
- For large literature surveys, search in multiple rounds with different keywords
- After tool execution, the system returns results — continue answering based on them
- Cite source links in your answers
- Do not use tools when not needed`;
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
