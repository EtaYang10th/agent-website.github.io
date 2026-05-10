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

// ── 流式响应处理 ──
async function handleStreamResponseAgent(resp, conv, aiMsgId) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let newContent = '';
  const contentEl = document.getElementById('msg-content-' + aiMsgId);
  const searchEnabled = STATE.searchMode && $('cfgSearchEnabled').checked;
  let rafPending = false;
  let thinkingContent = '';
  const isThinkingModel = /thinking|think/i.test(getConfig().model);
  let inThinkTag = false;
  let rawContentBuf = '';
  const READ_TIMEOUT = 90000;

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
        console.warn('Stream read timeout — 90s 无数据，中断流');
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

        if (isThinkingModel && inThinkTag && conv.tree[aiMsgId].thinking && !rafPending) {
          rafPending = true;
          requestAnimationFrame(() => {
            rafPending = false;
            if (contentEl) contentEl.innerHTML = renderThinkingBlock(conv.tree[aiMsgId].thinking, true);
            $('chatArea').scrollTop = $('chatArea').scrollHeight;
          });
        }

        if (searchEnabled) {
          const hasClosedCmd = /\[\/(SEARCH|SEARCH_ARXIV|SEARCH_SCHOLAR|SEARCH_GITHUB|SEARCH_GOOGLE|FETCH|CTX_READ|CTX_DELETE)\]/i.test(newContent);
          const openTags = newContent.match(/\[(SEARCH|SEARCH_ARXIV|SEARCH_SCHOLAR|SEARCH_GITHUB|SEARCH_GOOGLE|FETCH|CTX_READ|CTX_DELETE)\]/gi);
          const hasMultipleOpenCmds = openTags && openTags.length >= 2;
          const hasSingleCmdWithContent = openTags && openTags.length === 1 &&
            /\[(SEARCH|SEARCH_ARXIV|SEARCH_SCHOLAR|SEARCH_GITHUB|SEARCH_GOOGLE|FETCH|CTX_READ|CTX_DELETE)\][^\[\]]{3,}\n/i.test(newContent);
          if (hasClosedCmd || hasMultipleOpenCmds || hasSingleCmdWithContent) {
            if (contentEl) {
              let display = conv.tree[aiMsgId].content;
              display = cleanDisplayCmds(display);
              contentEl.innerHTML = renderMd(display);
            }
            reader.cancel();
            return newContent;
          }
        }

        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(() => {
            rafPending = false;
            let displayHtml = '';
            if (conv.tree[aiMsgId].thinking) {
              displayHtml += renderThinkingBlock(conv.tree[aiMsgId].thinking, !conv.tree[aiMsgId].content);
            }
            let display = conv.tree[aiMsgId].content;
            display = cleanDisplayCmds(display);
            displayHtml += renderMd(display);
            if (contentEl) contentEl.innerHTML = displayHtml;
            $('chatArea').scrollTop = $('chatArea').scrollHeight;
          });
        }
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

  if (!newContent && !thinkingContent) {
    console.warn('[Stream] 流结束但 newContent 和 thinkingContent 均为空');
    newContent = '\n\n⚠️ [API 返回了空响应，请重试]';
    conv.tree[aiMsgId].content += newContent;
  } else if (!newContent && thinkingContent) {
    console.warn(`[Stream] 流结束: newContent 为空但有 thinking (${thinkingContent.length} 字符)`);
  }

  console.log(`[Stream] 完成: newContent=${newContent.length}字符, thinking=${thinkingContent.length}字符, inThinkTag=${inThinkTag}`);
  return newContent;
}
