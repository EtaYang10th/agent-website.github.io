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
  // convoTail: 本轮生成过程中追加到对话末尾的消息（assistant(tool_calls) 与 tool 结果交替）
  let convoTail = [];
  let consecutiveEmptyRounds = 0;
  let consecutiveDupRounds = 0;  // 连续重复指令计数
  const globalSeenCmds = new Set(); // 跨轮指令去重

  try {
  while (searchRound <= MAX_SEARCH_ROUNDS) {
    const messages = buildApiMessages(conv, userMsgId);
    for (const em of convoTail) messages.push(em);

    const totalMsgChars = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
    console.log(`[Agent 循环] 第 ${searchRound} 轮, messages: ${messages.length} 条, 总字符: ${totalMsgChars}, convoTail: ${convoTail.length} 条`);
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
        // 压缩后丢弃未完成的 tool_calls 尾巴（总结已包含其信息），避免 tool 消息失配
        convoTail = [];
        accumulatedContent = summary;
        conv.tree[aiMsgId].content = summary;
        renderChat();
        console.log(`上下文压缩完成: ${totalMsgChars} → ${summary.length} 字符`);
      } catch (sumErr) {
        console.warn('LLM 总结失败，回退到硬截断:', sumErr.message);
        const sysMsg = messages[0]?.role === 'system' ? messages.shift() : null;
        const userMsg = messages.find(m => m.role === 'user' && !m.content?.startsWith?.('['));
        messages.length = 0;
        if (sysMsg) messages.push(sysMsg);
        if (userMsg) messages.push(userMsg);
        messages.push({ role: 'user', content: '[注意：上下文过长且总结失败，中间内容已省略。请基于已获取的信息继续回答。]' });
        convoTail = [];
      }
      hideSearchStatus(aiMsgId);
    }

    const url = joinUrl(cfg.baseUrl, 'chat/completions');
    const isThinkingModel = /thinking|think/i.test(cfg.model);
    // 注：原生 thinking 模型会自行推理，其思考内容通过 delta.reasoning_content/thinking
    // 字段或 <think> 标签返回（见 handleStreamResponseAgent），无需再强制注入 <think> 指令。
    const tools = (STATE.toolChoice === 'none') ? [] : getToolDefinitions();
    const body = {
      model: cfg.model, messages,
      temperature: isThinkingModel ? 1 : cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

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

      const streamResult = await handleStreamResponseAgent(resp, conv, aiMsgId);
      const newContent = streamResult.content || '';
      const rawToolCalls = streamResult.toolCalls || [];
      console.log(`[Agent 循环] 第 ${searchRound} 轮: 流式读取完成, content=${newContent.length}字符, tool_calls=${rawToolCalls.length}, finish=${streamResult.finishReason}`);

      // 无工具调用（或搜索关闭）→ 模型已给出最终回答，退出循环
      if (!rawToolCalls.length || !STATE.searchMode || !$('cfgSearchEnabled').checked) {
        console.log(`[Agent 循环] 第 ${searchRound} 轮: 无工具调用或搜索未启用，退出循环`);
        break;
      }

      // 把原生 tool_calls 解析为内部指令（含 toolCallId / toolName）
      const agentCmds = toolCallsToCommands(rawToolCalls);
      console.log(`[Agent 循环] 第 ${searchRound} 轮: 解析到 ${agentCmds.length} 条工具调用`, agentCmds.map(c => `${c.type}:${c.query||c.url||c.id||'?'}`));

      // 保证每个 tool_call_id 都有且仅有一条 tool 响应：为解析失败/未知的调用补错误响应
      const coveredIds = new Set(agentCmds.map(c => c.toolCallId));
      const invalidToolMsgs = [];
      for (const tc of rawToolCalls) {
        if (!coveredIds.has(tc.id)) {
          invalidToolMsgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name || 'unknown',
            content: '[工具调用参数无法解析或工具不存在，已跳过。请检查参数格式后重试或改用其他方式。]' });
        }
      }

      // 跨轮去重：对已执行过的完全相同调用，直接回填提示性 tool 结果（保证配对），不重复真正执行
      const dedupedCmds = [];
      const dupToolMsgs = [];
      for (const cmd of agentCmds) {
        const key = `${cmd.type}:${cmd.query || cmd.url || cmd.id || ''}`;
        if (globalSeenCmds.has(key)) {
          console.warn(`[Agent 循环] 跳过重复工具调用: ${key}`);
          dupToolMsgs.push({ role: 'tool', tool_call_id: cmd.toolCallId, name: cmd.toolName,
            content: '[该工具调用与之前完全相同，已跳过。请勿重复调用，直接基于已有结果作答。]' });
        } else {
          globalSeenCmds.add(key);
          dedupedCmds.push(cmd);
        }
      }

      // 组装本轮的 assistant(tool_calls) 消息（content 为工具调用前的解释性文本）
      const assistantToolMsg = { role: 'assistant', content: newContent || '', tool_calls: rawToolCalls };

      if (!dedupedCmds.length) {
        consecutiveDupRounds++;
        console.warn(`[Agent 循环] 第 ${searchRound} 轮: 所有工具调用均为重复 (连续第 ${consecutiveDupRounds} 次)`);
        // 仍需把 assistant(tool_calls) + 对应 tool 结果配对写入，否则下一轮请求会失配
        convoTail.push(assistantToolMsg, ...dupToolMsgs, ...invalidToolMsgs);
        if (consecutiveDupRounds >= 2) {
          console.warn(`[Agent 循环] 连续 ${consecutiveDupRounds} 轮重复工具调用，强制退出循环`);
          break;
        }
        convoTail.push({ role: 'user', content: '[系统提示] 你发出的所有工具调用都已经在之前的轮次中执行过了，请直接基于已有结果回答用户问题，不要再重复调用工具。' });
        searchRound++;
        continue;
      }
      consecutiveDupRounds = 0; // 有新调用，重置计数

      // 把工具调用前的解释性文本累积进可见回答
      if (newContent && newContent.trim()) {
        conv.tree[aiMsgId].content = (accumulatedContent || '') + newContent.trim() + '\n\n';
        accumulatedContent = conv.tree[aiMsgId].content;
        renderChat();
      }

      searchRound++;
      convoTail.push(assistantToolMsg, ...dupToolMsgs, ...invalidToolMsgs);

      // 执行工具调用；结果以 role:'tool' 追加到 convoTail
      const roundToolMsgs = [];
      await executeAgentCommands(dedupedCmds, aiMsgId, conv, searchRound, roundToolMsgs);
      convoTail.push(...roundToolMsgs);

      // 检测连续空结果，超过 3 轮强制退出
      const hasUseful = roundToolMsgs.some(m => m.content && m.content.length > 200 && !m.content.startsWith('['));
      if (!hasUseful) {
        consecutiveEmptyRounds++;
        if (consecutiveEmptyRounds >= 3) {
          console.warn(`[Agent 循环] 连续 ${consecutiveEmptyRounds} 轮无有效结果，强制退出`);
          convoTail.push({ role: 'user', content: '[系统强制提示] 已连续多轮搜索无有效结果。请立即停止所有工具调用，直接基于已有信息回答用户问题。' });
          searchRound++;
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

  // ── 循环退出后：如果搜索了多轮但最终没有有效输出，强制做一次总结调用（禁用工具）──
  if (searchRound > 0 && STATE.generating && convoTail.length > 0) {
    const currentContent = (conv.tree[aiMsgId].content || '').trim();
    const hasSubstantiveAnswer = currentContent.length > 300 &&
      !/\[系统提示\]|⚠️|已停止生成/.test(currentContent.slice(-200));
    if (!hasSubstantiveAnswer) {
      console.log(`[Agent 循环] 循环退出但无有效输出 (content=${currentContent.length}字符, rounds=${searchRound}), 执行最终总结调用`);
      showSearchStatus(aiMsgId, 'search', '正在基于已收集信息生成回答...');
      try {
        const finalMessages = buildApiMessages(conv, userMsgId);
        // 保留完整的 assistant(tool_calls)/tool 配对，确保消息结构合法
        for (const em of convoTail) finalMessages.push(em);
        finalMessages.push({ role: 'user', content: '[系统强制指令] 你已经完成了所有搜索和资料收集。现在必须立即基于已收集的所有信息，直接回答用户的问题。禁止再调用任何工具。请给出完整、详细、有条理的回答。' });
        const finalUrl = joinUrl(cfg.baseUrl, 'chat/completions');
        const finalBody = {
          model: cfg.model, messages: finalMessages,
          temperature: cfg.temperature, max_tokens: cfg.maxTokens,
          stream: true, stream_options: { include_usage: true },
        };
        // 不传 tools 字段 → 模型无法再发起工具调用，强制直接作答
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
