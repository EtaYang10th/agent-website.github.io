/* ============================================================
   ETA (Edge Thin Agent) — Agent Command Execution & Search UI Helpers
   ============================================================ */

// ── 执行 Agent 工具调用（原生 tool_calls）──
// 关键约束：每个 tool_call 必须返回且仅返回一条 { role:'tool', tool_call_id } 消息，
// 否则 OpenAI 兼容接口会因 tool_calls 与 tool 消息不匹配而报错。
async function executeAgentCommands(agentCmds, aiMsgId, conv, searchRound, extraMessages) {
  const roundSignal = STATE.abortCtrl?.signal;
  // 超时值从第四期配置读取（js/eta-config.js），模块缺失时回退原硬编码值
  const _cfgMs = (k, d) => (typeof etaCfg === 'function') ? etaCfg(k) : d;
  const PER_CMD_TIMEOUT = _cfgMs('perCmdTimeout', 30000);
  // run_python 首次要下载约 10MB 的 Pyodide 再执行（自身超时 30s），单独放宽兜底时限
  const CODE_CMD_TIMEOUT = _cfgMs('codeCmdTimeout', 180000);
  const hasCodeCmd = agentCmds.some(c => c.type === 'run_python' || c.type === 'run_js');
  const ROUND_TIMEOUT = hasCodeCmd ? _cfgMs('codeRoundTimeout', 200000) : _cfgMs('roundTimeout', 60000);
  console.log(`[Agent 循环] 第 ${searchRound} 轮: 开始执行 ${agentCmds.length} 条工具调用`);

  const toolMsg = (cmd, content) => ({ role: 'tool', tool_call_id: cmd.toolCallId, name: cmd.toolName, content });

  const cmdPromises = agentCmds.map(async (cmd, idx) => {
    const cmdCtrl = new AbortController();
    const cmdSignal = cmdCtrl.signal;
    if (roundSignal) {
      if (roundSignal.aborted) cmdCtrl.abort();
      else roundSignal.addEventListener('abort', () => cmdCtrl.abort(), { once: true });
    }
    const cmdTimeout = (cmd.type === 'run_python' || cmd.type === 'run_js') ? CODE_CMD_TIMEOUT : PER_CMD_TIMEOUT;
    const cmdTimer = setTimeout(() => {
      console.warn(`[工具 #${idx}] 单条调用超时 (${cmdTimeout}ms), 类型=${cmd.type}`);
      cmdCtrl.abort();
    }, cmdTimeout);
    // 时间线埋点（软依赖：agent-timeline.js 未加载时静默跳过）
    const tlH = (typeof timelineToolStart === 'function') ? timelineToolStart(aiMsgId, cmd, searchRound) : null;
    try {
      const content = await executeSingleCommand(cmd, idx, aiMsgId, cmdSignal);
      if (typeof timelineToolEnd === 'function') {
        // 本项目约定：工具结果以 '[' 开头表示错误或空结果
        const text = String(content == null ? '' : content);
        timelineToolEnd(aiMsgId, tlH, { size: text.length, ok: !(text.startsWith('[') && /error|失败|不存在|超时|未找到|不可用/i.test(text.slice(0, 120))) });
      }
      return toolMsg(cmd, content);
    } catch (cmdErr) {
      const label = cmd.type === 'fetch' ? cmd.url : (cmd.query || cmd.id);
      console.warn(`[工具 #${idx}] ${cmd.type} 异常: ${cmdErr.message}`);
      if (typeof timelineToolEnd === 'function') {
        timelineToolEnd(aiMsgId, tlH, { ok: false, err: cmdErr.message || '超时/失败' });
      }
      return toolMsg(cmd, `[${cmd.type} 超时/失败: ${(label||'').slice(0,60)}]`);
    } finally {
      clearTimeout(cmdTimer);
    }
  });

  let roundTimerId;
  const roundTimeout = new Promise(resolve => {
    roundTimerId = setTimeout(() => {
      console.warn(`[Agent 循环] 第 ${searchRound} 轮: 整轮兜底超时 (${ROUND_TIMEOUT}ms)`);
      resolve('__ROUND_TIMEOUT__');
    }, ROUND_TIMEOUT);
  });
  const settled = await Promise.race([Promise.allSettled(cmdPromises), roundTimeout]);
  clearTimeout(roundTimerId);

  // 无论成功/失败/超时，都必须为每个 tool_call 产出一条 tool 消息。
  let settledResults;
  if (settled === '__ROUND_TIMEOUT__') {
    const partial = await Promise.allSettled(cmdPromises);
    settledResults = partial;
    console.warn(`[Agent 循环] 第 ${searchRound} 轮: 兜底超时后收集结果`);
  } else {
    settledResults = settled;
  }
  settledResults.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      extraMessages.push(r.value);
    } else {
      // Promise 被 reject（一般不会，因为上面已 try/catch）——仍需补一条 tool 消息保证配对
      extraMessages.push(toolMsg(agentCmds[i], '[工具调用执行失败]'));
    }
  });

  // 截断过大结果
  const MAX_RESULT_CHARS = 12000;
  const MAX_TOTAL_EXTRA_CHARS = 40000;
  let totalChars = 0;
  for (let i = 0; i < extraMessages.length; i++) {
    let c = extraMessages[i].content || '';
    if (c.length > MAX_RESULT_CHARS) {
      c = c.slice(0, MAX_RESULT_CHARS) + `\n\n[...内容已截断，原始 ${extraMessages[i].content.length} 字符]`;
      extraMessages[i] = { ...extraMessages[i], content: c };
    }
    totalChars += c.length;
    if (totalChars > MAX_TOTAL_EXTRA_CHARS) {
      // 不能直接删除后续 tool 消息（会破坏与 tool_call 的配对），只清空其内容
      for (let j = i + 1; j < extraMessages.length; j++) {
        extraMessages[j] = { ...extraMessages[j], content: '[结果因总量过大已省略]' };
      }
      break;
    }
  }
  hideSearchStatus(aiMsgId);
  console.log(`[Agent 循环] 第 ${searchRound} 轮: 工具执行完成, tool 消息: ${extraMessages.length} 条`);

  const hasUsefulResult = extraMessages.some(m => m.content && m.content.length > 200 && !m.content.startsWith('['));
  if (!hasUsefulResult) {
    console.warn(`[Agent 循环] 第 ${searchRound} 轮: 无有效工具结果`);
  }
}

