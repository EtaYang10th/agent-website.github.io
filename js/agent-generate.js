/* ============================================================
   ETA (Edge Thin Agent) — doGenerate Main Loop
   ============================================================ */

async function doGenerate(conv, userMsgId) {
  const cfg = getConfig();
  STATE.generating = true;
  STATE.abortCtrl = new AbortController();
  updateSendBtn();

  const aiMsgId = addMessageToTree(conv, userMsgId, 'assistant', '', cfg.model, []);
  saveState();
  renderChat();

  let searchRound = 0;
  const MAX_SEARCH_ROUNDS = 20;
  let accumulatedContent = '';
  let extraMessages = [];
  let consecutiveEmptyRounds = 0;
  let consecutiveDupRounds = 0;  // 连续重复指令计数
  const globalSeenCmds = new Set(); // 跨轮指令去重

  try {
  while (searchRound <= MAX_SEARCH_ROUNDS) {
    const messages = buildApiMessages(conv, userMsgId);
    if (accumulatedContent || extraMessages.length) {
      if (accumulatedContent) messages.push({ role: 'assistant', content: accumulatedContent });
      for (const em of extraMessages) messages.push(em);
    }

    const totalMsgChars = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
    console.log(`[Agent 循环] 第 ${searchRound} 轮, messages: ${messages.length} 条, 总字符: ${totalMsgChars}, extraMessages: ${extraMessages.length} 条`);
    if (searchRound > 0) {
      showSearchStatus(aiMsgId, 'search', `第 ${searchRound + 1} 轮分析中 (上下文 ${Math.round(totalMsgChars/1000)}k 字符)...`);
    }
    if (totalMsgChars > 120000) {
      console.warn(`Agent 循环第 ${searchRound} 轮: messages 总字符数 ${totalMsgChars}，触发 LLM 总结压缩`);
      showSearchStatus(aiMsgId, 'search', '正在压缩上下文...');
      try {
        const summary = await summarizeContext(cfg, messages);
        const sysMsg = messages[0]?.role === 'system' ? messages[0] : null;
        const userMsg = messages.find(m => m.role === 'user' && !m.content?.startsWith?.('['));
        messages.length = 0;
        if (sysMsg) messages.push(sysMsg);
        if (userMsg) messages.push(userMsg);
        messages.push({ role: 'assistant', content: summary });
        for (const em of extraMessages) messages.push(em);
        accumulatedContent = summary;
        conv.tree[aiMsgId].content = summary;
        renderChat();
        console.log(`上下文压缩完成: ${totalMsgChars} → ${summary.length} 字符`);
      } catch (sumErr) {
        console.warn('LLM 总结失败，回退到硬截断:', sumErr.message);
        const sysMsg = messages[0]?.role === 'system' ? messages.shift() : null;
        const kept = messages.slice(-6);
        messages.length = 0;
        if (sysMsg) messages.push(sysMsg);
        messages.push({ role: 'user', content: '[注意：上下文过长且总结失败，中间内容已省略。请基于最近的搜索结果继续回答。]' });
        for (const m of kept) messages.push(m);
      }
      hideSearchStatus(aiMsgId);
    }

    const url = joinUrl(cfg.baseUrl, 'chat/completions');
    const isThinkingModel = /thinking|think/i.test(cfg.model);
    if (isThinkingModel && messages.length > 0 && messages[0].role === 'system') {
      const thinkInject = '\n\n[IMPORTANT] You MUST wrap your internal reasoning inside <think>...</think> tags BEFORE your final answer. Always output <think> first, write your full chain-of-thought inside, then close with </think>, and only then write your actual response. Never skip the <think> block.';
      messages[0].content += thinkInject;
    } else if (isThinkingModel) {
      messages.unshift({ role: 'system', content: '[IMPORTANT] You MUST wrap your internal reasoning inside <think>...</think> tags BEFORE your final answer. Always output <think> first, write your full chain-of-thought inside, then close with </think>, and only then write your actual response. Never skip the <think> block.' });
    }
    const body = {
      model: cfg.model, messages,
      temperature: isThinkingModel ? 1 : cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    let apiTimedOut = false;
    let apiTimeoutId;
    try {
      const API_CALL_TIMEOUT = 120000;
      apiTimeoutId = setTimeout(() => {
        apiTimedOut = true;
        if (STATE.abortCtrl) STATE.abortCtrl.abort();
      }, API_CALL_TIMEOUT);

      console.log(`[Agent 循环] 第 ${searchRound} 轮: 发送 API 请求, body 大小: ${JSON.stringify(body).length} 字符`);
      const resp = await fetch(url, {
        method: 'POST', headers: headers(cfg.apiKey),
        body: JSON.stringify(body), signal: STATE.abortCtrl.signal,
      });

      clearTimeout(apiTimeoutId);
      console.log(`[Agent 循环] 第 ${searchRound} 轮: API 响应 status=${resp.status}`);

      if (!resp.ok) {
        const errText = await resp.text();
        const errData = safeJson(errText);
        const errMsg = errData?.error?.message || errText;
        conv.tree[aiMsgId].content += `\n⚠️ 错误 (HTTP ${resp.status}): ${errMsg}`;
        toast(`API 错误 (${resp.status})`, 'fail');
        renderChat();
        break;
      }

      let newContent = await handleStreamResponseAgent(resp, conv, aiMsgId);
      console.log(`[Agent 循环] 第 ${searchRound} 轮: 流式读取完成, newContent 长度: ${newContent.length}`);

      const agentCmds = parseAgentCommands(newContent);
      console.log(`[Agent 循环] 第 ${searchRound} 轮: 解析到 ${agentCmds.length} 条指令`, agentCmds.map(c => `${c.type}:${c.query||c.url||c.id||'?'}`));
      if (!agentCmds.length || !STATE.searchMode || !$('cfgSearchEnabled').checked) {
        console.log(`[Agent 循环] 第 ${searchRound} 轮: 无指令或搜索未启用，退出循环`);
        break;
      }

      // 跨轮去重：过滤掉之前已经执行过的完全相同的指令
      const dedupedCmds = agentCmds.filter(cmd => {
        const key = `${cmd.type}:${cmd.query || cmd.url || cmd.id || ''}`;
        if (globalSeenCmds.has(key)) {
          console.warn(`[Agent 循环] 跳过重复指令: ${key}`);
          return false;
        }
        globalSeenCmds.add(key);
        return true;
      });
      if (!dedupedCmds.length) {
        consecutiveDupRounds++;
        console.warn(`[Agent 循环] 第 ${searchRound} 轮: 所有指令均为重复 (连续第 ${consecutiveDupRounds} 次)`);
        if (consecutiveDupRounds >= 2) {
          console.warn(`[Agent 循环] 连续 ${consecutiveDupRounds} 轮重复指令，强制退出循环`);
          break;
        }
        extraMessages.push({ role: 'user', content: '[系统提示] 你发出的所有工具调用都已经在之前的轮次中执行过了，请直接基于已有结果回答用户问题，不要再重复调用工具。' });
        // 再做一次 API 调用让 AI 基于已有信息回答
        searchRound++;
        accumulatedContent = conv.tree[aiMsgId].content;
        continue;
      }
      consecutiveDupRounds = 0; // 有新指令，重置计数

      const firstCmdMatch = newContent.match(/\[(SEARCH|SEARCH_ARXIV|SEARCH_SCHOLAR|SEARCH_GITHUB|SEARCH_GOOGLE|FETCH|CTX_READ|CTX_DELETE)\]/i);
      let contentBeforeCmds = '';
      if (firstCmdMatch) contentBeforeCmds = newContent.slice(0, firstCmdMatch.index).trim();
      conv.tree[aiMsgId].content = (accumulatedContent ? accumulatedContent : '') + (contentBeforeCmds ? contentBeforeCmds + '\n\n' : '');
      renderChat();

      searchRound++;
      accumulatedContent = conv.tree[aiMsgId].content;
      extraMessages = [];

      // 执行搜索/抓取指令
      await executeAgentCommands(dedupedCmds, aiMsgId, conv, searchRound, extraMessages);

      // 检测连续空结果，超过 3 轮强制退出
      const hasUseful = extraMessages.some(m => m.content && m.content.length > 200 && !m.content.startsWith('['));
      if (!hasUseful) {
        consecutiveEmptyRounds++;
        if (consecutiveEmptyRounds >= 3) {
          console.warn(`[Agent 循环] 连续 ${consecutiveEmptyRounds} 轮无有效结果，强制退出`);
          extraMessages.push({ role: 'user', content: '[系统强制提示] 已连续多轮搜索无有效结果。请立即停止所有工具调用，直接基于已有信息回答用户问题。' });
          // 最后一次 API 调用让 AI 总结回答
          searchRound++;
          accumulatedContent = conv.tree[aiMsgId].content;
          continue;
        }
      } else {
        consecutiveEmptyRounds = 0;
      }

    } catch (e) {
      clearTimeout(apiTimeoutId);
      if (e.name === 'AbortError') {
        if (apiTimedOut) {
          conv.tree[aiMsgId].content += '\n\n⚠️ API 请求超时（120秒无响应），可能是上下文过长或服务端繁忙';
          toast('API 请求超时', 'fail');
          STATE.abortCtrl = new AbortController();
        } else {
          conv.tree[aiMsgId].content += '\n\n[已停止生成]';
          toast('已停止生成', 'info');
        }
      } else {
        conv.tree[aiMsgId].content += `\n⚠️ 请求错误: ${e.message}`;
        toast(`请求错误: ${e.message}`, 'fail');
      }
      renderChat();
      break;
    }
  }

  // ── 循环退出后：如果搜索了多轮但最终没有有效输出，强制做一次总结调用 ──
  if (searchRound > 0 && STATE.generating && extraMessages.length > 0) {
    const currentContent = (conv.tree[aiMsgId].content || '').trim();
    const hasSubstantiveAnswer = currentContent.length > 300 &&
      !/\[系统提示\]|⚠️|已停止生成/.test(currentContent.slice(-200));
    if (!hasSubstantiveAnswer) {
      console.log(`[Agent 循环] 循环退出但无有效输出 (content=${currentContent.length}字符, rounds=${searchRound}), 执行最终总结调用`);
      showSearchStatus(aiMsgId, 'search', '正在基于已收集信息生成回答...');
      try {
        const finalMessages = buildApiMessages(conv, userMsgId);
        if (accumulatedContent) finalMessages.push({ role: 'assistant', content: accumulatedContent });
        for (const em of extraMessages) finalMessages.push(em);
        finalMessages.push({ role: 'user', content: '[系统强制指令] 你已经完成了所有搜索和资料收集。现在必须立即基于已收集的所有信息，直接回答用户的问题。禁止再使用任何工具调用（SEARCH/FETCH/CTX_READ等）。请给出完整、详细、有条理的回答。' });
        const finalUrl = joinUrl(cfg.baseUrl, 'chat/completions');
        const finalBody = {
          model: cfg.model, messages: finalMessages,
          temperature: cfg.temperature, max_tokens: cfg.maxTokens,
          stream: true, stream_options: { include_usage: true },
        };
        STATE.abortCtrl = new AbortController();
        const finalResp = await fetch(finalUrl, {
          method: 'POST', headers: headers(cfg.apiKey),
          body: JSON.stringify(finalBody), signal: STATE.abortCtrl.signal,
        });
        if (finalResp.ok) {
          conv.tree[aiMsgId].content = accumulatedContent || '';
          await handleStreamResponseAgent(finalResp, conv, aiMsgId);
        } else {
          console.warn(`[Agent 循环] 最终总结调用失败: HTTP ${finalResp.status}`);
        }
      } catch (finalErr) {
        if (finalErr.name !== 'AbortError') {
          console.warn('[Agent 循环] 最终总结调用异常:', finalErr.message);
        }
      }
      hideSearchStatus(aiMsgId);
    }
  }

  } catch (outerErr) {
    console.error('doGenerate 未预期错误:', outerErr);
    if (conv.tree[aiMsgId]) conv.tree[aiMsgId].content += `\n⚠️ 未预期错误: ${outerErr.message}`;
    toast(`生成出错: ${outerErr.message}`, 'fail');
  } finally {
    hideSearchStatus(aiMsgId);
    STATE.generating = false;
    STATE.abortCtrl = null;
    updateSendBtn();
  }

  conv.tree[aiMsgId].content = cleanSearchMarkers(conv.tree[aiMsgId].content);
  saveState();
  renderChat();
}
