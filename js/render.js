/* ============================================================
   ETA (Edge Thin Agent) — Rendering (Markdown, Messages, Chat, List)
   ============================================================ */

// ── 渲染会话列表 ──
function renderConvList() {
  const list = $('convList');
  const convs = Object.values(STATE.conversations).sort((a, b) => b.createdAt - a.createdAt);
  list.innerHTML = convs.map(c => `
    <div class="conv-item ${c.id === STATE.activeConvId ? 'active' : ''}" onclick="switchConversation('${c.id}')">
      <span style="font-size:.9rem">💬</span>
      <span class="conv-title">${escHtml(c.title)}</span>
      <span class="conv-delete" onclick="event.stopPropagation();deleteConversation('${c.id}')" title="删除">✕</span>
    </div>
  `).join('');
}

// ── 渲染 Thinking 块 ──
function renderThinkingBlock(thinking, isActive) {
  if (!thinking) return '';
  const lines = thinking.split('\n').length;
  const chars = thinking.length;
  const label = isActive ? '🧠 思考中...' : `🧠 思考过程 (${lines}行, ${chars}字)`;
  const activeClass = isActive ? ' thinking-active' : '';
  const openClass = isActive ? ' open' : '';
  return `<div class="thinking-block${activeClass}">
    <div class="thinking-header${openClass}" onclick="this.classList.toggle('open')">
      <span class="thinking-icon">▶</span> ${label}
    </div>
    <div class="thinking-body">${escHtml(thinking)}</div>
  </div>`;
}

// ── 渲染 Markdown ──
function renderMd(text) {
  if (!text) return '';
  const blockMath = [];
  const inlineMath = [];
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => {
    blockMath.push(m);
    return `%%BLOCKMATH${blockMath.length - 1}%%`;
  });
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => {
    blockMath.push(m);
    return `%%BLOCKMATH${blockMath.length - 1}%%`;
  });
  text = text.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_, m) => {
    inlineMath.push(m);
    return `%%INLINEMATH${inlineMath.length - 1}%%`;
  });
  text = text.replace(/\\\((.+?)\\\)/g, (_, m) => {
    inlineMath.push(m);
    return `%%INLINEMATH${inlineMath.length - 1}%%`;
  });

  let html = marked.parse(text);
  html = html.replace(/<pre><code/g, '<pre><button class="copy-btn" onclick="copyCode(this)">复制</button><code');

  html = html.replace(/%%BLOCKMATH(\d+)%%/g, (_, i) => {
    try { return katex.renderToString(blockMath[i], { displayMode: true, throwOnError: false }); }
    catch(e) { return `<code>${escHtml(blockMath[i])}</code>`; }
  });
  html = html.replace(/%%INLINEMATH(\d+)%%/g, (_, i) => {
    try { return katex.renderToString(inlineMath[i], { displayMode: false, throwOnError: false }); }
    catch(e) { return `<code>${escHtml(inlineMath[i])}</code>`; }
  });
  return html;
}

function copyCode(btn) {
  const code = btn.nextElementSibling;
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.textContent = '已复制';
    setTimeout(() => btn.textContent = '复制', 1500);
  });
}

// ── 渲染聊天区域 ──
function renderChat() {
  const conv = getActiveConv();
  const container = $('chatMessages');

  if (!conv) {
    container.innerHTML = `<div class="welcome-screen">
      <div class="welcome-logo">✦</div>
      <div class="welcome-title">ETA</div>
      <div class="welcome-sub">Edge Thin Agent</div>
    </div>`;
    $('topbarInfo').textContent = '';
    return;
  }

  const path = getActivePath(conv);
  if (!path.length) {
    container.innerHTML = `<div class="welcome-screen">
      <div class="welcome-logo">✦</div>
      <div class="welcome-title">${escHtml(conv.title)}</div>
      <div class="welcome-sub">开始新对话吧</div>
    </div>`;
    return;
  }

  let html = '';
  for (const node of path) {
    html += renderMessageNode(conv, node);
  }
  container.innerHTML = html;

  const msgCount = path.length;
  // 注：该代理上报的 prompt_tokens 存在虚高 bug（不影响实际扣费），
  // 故只累计可信的 completion_tokens（实际生成量）。
  let outTokens = 0;
  for (const node of path) {
    if (node.usage) outTokens += (node.usage.completion_tokens || 0);
  }
  const tokenInfo = outTokens > 0 ? ` · ${outTokens.toLocaleString()} 输出tokens` : '';
  $('topbarInfo').textContent = `${conv.title} · ${msgCount} 条消息${tokenInfo}`;

  requestAnimationFrame(() => {
    $('chatArea').scrollTop = $('chatArea').scrollHeight;
  });
}