// ── 执行单条工具调用，返回结果文本（字符串）──
/* ── 搜索类工具表 ──
   九个搜索分支的流程完全一致（状态条 → 搜索 → 错误则返回 → 结果卡片 →
   自动入库 → 格式化给 LLM），只有四处差异，全部收进这张表：

     prefix       状态条/卡片/回传文本共用的标签前缀。'search' 是唯一的空前缀
                  （直接用裸 query），拼接时不能无条件补 ': '。
     resolve      取实际的搜索实现（search 与 search_google 共用 doGoogleSearch）。
                  写成惰性取值而不是直接引用：本表在模块加载时求值，直接引用会
                  把当时的绑定固化下来，一旦有人调整 index.html 的脚本顺序就会
                  静默拿到 undefined。惰性取值把查找推迟到调用时。
     err          错误文案前缀，照抄原字符串（含 Stack Exchange 与前缀不一致
                  这一处历史瑕疵——要改是独立决定，别混进重构）。
     withEngine   错误里是否附带 (engine)。只有两个 Google 分支需要：
                  doGoogleSearch 内部会回退到 Brave，报错时得说明实际用了谁。
     withFallback 是否给卡片传 fallback 提示。注意 search.js 目前从未给
                  result.fallback 赋值，所以徽标实际不显示；保留该配置项成本
                  为零，将来补上字段即可直接生效，故不删。 */
