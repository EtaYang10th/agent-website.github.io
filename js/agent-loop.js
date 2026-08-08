/* ============================================================
   ETA (Edge Thin Agent) — doGenerate & Stream Handler (Agent Loop Core)
   ============================================================ */

// ── <think> 标签碎片匹配辅助 ──
function matchPartialOpen(s) {
  const tag = '<think>';
  for (let i = Math.min(tag.length - 1, s.length); i >= 1; i--) {
    if (s.endsWith(tag.slice(0, i))) return i;
  }
  return 0;
}
function matchPartialClose(s) {
  const tag = '</think>';
  for (let i = Math.min(tag.length - 1, s.length); i >= 1; i--) {
    if (s.endsWith(tag.slice(0, i))) return i;
  }
  return 0;
}

async function handleStreamResponseAgent(resp, conv, aiMsgId) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let newContent = '';
  /* 每次刷新都重新按 id 取节点，不缓存：renderChat() 会整体重建 #chatMessages，
     缓存下来的引用会变成脱离文档的孤儿节点，后续输出全写进去、界面看着"卡住"。
     触发路径包括生成期间切换会话、改设置开关、eta-config 异步加载完成后的重绘。 */
  const getContentEl = () => document.getElementById('msg-content-' + aiMsgId);
  let flushPending = false;
  let thinkingContent = '';
  // 用消息节点上记录的模型（Planner/Executor 分工时它才是真正发请求的那个）
  const streamModel = (conv.tree[aiMsgId] && conv.tree[aiMsgId].model) || getConfig().model;
  const isThinkingModel = /thinking|think/i.test(streamModel);
  let inThinkTag = false;
  let rawContentBuf = '';
  // 流式读取超时从第四期配置读取（js/eta-config.js），模块缺失时回退 90s
  const READ_TIMEOUT = (typeof etaCfg === 'function') ? etaCfg('readTimeout') : 90000;
  const toolCallsAcc = []; // 按 index 累积的 tool_calls（arguments 为分片拼接的 JSON 字符串）
  let finishReason = null;

  /* 流式刷新节流。
     原来用 requestAnimationFrame（~60fps），而每帧都对"当前累积的全文"重跑一遍
     renderMd —— 内容线性增长、帧数也线性增长，总成本 O(n²)，且每次都重新
     marked.parse + 逐个 katex.renderToString + DOMPurify 全量净化。
     实测一条 7.6k 字符的回答累计约 2.3s 主线程 CPU，而最终态只需 12ms。
     节流到 STREAM_FLUSH_MS 把帧数降到约 1/6，肉眼仍是连续追字。 */
  const STREAM_FLUSH_MS = 100;
  let lastFlush = 0;
  let flushTimer = null;

  function flushNow() {
    flushPending = false;
    lastFlush = Date.now();
    const el = getContentEl();
    if (!el) return;
    const node = conv.tree[aiMsgId];
    if (!node) return;
    let displayHtml = '';
    if (node.thinking) displayHtml += renderThinkingBlock(node.thinking, !node.content);
    displayHtml += renderMd(node.content);
    el.innerHTML = displayHtml;
    scrollChatToBottom();
  }

  function scheduleFlush() {
    if (flushPending) return;
    flushPending = true;
    const wait = Math.max(0, STREAM_FLUSH_MS - (Date.now() - lastFlush));
    flushTimer = setTimeout(() => { flushTimer = null; requestAnimationFrame(flushNow); }, wait);
  }

  while (true) {
    let done, value;
    try {
      const readPromise = reader.read();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('stream_read_timeout')), READ_TIMEOUT)
      );
      ({ done, value } = await Promise.race([readPromise, timeoutPromise]));
    } catch (readErr) {
      if (readErr.message === 'stream_read_timeout') {
        console.warn(`Stream read timeout — ${Math.round(READ_TIMEOUT / 1000)}s 无数据，中断流`);
        newContent += '\n\n⚠️ [流式响应超时，服务端长时间无数据返回]';
        conv.tree[aiMsgId].content += '\n\n⚠️ [流式响应超时，服务端长时间无数据返回]';
        try { reader.cancel(); } catch(_) {}
        break;
      }
      throw readErr;
    }
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      const chunk = safeJson(payload);
      if (!chunk?.choices?.[0]) continue;
      const delta = chunk.choices[0].delta;
      if (chunk.choices[0].finish_reason) finishReason = chunk.choices[0].finish_reason;

      // 累积原生 tool_calls（流式：每片带 index，arguments 为字符串增量）
      if (Array.isArray(delta?.tool_calls)) {
        for (const tcDelta of delta.tool_calls) {
          const i = tcDelta.index ?? 0;
          if (!toolCallsAcc[i]) toolCallsAcc[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          const slot = toolCallsAcc[i];
          if (tcDelta.id) slot.id = tcDelta.id;
          if (tcDelta.type) slot.type = tcDelta.type;
          if (tcDelta.function?.name) slot.function.name = tcDelta.function.name;
          if (tcDelta.function?.arguments) slot.function.arguments += tcDelta.function.arguments;
        }
        showSearchStatus(aiMsgId, 'search', STATE.lang === 'zh' ? '正在准备工具调用...' : 'Preparing tool calls...');
      }

      let thinkDelta = delta?.thinking || delta?.reasoning_content || delta?.reasoning || '';
      if (!thinkDelta && Array.isArray(delta?.content)) {
        for (const block of delta.content) {
          if (block.type === 'thinking' && block.thinking) thinkDelta += block.thinking;
        }
      }
      if (thinkDelta) {
        thinkingContent += thinkDelta;
        conv.tree[aiMsgId].thinking = thinkingContent;
      }

      const contentDelta = (typeof delta?.content === 'string') ? delta.content : '';
      if (contentDelta) {
        if (isThinkingModel) {
          rawContentBuf += contentDelta;
          let processed = true;
          while (processed) {
            processed = false;
            if (inThinkTag) {
              const closeIdx = rawContentBuf.indexOf('</think>');
              if (closeIdx !== -1) {
                thinkingContent += rawContentBuf.slice(0, closeIdx);
                conv.tree[aiMsgId].thinking = thinkingContent;
                rawContentBuf = rawContentBuf.slice(closeIdx + 8);
                inThinkTag = false; processed = true;
              } else {
                const partial = matchPartialClose(rawContentBuf);
                const safe = rawContentBuf.slice(0, rawContentBuf.length - partial);
                if (safe) { thinkingContent += safe; conv.tree[aiMsgId].thinking = thinkingContent; }
                rawContentBuf = rawContentBuf.slice(rawContentBuf.length - partial);
              }
            } else {
              const openIdx = rawContentBuf.indexOf('<think>');
              if (openIdx !== -1) {
                const before = rawContentBuf.slice(0, openIdx);
                if (before) { newContent += before; conv.tree[aiMsgId].content += before; }
                rawContentBuf = rawContentBuf.slice(openIdx + 7);
                inThinkTag = true; processed = true;
              } else {
                const partial = matchPartialOpen(rawContentBuf);
                const safe = rawContentBuf.slice(0, rawContentBuf.length - partial);
                if (safe) { newContent += safe; conv.tree[aiMsgId].content += safe; }
                rawContentBuf = rawContentBuf.slice(rawContentBuf.length - partial);
              }
            }
          }
        } else {
          newContent += contentDelta;
          conv.tree[aiMsgId].content += contentDelta;
        }

        scheduleFlush();
      }
      if (chunk?.usage) {
        conv.tree[aiMsgId].usage = {
          prompt_tokens: chunk.usage.prompt_tokens || 0,
          completion_tokens: chunk.usage.completion_tokens || 0,
          total_tokens: chunk.usage.total_tokens || 0,
        };
      }
    }
  }

  if (isThinkingModel && rawContentBuf) {
    if (inThinkTag) {
      thinkingContent += rawContentBuf;
      conv.tree[aiMsgId].thinking = thinkingContent;
      console.warn(`[Stream] 流结束时 <think> 未闭合，残留 ${rawContentBuf.length} 字符归入 thinking`);
    } else {
      newContent += rawContentBuf;
      conv.tree[aiMsgId].content += rawContentBuf;
    }
  }

  const toolCalls = toolCallsAcc.filter(Boolean);

  // 仅在既无正文、又无 thinking、也无工具调用时才视为空响应
  if (!newContent && !thinkingContent && !toolCalls.length) {
    console.warn('[Stream] 流结束但 newContent、thinkingContent 和 tool_calls 均为空');
    newContent = '\n\n⚠️ [API 返回了空响应，请重试]';
    conv.tree[aiMsgId].content += newContent;
  } else if (!newContent && thinkingContent) {
    console.warn(`[Stream] 流结束: newContent 为空但有 thinking (${thinkingContent.length} 字符)`);
  }

  /* 收尾必须同步渲染一次：节流可能还有一次刷新挂在 timer 上没跑，
     而 doGenerate 紧接着就会读 content 决定下一步，不能让界面停在上一帧。 */
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushNow();

  console.log(`[Stream] 完成: newContent=${newContent.length}字符, thinking=${thinkingContent.length}字符, tool_calls=${toolCalls.length}, finish=${finishReason}`);
  return { content: newContent, toolCalls, finishReason };
}