function renderMessageNode(conv, node) {
  const isUser = node.role === 'user';
  const avatarEmoji = isUser ? '👤' : '🤖';
  const roleLabel = isUser ? 'You' : 'Assistant';

  let branchHtml = '';
  const siblings = getSiblings(conv, node);
  if (siblings.length > 1) {
    const idx = siblings.indexOf(node.id);
    branchHtml = `<span class="branch-nav">
      <button onclick="navBranch('${node.id}',-1)" ${idx <= 0 ? 'disabled' : ''}>◀</button>
      <span>${idx + 1}/${siblings.length}</span>
      <button onclick="navBranch('${node.id}',1)" ${idx >= siblings.length - 1 ? 'disabled' : ''}>▶</button>
    </span>`;
  }

  let attachHtml = '';
  const hasImageAtts = node.attachments && node.attachments.length;
  const hasFileNames = node.fileNames && node.fileNames.length;
  if (hasImageAtts || hasFileNames) {
    attachHtml = '<div class="msg-attachments">';
    if (hasImageAtts) {
      for (const att of node.attachments) {
        if (att.type && att.type.startsWith('image/')) {
          attachHtml += `<div class="msg-attachment"><img src="${att.dataUrl}" onclick="viewImage(this.src)" alt="${escHtml(att.name)}"></div>`;
        }
      }
    }
    if (hasFileNames) {
      for (const fn of node.fileNames) {
        attachHtml += `<div class="msg-attachment"><div class="file-chip">📄 ${escHtml(fn)}</div></div>`;
      }
    }
    attachHtml += '</div>';
  }

  const modelTag = node.model ? `<span class="msg-model-tag">${escHtml(node.model)}</span>` : '';

  let tokenTag = '';
  if (node.usage && node.usage.completion_tokens) {
    const u = node.usage;
    // 仅展示可信的输出 token；prompt_tokens 因代理 bug 虚高，放入 title 并标注仅供参考
    tokenTag = `<span class="msg-model-tag" title="输出 (completion): ${u.completion_tokens}${u.prompt_tokens ? ` · 上报输入(prompt,该代理虚高仅供参考): ${u.prompt_tokens}` : ''}">🎯 ${u.completion_tokens} 输出tokens</span>`;
  }

  const actions = isUser
    ? `<button class="msg-action-btn" onclick="editMessage('${node.id}')">✏️ 编辑</button>
       <button class="msg-action-btn" onclick="resendFrom('${node.id}')">🔄 重发</button>`
    : `<button class="msg-action-btn" onclick="copyMsgContent('${node.id}')">📋 复制</button>
       <button class="msg-action-btn" onclick="regenerateFrom('${node.id}')">🔄 重新生成</button>`;

  return `<div class="msg msg-${isUser ? 'user' : 'ai'}" data-msg-id="${node.id}">
    <div class="msg-avatar">${avatarEmoji}</div>
    <div class="msg-body">
      <div class="msg-header">
        <span class="msg-role">${roleLabel}</span>
        <span class="msg-time">${escHtml(node.time)}</span>
        ${modelTag}${tokenTag}${branchHtml}
      </div>
      ${attachHtml}
      <div class="msg-content" id="msg-content-${node.id}">${isUser ? escHtml(node.content) : (node.thinking ? renderThinkingBlock(node.thinking, false) : '') + renderMd(node.content)}</div>
      <div class="msg-actions">${actions}</div>
    </div>
  </div>`;
}

function viewImage(url) {
  $('imgViewerSrc').src = url;
  $('imgViewer').style.display = 'flex';
}

function copyMsgContent(nodeId) {
  const conv = getActiveConv();
  if (!conv || !conv.tree[nodeId]) return;
  navigator.clipboard.writeText(conv.tree[nodeId].content).then(() => toast('已复制', 'ok'));
}

// ── 编辑消息 ──
function editMessage(nodeId) {
  const conv = getActiveConv();
  if (!conv || !conv.tree[nodeId]) return;
  const node = conv.tree[nodeId];
  $('userInput').value = node.content;
  STATE.attachments = node.attachments ? [...node.attachments] : [];
  renderAttachPreview();
  autoResize($('userInput'));
  $('userInput').focus();
  $('userInput').dataset.editNodeId = nodeId;
  toast('已加载消息到输入框，修改后发送将创建新分支', 'info');
}

function resendFrom(nodeId) {
  const conv = getActiveConv();
  if (!conv || !conv.tree[nodeId]) return;
  const node = conv.tree[nodeId];
  const newId = addMessageToTree(conv, node.parentId, 'user', node.content, '', node.attachments);
  saveState();
  renderChat();
  doGenerate(conv, newId);
}

function regenerateFrom(nodeId) {
  const conv = getActiveConv();
  if (!conv || !conv.tree[nodeId]) return;
  const node = conv.tree[nodeId];
  if (node.role !== 'assistant' || !node.parentId) return;
  doGenerate(conv, node.parentId);
}
