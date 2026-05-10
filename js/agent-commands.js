/* ============================================================
   ETA (Edge Thin Agent) — Agent Command Execution & Search UI Helpers
   ============================================================ */

// ── 执行 Agent 搜索/抓取指令 ──
async function executeAgentCommands(agentCmds, aiMsgId, conv, searchRound, extraMessages) {
  const roundSignal = STATE.abortCtrl?.signal;
  const PER_CMD_TIMEOUT = 30000;
  const ROUND_TIMEOUT = 60000;
  console.log(`[Agent 循环] 第 ${searchRound} 轮: 开始执行 ${agentCmds.length} 条搜索/抓取指令`);

  const cmdPromises = agentCmds.map(async (cmd, idx) => {
    const cmdCtrl = new AbortController();
    const cmdSignal = cmdCtrl.signal;
    if (roundSignal) {
      if (roundSignal.aborted) cmdCtrl.abort();
      else roundSignal.addEventListener('abort', () => cmdCtrl.abort(), { once: true });
    }
    const cmdTimer = setTimeout(() => {
      console.warn(`[搜索 #${idx}] 单条指令超时 (${PER_CMD_TIMEOUT}ms), 类型=${cmd.type}`);
      cmdCtrl.abort();
    }, PER_CMD_TIMEOUT);
    try {
      return await executeSingleCommand(cmd, idx, aiMsgId, cmdSignal);
    } catch (cmdErr) {
      const label = cmd.type === 'fetch' ? cmd.url : cmd.query;
      console.warn(`[搜索 #${idx}] ${cmd.type} 异常: ${cmdErr.message}`);
      return { role: 'user', content: `[${cmd.type} 超时/失败: ${(label||'').slice(0,60)}]` };
    } finally {
      clearTimeout(cmdTimer);
    }
  });

  let roundTimerId;
  const roundCtrl = new AbortController();
  const roundTimeout = new Promise(resolve => {
    roundTimerId = setTimeout(() => {
      console.warn(`[Agent 循环] 第 ${searchRound} 轮: 整轮兜底超时 (${ROUND_TIMEOUT}ms)`);
      roundCtrl.abort();
      resolve('__ROUND_TIMEOUT__');
    }, ROUND_TIMEOUT);
  });
  console.log(`[Agent 循环] 第 ${searchRound} 轮: 等待 allSettled (${agentCmds.length} 条指令)`);
  const settled = await Promise.race([Promise.allSettled(cmdPromises), roundTimeout]);
  clearTimeout(roundTimerId);

  if (settled === '__ROUND_TIMEOUT__') {
    const partial = await Promise.allSettled(cmdPromises);
    const fulfilled = partial.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failedCount = partial.filter(r => r.status === 'rejected').length;
    console.warn(`[Agent 循环] 第 ${searchRound} 轮: 兜底超时后收集到 ${fulfilled.length} 条结果, ${failedCount} 条失败`);
    extraMessages.push(...fulfilled);
    if (failedCount > 0) extraMessages.push({ role: 'user', content: `[${failedCount} 条指令超时/失败，已跳过]` });
  } else {
    const results = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failedCount = settled.filter(r => r.status === 'rejected').length;
    extraMessages.push(...results);
    if (failedCount > 0) extraMessages.push({ role: 'user', content: `[${failedCount} 条指令执行失败，已跳过]` });
    console.log(`[Agent 循环] 第 ${searchRound} 轮: allSettled 完成`);
  }

  // 过滤空值
  const filtered = extraMessages.filter(Boolean);
  extraMessages.length = 0;
  extraMessages.push(...filtered);

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
      extraMessages.splice(i + 1);
      extraMessages.push({ role: 'user', content: '[部分搜索结果因总量过大已省略]' });
      break;
    }
  }
  hideSearchStatus(aiMsgId);
  console.log(`[Agent 循环] 第 ${searchRound} 轮: 搜索/抓取完成, extraMessages: ${extraMessages.length} 条`);

  // 检测连续空结果
  const hasUsefulResult = extraMessages.some(m => m.content && m.content.length > 200 && !m.content.startsWith('['));
  if (!hasUsefulResult) {
    console.warn(`[Agent 循环] 第 ${searchRound} 轮: 无有效搜索结果`);
  }

  // 根据是否有有效结果，给出不同的提示
  if (hasUsefulResult) {
    extraMessages.push({
      role: 'user',
      content: 'Above are the tool execution results. Please answer the user\'s question directly based on these results. If the information is insufficient, you may use [SEARCH] or [FETCH] tools again, but do NOT repeat any tool call you have already made.',
    });
  } else {
    extraMessages.push({
      role: 'user',
      content: '[系统提示] 本轮工具调用未返回有效结果。请直接基于你已有的知识和之前获取的信息回答用户问题。不要再重复相同的搜索或抓取操作。如果确实需要更多信息，请尝试完全不同的搜索关键词或不同的搜索工具。',
    });
  }
}