const SEARCH_TOOLS = {
  search:               { prefix: '',               resolve: () => doGoogleSearch,        err: 'Search',               withEngine: true, withFallback: true },
  search_google:        { prefix: 'Google',         resolve: () => doGoogleSearch,        err: 'Google search',        withEngine: true, withFallback: true },
  search_arxiv:         { prefix: 'arXiv',          resolve: () => doArxivSearch,         err: 'arXiv search' },
  search_scholar:       { prefix: 'Scholar',        resolve: () => doScholarSearch,       err: 'Scholar search' },
  search_github:        { prefix: 'GitHub',         resolve: () => doGithubSearch,        err: 'GitHub search' },
  search_pubmed:        { prefix: 'PubMed',         resolve: () => doPubMedSearch,        err: 'PubMed search' },
  search_stackexchange: { prefix: 'Stack Overflow', resolve: () => doStackExchangeSearch, err: 'Stack Exchange search' },
  search_wikipedia:     { prefix: 'Wikipedia',      resolve: () => doWikipediaSearch,     err: 'Wikipedia search' },
  search_hackernews:    { prefix: 'Hacker News',    resolve: () => doHackerNewsSearch,    err: 'Hacker News search' },
};

async function runSearchTool(spec, cmd, idx, aiMsgId, cmdSignal) {
  const label = spec.prefix ? `${spec.prefix}: ${cmd.query}` : cmd.query;
  showSearchStatus(aiMsgId, 'search', label);
  console.log(`[搜索 #${idx}] ${cmd.type}: "${cmd.query}" 开始`);
  const result = await spec.resolve()(cmd.query, undefined, cmdSignal);
  console.log(`[搜索 #${idx}] ${cmd.type}: "${cmd.query}" 完成`);
  if (result.error) {
    const who = spec.withEngine ? ` (${result.engine || '?'})` : '';
    return `[${spec.err} error${who}: ${result.error}]`;
  }
  /* 精确复刻重构前的两种实参形态：带 fallback 能力的分支（两个 Google）原本传
     `result.fallback ? result.fallbackReason : null`，其余分支根本不传第 6 个参数。
     appendSearchResultsCard 里是 `if (fallbackInfo)`，null 与 undefined 行为一致，
     但保持实参一致能让回归比对严格成立。 */
  if (spec.withFallback) {
    appendSearchResultsCard(aiMsgId, result.results, label, 'search', result.engine,
      result.fallback ? result.fallbackReason : null);
  } else {
    appendSearchResultsCard(aiMsgId, result.results, label, 'search', result.engine);
  }
  ctxAutoSaveSearch(result.results, label, 'search');
  return formatSearchResultsForLLM(result.results, label);
}

