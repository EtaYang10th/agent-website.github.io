/* ============================================================
   ETA (Edge Thin Agent) — Agent Command Execution & Search UI Helpers
   ============================================================ */

// ── 执行 Agent 工具调用（原生 tool_calls）──
// 关键约束：每个 tool_call 必须返回且仅返回一条 { role:'tool', tool_call_id } 消息，
// 否则 OpenAI 兼容接口会因 tool_calls 与 tool 消息不匹配而报错。
async function executeAgentCommands(agentCmds, aiMsgId, conv, searchRound, extraMessages) {
  const roundSignal = STATE.abortCtrl?.signal;
  const PER_CMD_TIMEOUT = 30000;
  const ROUND_TIMEOUT = 60000;
  console.log(`[Agent 循环] 第 ${searchRound} 轮: 开始执行 ${agentCmds.length} 条工具调用`);

  const toolMsg = (cmd, content) => ({ role: 'tool', tool_call_id: cmd.toolCallId, name: cmd.toolName, content });

  const cmdPromises = agentCmds.map(async (cmd, idx) => {
    const cmdCtrl = new AbortController();
    const cmdSignal = cmdCtrl.signal;
    if (roundSignal) {
      if (roundSignal.aborted) cmdCtrl.abort();
      else roundSignal.addEventListener('abort', () => cmdCtrl.abort(), { once: true });
    }
    const cmdTimer = setTimeout(() => {
      console.warn(`[工具 #${idx}] 单条调用超时 (${PER_CMD_TIMEOUT}ms), 类型=${cmd.type}`);
      cmdCtrl.abort();
    }, PER_CMD_TIMEOUT);
    try {
      const content = await executeSingleCommand(cmd, idx, aiMsgId, cmdSignal);
      return toolMsg(cmd, content);
    } catch (cmdErr) {
      const label = cmd.type === 'fetch' ? cmd.url : (cmd.query || cmd.id);
      console.warn(`[工具 #${idx}] ${cmd.type} 异常: ${cmdErr.message}`);
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
  console.log(`[Agent 循环] 第 ${searchRound} 轮: 等待 allSettled (${agentCmds.length} 条工具调用)`);
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
    console.log(`[Agent 循环] 第 ${searchRound} 轮: allSettled 完成`);
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
async function executeSingleCommand(cmd, idx, aiMsgId, cmdSignal) {
  if (cmd.type === 'search') {
    showSearchStatus(aiMsgId, 'search', cmd.query);
    console.log(`[搜索 #${idx}] search: "${cmd.query}" 开始`);
    const result = await doGoogleSearch(cmd.query, undefined, cmdSignal);
    console.log(`[搜索 #${idx}] search: "${cmd.query}" 完成`);
    if (result.error) return `[Search error (${result.engine || '?'}): ${result.error}]`;
    appendSearchResultsCard(aiMsgId, result.results, cmd.query, 'search', result.engine, result.fallback ? result.fallbackReason : null);
    ctxAutoSaveSearch(result.results, cmd.query, 'search');
    return formatSearchResultsForLLM(result.results, cmd.query);
  }
  if (cmd.type === 'search_arxiv') {
    showSearchStatus(aiMsgId, 'search', `arXiv: ${cmd.query}`);
    const result = await doArxivSearch(cmd.query, undefined, cmdSignal);
    if (result.error) return `[arXiv search error: ${result.error}]`;
    appendSearchResultsCard(aiMsgId, result.results, `arXiv: ${cmd.query}`, 'search', result.engine);
    ctxAutoSaveSearch(result.results, `arXiv: ${cmd.query}`, 'search');
    return formatSearchResultsForLLM(result.results, `arXiv: ${cmd.query}`);
  }
  if (cmd.type === 'search_scholar') {
    showSearchStatus(aiMsgId, 'search', `Scholar: ${cmd.query}`);
    const result = await doScholarSearch(cmd.query, undefined, cmdSignal);
    if (result.error) return `[Scholar search error: ${result.error}]`;
    appendSearchResultsCard(aiMsgId, result.results, `Scholar: ${cmd.query}`, 'search', result.engine);
    ctxAutoSaveSearch(result.results, `Scholar: ${cmd.query}`, 'search');
    return formatSearchResultsForLLM(result.results, `Scholar: ${cmd.query}`);
  }
  if (cmd.type === 'search_github') {
    showSearchStatus(aiMsgId, 'search', `GitHub: ${cmd.query}`);
    const result = await doGithubSearch(cmd.query, undefined, cmdSignal);
    if (result.error) return `[GitHub search error: ${result.error}]`;
    appendSearchResultsCard(aiMsgId, result.results, `GitHub: ${cmd.query}`, 'search', result.engine);
    ctxAutoSaveSearch(result.results, `GitHub: ${cmd.query}`, 'search');
    return formatSearchResultsForLLM(result.results, `GitHub: ${cmd.query}`);
  }
  if (cmd.type === 'search_google') {
    showSearchStatus(aiMsgId, 'search', `Google: ${cmd.query}`);
    const result = await doGoogleSearch(cmd.query, undefined, cmdSignal);
    if (result.error) return `[Google search error (${result.engine || '?'}): ${result.error}]`;
    appendSearchResultsCard(aiMsgId, result.results, `Google: ${cmd.query}`, 'search', result.engine, result.fallback ? result.fallbackReason : null);
    ctxAutoSaveSearch(result.results, `Google: ${cmd.query}`, 'search');
    return formatSearchResultsForLLM(result.results, `Google: ${cmd.query}`);
  }
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
    let content = item.content;
    if (content.length > 15000) content = content.slice(0, 15000) + `\n\n[...已截断，原始 ${item.content.length} 字符]`;
    return `[缓存内容: ${item.name}]\n${content}`;
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
  const icon = type === 'fetch' ? '🌐' : '🔍';
  const label = type === 'fetch' ? '正在抓取网页' : '正在搜索';
  const div = document.createElement('div');
  div.className = 'search-status';
  div.innerHTML = `<div class="search-spinner"></div>${icon} ${label}: "${escHtml(detail)}"...`;
  contentEl.appendChild(div);
  $('chatArea').scrollTop = $('chatArea').scrollHeight;
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
    };
    const color = engineColors[engine] || 'var(--accent)';
    engineTag = `<span style="font-size:.65rem;padding:1px 6px;border-radius:4px;background:${color}22;color:${color};border:1px solid ${color}44;margin-left:6px;font-weight:600">${escHtml(engine)}</span>`;
    if (fallbackInfo) {
      engineTag += `<span style="font-size:.6rem;color:var(--warn);margin-left:4px" title="${escHtml(fallbackInfo)}">⚠️ fallback</span>`;
    }
  }
  let html = `<div class="search-results-header">🔍 搜索结果: "${escHtml(query)}" (${results.length}条)${engineTag} <button class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:.65rem" onclick="ctxSaveSearchById('${saveId}')">📚 收藏</button></div>`;
  for (const r of results.slice(0, 5)) {
    html += `<div class="search-result-item">`;
    if (r.link) html += `<a href="${escHtml(r.link)}" target="_blank">${escHtml(r.title)}</a>`;
    else html += `<strong>${escHtml(r.title)}</strong>`;
    if (r.source) html += `<span class="source-tag">${escHtml(r.source)}</span>`;
    if (r.snippet) html += `<div class="snippet">${escHtml(r.snippet)}</div>`;
    html += `</div>`;
  }
  card.innerHTML = html;
  contentEl.appendChild(card);
  $('chatArea').scrollTop = $('chatArea').scrollHeight;
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
    <div class="search-result-item"><a href="${escHtml(url)}" target="_blank">${escHtml(url)}</a>
    <div class="snippet">网页内容已提取并发送给模型分析</div></div>`;
  contentEl.appendChild(card);
  $('chatArea').scrollTop = $('chatArea').scrollHeight;
}

function ctxSaveFetchById(saveId) {
  const data = window['_ctxFetch_' + saveId];
  if (data) ctxSaveFromFetch(data.url, data.content);
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