// ── 执行单条指令 ──
async function executeSingleCommand(cmd, idx, aiMsgId, cmdSignal) {
  if (cmd.type === 'search') {
    showSearchStatus(aiMsgId, 'search', cmd.query);
    console.log(`[搜索 #${idx}] search: "${cmd.query}" 开始`);
    const result = await doGoogleSearch(cmd.query, undefined, cmdSignal);
    console.log(`[搜索 #${idx}] search: "${cmd.query}" 完成`);
    if (result.error) return { role: 'user', content: `[Search error (${result.engine || '?'}): ${result.error}]` };
    appendSearchResultsCard(aiMsgId, result.results, cmd.query, 'search', result.engine, result.fallback ? result.fallbackReason : null);
    ctxAutoSaveSearch(result.results, cmd.query, 'search');
    return { role: 'user', content: formatSearchResultsForLLM(result.results, cmd.query) };
  }
  if (cmd.type === 'search_arxiv') {
    showSearchStatus(aiMsgId, 'search', `arXiv: ${cmd.query}`);
    const result = await doArxivSearch(cmd.query, undefined, cmdSignal);
    if (result.error) return { role: 'user', content: `[arXiv search error: ${result.error}]` };
    appendSearchResultsCard(aiMsgId, result.results, `arXiv: ${cmd.query}`, 'search', result.engine);
    ctxAutoSaveSearch(result.results, `arXiv: ${cmd.query}`, 'search');
    return { role: 'user', content: formatSearchResultsForLLM(result.results, `arXiv: ${cmd.query}`) };
  }
  if (cmd.type === 'search_scholar') {
    showSearchStatus(aiMsgId, 'search', `Scholar: ${cmd.query}`);
    const result = await doScholarSearch(cmd.query, undefined, cmdSignal);
    if (result.error) return { role: 'user', content: `[Scholar search error: ${result.error}]` };
    appendSearchResultsCard(aiMsgId, result.results, `Scholar: ${cmd.query}`, 'search', result.engine);
    ctxAutoSaveSearch(result.results, `Scholar: ${cmd.query}`, 'search');
    return { role: 'user', content: formatSearchResultsForLLM(result.results, `Scholar: ${cmd.query}`) };
  }
  if (cmd.type === 'search_github') {
    showSearchStatus(aiMsgId, 'search', `GitHub: ${cmd.query}`);
    const result = await doGithubSearch(cmd.query, undefined, cmdSignal);
    if (result.error) return { role: 'user', content: `[GitHub search error: ${result.error}]` };
    appendSearchResultsCard(aiMsgId, result.results, `GitHub: ${cmd.query}`, 'search', result.engine);
    ctxAutoSaveSearch(result.results, `GitHub: ${cmd.query}`, 'search');
    return { role: 'user', content: formatSearchResultsForLLM(result.results, `GitHub: ${cmd.query}`) };
  }
  if (cmd.type === 'search_google') {
    showSearchStatus(aiMsgId, 'search', `Google: ${cmd.query}`);
    const result = await doGoogleSearch(cmd.query, undefined, cmdSignal);
    if (result.error) return { role: 'user', content: `[Google search error (${result.engine || '?'}): ${result.error}]` };
    appendSearchResultsCard(aiMsgId, result.results, `Google: ${cmd.query}`, 'search', result.engine, result.fallback ? result.fallbackReason : null);
    ctxAutoSaveSearch(result.results, `Google: ${cmd.query}`, 'search');
    return { role: 'user', content: formatSearchResultsForLLM(result.results, `Google: ${cmd.query}`) };
  }
  if (cmd.type === 'fetch') {
    showSearchStatus(aiMsgId, 'fetch', cmd.url);
    const result = await fetchWebPage(cmd.url, cmdSignal);
    if (result.error) return { role: 'user', content: `[Fetch error: ${result.error}]` };
    appendFetchResultCard(aiMsgId, cmd.url, result.content);
    ctxAutoSaveFetch(cmd.url, result.content);
    return { role: 'user', content: result.content };
  }
  if (cmd.type === 'ctx_read') {
    const buf = getCtxBuffer();
    const item = buf.find(i => i.id === cmd.id);
    if (!item) return { role: 'user', content: `[缓存读取失败: ID=${cmd.id} 不存在]` };
    showSearchStatus(aiMsgId, 'fetch', `读取缓存: ${item.name}`);
    item.readCount = (item.readCount || 0) + 1;
    item.readThisTurn = true;
    saveState(); renderCtxBuffer();
    let content = item.content;
    if (content.length > 15000) content = content.slice(0, 15000) + `\n\n[...已截断，原始 ${item.content.length} 字符]`;
    return { role: 'user', content: `[缓存内容: ${item.name}]\n${content}` };
  }
  if (cmd.type === 'ctx_delete') {
    const conv = getActiveConv();
    if (conv) {
      const buf = conv.ctxBuffer || [];
      const idx2 = buf.findIndex(i => i.id === cmd.id);
      if (idx2 !== -1) {
        const name = buf[idx2].name;
        buf.splice(idx2, 1);
        saveState(); renderCtxBuffer(); updateCtxBtnBadge();
        return { role: 'user', content: `[已删除缓存: ${name}]` };
      }
    }
    return { role: 'user', content: `[缓存删除失败: ID=${cmd.id} 不存在]` };
  }
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

// ── 清理搜索指令标记 ──
function cleanDisplayCmds(display) {
  display = display.replace(/\[SEARCH(?:_ARXIV|_SCHOLAR|_GITHUB|_GOOGLE)?\][\s\S]*?\[\/SEARCH(?:_ARXIV|_SCHOLAR|_GITHUB|_GOOGLE)?\]/gi, '\n\n🔍 *正在搜索...*\n\n');
  display = display.replace(/\[FETCH\][\s\S]*?\[\/FETCH\]/gi, '\n\n🌐 *正在抓取网页...*\n\n');
  display = display.replace(/\[CTX_READ\][\s\S]*?\[\/CTX_READ\]/gi, '\n\n📖 *正在读取缓存...*\n\n');
  display = display.replace(/\[CTX_DELETE\][\s\S]*?\[\/CTX_DELETE\]/gi, '\n\n🗑 *正在清理缓存...*\n\n');
  display = display.replace(/\[SEARCH(?:_ARXIV|_SCHOLAR|_GITHUB|_GOOGLE)?\][^\[]*$/gim, '\n\n🔍 *正在准备搜索...*');
  display = display.replace(/\[FETCH\][^\[]*$/gim, '\n\n🌐 *正在准备抓取...*');
  display = display.replace(/\[CTX_READ\][^\[]*$/gim, '\n\n📖 *正在读取缓存...*');
  display = display.replace(/\[CTX_DELETE\][^\[]*$/gim, '\n\n🗑 *正在清理缓存...*');
  display = display.replace(/\[SEARCH(?:_ARXIV|_SCHOLAR|_GITHUB|_GOOGLE)?\][^\[]*(?=\[)/gi, '\n\n🔍 *正在搜索...*\n\n');
  display = display.replace(/\[FETCH\][^\[]*(?=\[)/gi, '\n\n🌐 *正在抓取网页...*\n\n');
  display = display.replace(/\[CTX_READ\][^\[]*(?=\[)/gi, '\n\n📖 *正在读取缓存...*\n\n');
  display = display.replace(/\[CTX_DELETE\][^\[]*(?=\[)/gi, '\n\n🗑 *正在清理缓存...*\n\n');
  display = display.replace(/\[\/(SEARCH|SEARCH_ARXIV|SEARCH_SCHOLAR|SEARCH_GITHUB|SEARCH_GOOGLE|FETCH|CTX_READ|CTX_DELETE)\]/gi, '');
  return display;
}

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