async function executeSingleCommand(cmd, idx, aiMsgId, cmdSignal) {
  const searchSpec = SEARCH_TOOLS[cmd.type];
  if (searchSpec) return runSearchTool(searchSpec, cmd, idx, aiMsgId, cmdSignal);
  if (cmd.type === 'fetch') {
    showSearchStatus(aiMsgId, 'fetch', cmd.url);
    const result = await fetchWebPage(cmd.url, cmdSignal);
    if (result.error) return `[Fetch error: ${result.error}]`;
    appendFetchResultCard(aiMsgId, cmd.url, result.content);
    ctxAutoSaveFetch(cmd.url, result.content);
    return result.content;
  }
  if (cmd.type === 'ctx_read') {
    const buf = getCtxBuffer();
    const item = buf.find(i => i.id === cmd.id);
    if (!item) return `[缓存读取失败: ID=${cmd.id} 不存在]`;
    showSearchStatus(aiMsgId, 'fetch', `读取缓存: ${item.name}`);
    item.readCount = (item.readCount || 0) + 1;
    item.readThisTurn = true;
    saveState(); renderCtxBuffer();
    // 分页读取：不传 offset 时行为与旧版一致，但总会告知总长度与续读 offset
    const page = retrSlicePage(item.content, cmd.offset, cmd.length);
    let head = `[缓存内容: ${item.name}] 字符区间 ${page.offset}-${page.end} / 共 ${page.total} 字符`;
    head += page.hasMore
      ? `\n[还有 ${page.total - page.end} 字符未读。继续读取请再次调用 ctx_read，传 id="${item.id}" 与 offset=${page.nextOffset}（可选 length，默认且上限 15000）。]`
      : `\n[已到该条目末尾。]`;
    return `${head}\n${page.text}`;
  }
  if (cmd.type === 'ctx_search') {
    showSearchStatus(aiMsgId, 'fetch', `检索知识库: ${cmd.query}`);
    let hits = [];
    try { hits = await retrSearch(cmd.query, cmd.topK); }
    catch (e) { return `[知识库检索失败: ${e.message}]`; }
    // 命中片段所属条目算作"已读"，面板上能看出模型实际用了哪些资料
    const buf = getCtxBuffer();
    const touched = new Set(hits.map(h => h.itemId));
    for (const item of buf) {
      if (!touched.has(item.id)) continue;
      item.readCount = (item.readCount || 0) + 1;
      item.readThisTurn = true;
    }
    if (touched.size) { saveState(); renderCtxBuffer(); }
    appendCtxSearchCard(aiMsgId, cmd.query, hits);
    return retrFormatForLLM(cmd.query, hits);
  }
  if (cmd.type === 'custom_tool') {
    const tool = (typeof ctGetAll === 'function') ? ctGetAll().find(t => t.id === cmd.customId) : null;
    if (!tool) return `[自定义工具 ${cmd.toolName} 已被删除或禁用]`;
    showSearchStatus(aiMsgId, 'fetch', `${tool.name}: ${Object.values(cmd.args || {}).join(' ')}`);
    const out = await ctExecute(tool, cmd.args, cmdSignal);
    appendCustomToolCard(aiMsgId, tool, cmd.args, out);
    return out;
  }
  if (cmd.type === 'run_python') {
    showSearchStatus(aiMsgId, 'code', STATE.lang === 'en' ? 'Running Python...' : '正在执行 Python 代码...');
    if (typeof runPythonCode !== 'function') return '[run_python 不可用: sandbox-python.js 未加载]';
    const result = await runPythonCode(cmd.code);
    appendCodeResultCard(aiMsgId, cmd.code, result, 'python');
    return formatPyResultForLLM(result);
  }
  if (cmd.type === 'run_js') {
    showSearchStatus(aiMsgId, 'code', STATE.lang === 'en' ? 'Running JavaScript...' : '正在执行 JavaScript 代码...');
    if (typeof runJsCode !== 'function') return '[run_js 不可用: sandbox-js.js 未加载]';
    const result = await runJsCode(cmd.code);
    appendCodeResultCard(aiMsgId, cmd.code, result, 'javascript');
    return formatJsResultForLLM(result);
  }
  if (cmd.type === 'memory_write') {
    if (typeof memExecWrite !== 'function') return '[memory_write 不可用: memory.js 未加载]';
    if (typeof memEnabled === 'function' && !memEnabled()) return '[长期记忆已被用户关闭，本次写入未生效]';
    const out = await memExecWrite(cmd.content, cmd.memId, cmdSignal);
    appendMemoryCard(aiMsgId, 'write', cmd.content, out);
    return out;
  }
  if (cmd.type === 'memory_delete') {
    if (typeof memExecDelete !== 'function') return '[memory_delete 不可用: memory.js 未加载]';
    if (typeof memEnabled === 'function' && !memEnabled()) return '[长期记忆已被用户关闭，本次删除未生效]';
    const out = await memExecDelete(cmd.id);
    appendMemoryCard(aiMsgId, 'delete', cmd.id, out);
    return out;
  }
  if (cmd.type === 'ctx_delete') {
    const conv = getActiveConv();
    if (conv) {
      const buf = conv.contextBuffer || [];
      const idx2 = buf.findIndex(i => i.id === cmd.id);
      if (idx2 !== -1) {
        const name = buf[idx2].name;
        buf.splice(idx2, 1);
        saveState(); renderCtxBuffer(); updateCtxBtnBadge();
        if (typeof retrRemoveItem === 'function') retrRemoveItem(cmd.id, conv.id);
        return `[已删除缓存: ${name}]`;
      }
    }
    return `[缓存删除失败: ID=${cmd.id} 不存在]`;
  }
  return `[未知工具类型: ${cmd.type}]`;
}

// ── 搜索/抓取 UI 辅助函数 ──
function showSearchStatus(aiMsgId, type, detail) {
  const contentEl = document.getElementById('msg-content-' + aiMsgId);
  if (!contentEl) return;
  const old = contentEl.querySelector('.search-status');
  if (old) old.remove();
  const icon = type === 'fetch' ? '🌐' : (type === 'code' ? '🐍' : '🔍');
  const label = type === 'fetch' ? '正在抓取网页' : (type === 'code' ? '代码执行' : '正在搜索');
  const div = document.createElement('div');
  div.className = 'search-status';
  div.innerHTML = `<div class="search-spinner"></div>${icon} ${label}: "${escHtml(detail)}"...`;
  contentEl.appendChild(div);
  scrollChatToBottom();
}

function hideSearchStatus(aiMsgId) {
  const contentEl = document.getElementById('msg-content-' + aiMsgId);
  if (!contentEl) return;
  const el = contentEl.querySelector('.search-status');
  if (el) el.remove();
}

function appendSearchResultsCard(aiMsgId, results, query, type, engine, fallbackInfo) {
  const contentEl = document.getElementById('msg-content-' + aiMsgId);
  if (!contentEl || !results.length) return;
  const card = document.createElement('div');
  card.className = 'search-results-card';
  const saveId = uid();
  window['_ctxSearch_' + saveId] = { results, query };
  let engineTag = '';
  if (engine) {
    const engineColors = {
      'Google': '#4285f4', 'Google (SerpAPI)': '#4285f4', 'Brave': '#fb542b', 'arXiv API': '#b31b1b',
      'Semantic Scholar': '#1857b6', 'Google Scholar (SerpAPI)': '#1857b6', 'GitHub API': '#8b5cf6',
      'OpenAlex': '#e6553a', 'CrossRef': '#2a6496', 'Scholar (all failed)': '#888',
      'Wikipedia (en)': '#636466', 'Wikipedia (zh)': '#636466', 'Hacker News': '#ff6600',
      'PubMed': '#326295', 'Stack Overflow': '#f48024',
    };
    // Wikipedia / Stack Exchange 的 engine 名带站点后缀，做前缀回退
    const prefixColor = engine.startsWith('Wikipedia') ? '#636466'
      : (engine.startsWith('Stack Exchange') ? '#f48024' : null);
    const color = engineColors[engine] || prefixColor || 'var(--accent)';
    engineTag = `<span style="font-size:.65rem;padding:1px 6px;border-radius:4px;background:${color}22;color:${color};border:1px solid ${color}44;margin-left:6px;font-weight:600">${escHtml(engine)}</span>`;
    if (fallbackInfo) {
      engineTag += `<span style="font-size:.6rem;color:var(--warn);margin-left:4px" title="${escAttr(fallbackInfo)}">⚠️ fallback</span>`;
    }
  }
  let html = `<div class="search-results-header">🔍 搜索结果: "${escHtml(query)}" (${results.length}条)${engineTag} <button class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:.65rem" onclick="ctxSaveSearchById('${saveId}')">📚 收藏</button></div>`;
  for (const r of results.slice(0, 5)) {
    html += `<div class="search-result-item">`;
    /* link 来自第三方搜索接口，是纯外部输入：属性位置必须用 escAttr（escHtml 不转义
       引号，含双引号的值能突破属性边界），协议还要过白名单挡掉 javascript:。
       安全性校验不通过时降级为纯文本标题，不给出可点链接。 */
    const safeLink = (typeof safeUrl === 'function') ? safeUrl(r.link) : r.link;
    if (safeLink) html += `<a href="${escAttr(safeLink)}" target="_blank" rel="noopener noreferrer">${escHtml(r.title)}</a>`;
    else html += `<strong>${escHtml(r.title)}</strong>`;
    if (r.source) html += `<span class="source-tag">${escHtml(r.source)}</span>`;
    if (r.snippet) html += `<div class="snippet">${escHtml(r.snippet)}</div>`;
    html += `</div>`;
  }
  card.innerHTML = html;
  contentEl.appendChild(card);
  scrollChatToBottom();
}

function ctxSaveSearchById(saveId) {
  const data = window['_ctxSearch_' + saveId];
  if (data) ctxSaveFromSearch(data.results, data.query);
}

function appendFetchResultCard(aiMsgId, url, content) {
  const contentEl = document.getElementById('msg-content-' + aiMsgId);
  if (!contentEl) return;
  const card = document.createElement('div');
  card.className = 'search-results-card';
  const saveId = uid();
  window['_ctxFetch_' + saveId] = { url, content: content || '' };
  card.innerHTML = `<div class="search-results-header">🌐 已抓取网页 <button class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:.65rem" onclick="ctxSaveFetchById('${saveId}')">📚 收藏</button></div>
    <div class="search-result-item"><a href="${escAttr(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${escHtml(url)}</a>
    <div class="snippet">网页内容已提取并发送给模型分析</div></div>`;
  contentEl.appendChild(card);
  scrollChatToBottom();
}

function ctxSaveFetchById(saveId) {
  const data = window['_ctxFetch_' + saveId];
  if (data) ctxSaveFromFetch(data.url, data.content);
}

// ── 知识库检索结果卡片（ctx_search）──
function appendCtxSearchCard(aiMsgId, query, hits) {
  const contentEl = document.getElementById('msg-content-' + aiMsgId);
  if (!contentEl) return;
  const card = document.createElement('div');
  card.className = 'search-results-card';
  let html = `<div class="search-results-header">📖 知识库检索: "${escHtml(query)}" (${hits.length} 个片段)</div>`;
  if (!hits.length) {
    html += `<div class="search-result-item"><div class="snippet">未找到相关片段</div></div>`;
  } else {
    for (const h of hits.slice(0, 5)) {
      const preview = h.snippet.replace(/\s+/g, ' ').trim().slice(0, 180);
      html += `<div class="search-result-item"><strong>${escHtml(h.name)}</strong>
        <span class="source-tag">${h.from}-${h.to} / ${h.total}</span>
        <div class="snippet">${escHtml(preview)}</div></div>`;
    }
  }
  card.innerHTML = html;
  contentEl.appendChild(card);
  scrollChatToBottom();
}

// ── 自定义 HTTP 工具结果卡片 ──
function appendCustomToolCard(aiMsgId, tool, args, output) {
  const contentEl = document.getElementById('msg-content-' + aiMsgId);
  if (!contentEl) return;
  const card = document.createElement('div');
  card.className = 'search-results-card';
  const argsDesc = Object.entries(args || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  const preview = String(output || '').slice(0, 400);
  card.innerHTML = `<div class="search-results-header">🔧 ${escHtml(tool.name)}
      <span class="source-tag">${escHtml(tool.method)}</span></div>
    <div class="search-result-item">${argsDesc ? `<strong>${escHtml(argsDesc)}</strong>` : ''}
      <div class="snippet" style="white-space:pre-wrap">${escHtml(preview)}</div></div>`;
  contentEl.appendChild(card);
  scrollChatToBottom();
}

/* ── 长期记忆读写卡片 ──
   记忆是背后悄悄发生的写操作，用户必须看得见改了什么，
   所以每次 memory_write / memory_delete 都在消息里留一条可点开管理的痕迹。 */
function appendMemoryCard(aiMsgId, action, detail, output) {
  const contentEl = document.getElementById('msg-content-' + aiMsgId);
  if (!contentEl) return;
  const isZh = STATE.lang !== 'en';
  const card = document.createElement('div');
  card.className = 'search-results-card';
  const icon = action === 'delete' ? '🗑' : '🧠';
  const title = action === 'delete'
    ? (isZh ? '已删除一条长期记忆' : 'Deleted a memory entry')
    : (isZh ? '已更新长期记忆' : 'Long-term memory updated');
  card.innerHTML = `<div class="search-results-header">${icon} ${title}
      <button class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:.65rem"
        onclick="showMemoryModal()">${isZh ? '管理' : 'Manage'}</button></div>
    <div class="search-result-item"><div class="snippet">${escHtml(String(detail || '').slice(0, 300))}</div>
      <div class="snippet" style="color:var(--text3)">${escHtml(String(output || '').slice(0, 200))}</div></div>`;
  contentEl.appendChild(card);
  scrollChatToBottom();
}

/* ── 代码执行结果卡片（stdout / stderr / matplotlib 图表回显） ──
   renderChat() 会整体重绘 innerHTML 把卡片冲掉（现有搜索卡片就是这样丢的），
   所以按 msgId 记住卡片 HTML，由 reattachCodeResultCards() 在每次重绘后补回。
   仅存在于内存中：图表 base64 不写进 conv.tree，避免进 LLM 上下文和撑爆存储。 */
const _codeResultCards = {};

function appendCodeResultCard(aiMsgId, code, result, lang) {
  const contentEl = document.getElementById('msg-content-' + aiMsgId);
  if (!result) return;
  const card = document.createElement('div');
  card.className = 'code-result-card';
  const saveId = uid();
  window['_ctxCode_' + saveId] = { code, result };
  const icon = lang === 'python' ? '🐍' : '🟨';
  const title = lang === 'python' ? 'Python 执行结果' : 'JavaScript 执行结果';
  const badge = result.error
    ? `<span class="code-badge code-badge-fail">失败</span>`
    : `<span class="code-badge code-badge-ok">成功</span>`;
  let html = `<div class="search-results-header">${icon} ${title} ${badge}
    <button class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:.65rem" onclick="ctxSaveCodeById('${saveId}')">📚 收藏</button></div>`;
  html += `<details class="code-result-src"><summary>查看源码 (${(code || '').length} 字符)</summary><pre>${escHtml(code || '')}</pre></details>`;
  if (result.mounted && result.mounted.length) {
    html += `<div class="code-result-note">📂 已挂载缓存文件: ${escHtml(result.mounted.join(', '))} → /data/</div>`;
  }
  if (result.stdout) html += `<div class="code-result-sec"><span class="code-result-tag">stdout</span><pre>${escHtml(result.stdout)}</pre></div>`;
  if (result.stderr) html += `<div class="code-result-sec code-err"><span class="code-result-tag">stderr</span><pre>${escHtml(result.stderr)}</pre></div>`;
  if (result.result) html += `<div class="code-result-sec"><span class="code-result-tag">返回值</span><pre>${escHtml(String(result.result).slice(0, 3000))}</pre></div>`;
  if (result.error) html += `<div class="code-result-sec code-err"><span class="code-result-tag">错误</span><pre>${escHtml(result.error)}</pre></div>`;
  if (result.images && result.images.length) {
    html += `<div class="code-result-figs">`;
    for (const b64 of result.images) {
      const src = 'data:image/png;base64,' + String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
      html += `<img src="${src}" alt="matplotlib figure" onclick="viewImage(this.src)">`;
    }
    html += `</div>`;
  }
  card.innerHTML = html;
  if (!_codeResultCards[aiMsgId]) _codeResultCards[aiMsgId] = [];
  _codeResultCards[aiMsgId].push(html);
  if (!contentEl) return;
  contentEl.appendChild(card);
  scrollChatToBottom();
}

// renderChat() 重绘后把本会话内已产生的代码结果卡片补回消息气泡
function reattachCodeResultCards() {
  for (const [msgId, htmls] of Object.entries(_codeResultCards)) {
    const contentEl = document.getElementById('msg-content-' + msgId);
    if (!contentEl || contentEl.querySelector('.code-result-card')) continue;
    for (const html of htmls) {
      const card = document.createElement('div');
      card.className = 'code-result-card';
      card.innerHTML = html;
      contentEl.appendChild(card);
    }
  }
}

function ctxSaveCodeById(saveId) {
  const data = window['_ctxCode_' + saveId];
  if (!data) return;
  const r = data.result || {};
  const text = [`[代码]\n${data.code || ''}`,
    r.stdout ? `[stdout]\n${r.stdout}` : '',
    r.stderr ? `[stderr]\n${r.stderr}` : '',
    r.result ? `[返回值]\n${r.result}` : '',
    r.error ? `[错误]\n${r.error}` : ''].filter(Boolean).join('\n\n');
  ctxAddItem({ type: 'text', name: `代码执行: ${(data.code || '').trim().slice(0, 40)}`, source: 'code', content: text });
}

// ── 清理历史遗留的标签式指令标记（原生 function calling 下模型不再输出这些标签，
//    但旧对话或个别模型仍可能残留，保留此清理逻辑以兼容显示） ──
function cleanSearchMarkers(text) {
  const searchTypes = ['SEARCH', 'SEARCH_ARXIV', 'SEARCH_SCHOLAR', 'SEARCH_GITHUB', 'SEARCH_GOOGLE'];
  for (const tag of searchTypes) {
    text = text.replace(new RegExp(`\\[${tag}\\]\\s*([\\s\\S]*?)\\s*\\[\\/${tag}\\]`, 'gi'), (_, query) => `🔍 *已搜索: "${query.trim()}"*`);
    text = text.replace(new RegExp(`\\[${tag}\\]\\s*([\\s\\S]*?)\\s*(?:\\[\\\\${tag}\\]|\\[${tag}\\/\\])`, 'gi'), (_, query) => query.trim() ? `🔍 *已搜索: "${query.trim()}"*` : '');
    text = text.replace(new RegExp(`\\[${tag}\\]\\s*([^\\[\\]]+?)(?:\\s*$|\\s*(?=\\[))`, 'gim'), (_, query) => query.trim() ? `🔍 *已搜索: "${query.trim()}"*` : '');
    text = text.replace(new RegExp(`\\[\\/${tag}\\]`, 'gi'), '');
  }
  text = text.replace(/\[FETCH\]\s*([\s\S]*?)\s*\[\/FETCH\]/gi, (_, url) => `🌐 *已抓取: ${url.trim()}*`);
  text = text.replace(/\[FETCH\]\s*([^\[\]]+?)(?:\s*$|\s*(?=\[))/gim, (_, url) => url.trim() ? `🌐 *已抓取: ${url.trim()}*` : '');
  text = text.replace(/\[\/FETCH\]/gi, '');
  text = text.replace(/\[CTX_READ\]\s*([\s\S]*?)\s*\[\/CTX_READ\]/gi, (_, id) => `📖 *已读取缓存: ${id.trim()}*`);
  text = text.replace(/\[CTX_READ\]\s*([^\[\]]+?)(?:\s*$|\s*(?=\[))/gim, (_, id) => id.trim() ? `📖 *已读取缓存: ${id.trim()}*` : '');
  text = text.replace(/\[\/CTX_READ\]/gi, '');
  text = text.replace(/\[CTX_DELETE\]\s*([\s\S]*?)\s*\[\/CTX_DELETE\]/gi, (_, id) => `🗑 *已删除缓存: ${id.trim()}*`);
  text = text.replace(/\[CTX_DELETE\]\s*([^\[\]]+?)(?:\s*$|\s*(?=\[))/gim, (_, id) => id.trim() ? `🗑 *已删除缓存: ${id.trim()}*` : '');
  text = text.replace(/\[\/CTX_DELETE\]/gi, '');
  return text;
}
