/* ============================================================
   ETA (Edge Thin Agent) — Rendering (Markdown, Messages, Chat, List)
   ============================================================ */

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

/* ── HTML 净化白名单 ──
   保留：Markdown 基础结构、代码块（pre/code/span + hljs class）、
   复制按钮（button[data-copy-code]）、KaTeX 产出的 MathML 与 SVG。 */
const SANITIZE_TAGS = [
  'p','br','hr','div','span','a','em','strong','del','ins','sub','sup','small','mark','abbr','kbd',
  'h1','h2','h3','h4','h5','h6','blockquote','ul','ol','li','dl','dt','dd',
  'pre','code','button','table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col',
  'img','details','summary','figure','figcaption',
  // KaTeX MathML
  'math','semantics','annotation','annotation-xml','mrow','mi','mo','mn','ms','mtext','mspace',
  'msup','msub','msubsup','mfrac','msqrt','mroot','mover','munder','munderover','mmultiscripts',
  'mtable','mtr','mtd','mlabeledtr','mpadded','mphantom','menclose','mstyle','merror','mfenced','maction',
  // KaTeX SVG（\\overrightarrow 等）
  'svg','path','g','line','rect','circle','ellipse','polyline','polygon','defs','use','symbol','clipPath','text','tspan',
];

const SANITIZE_ATTRS = [
  'class','id','style','title','href','target','rel','src','alt','width','height',
  'align','colspan','rowspan','start','type','open','dir','lang',
  'data-copy-code','data-lang',
  // MathML
  'display','mathvariant','mathsize','mathcolor','displaystyle','scriptlevel','stretchy','fence',
  'separator','lspace','rspace','accent','accentunder','linethickness','columnalign','rowalign',
  'columnspacing','rowspacing','notation','encoding','xmlns','depth','voffset',
  // SVG
  'd','fill','fill-rule','stroke','stroke-width','stroke-linecap','stroke-linejoin','viewBox',
  'preserveAspectRatio','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','points','transform',
  'aria-hidden','aria-label','role',
];

// 未加载 DOMPurify（CDN 挂掉）时优雅降级：跳过净化但告警一次
let _sanitizeWarned = false;
function sanitizeHtml(html) {
  if (typeof DOMPurify === 'undefined' || !DOMPurify.sanitize) {
    if (!_sanitizeWarned) {
      _sanitizeWarned = true;
      console.warn('[Security] DOMPurify 未加载，Markdown 渲染跳过净化。请检查 CDN 可达性。');
    }
    return html;
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: SANITIZE_TAGS,
    ALLOWED_ATTR: SANITIZE_ATTRS,
    ALLOW_DATA_ATTR: false,
    ADD_URI_SAFE_ATTR: ['xmlns'],
    FORBID_TAGS: ['script','style','iframe','object','embed','form','input','textarea','select','link','meta','base'],
    FORBID_ATTR: ['onerror','onload','onclick','onmouseover','onfocus','onanimationstart','formaction'],
  });
}

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
  // 不用内联 onclick：DOMPurify 会剥离事件属性，改由文件末尾的 document 事件委托处理
  html = html.replace(/<pre><code/g, '<pre><button type="button" class="copy-btn" data-copy-code="1">复制</button><code');

  html = html.replace(/%%BLOCKMATH(\d+)%%/g, (_, i) => {
    try { return katex.renderToString(blockMath[i], { displayMode: true, throwOnError: false }); }
    catch(e) { return `<code>${escHtml(blockMath[i])}</code>`; }
  });
  html = html.replace(/%%INLINEMATH(\d+)%%/g, (_, i) => {
    try { return katex.renderToString(inlineMath[i], { displayMode: false, throwOnError: false }); }
    catch(e) { return `<code>${escHtml(inlineMath[i])}</code>`; }
  });
  // sanitize 必须在 KaTeX 回填之后，否则 MathML/SVG 会重新引入未净化节点
  html = sanitizeHtml(html);
  // 给可预览代码块的 <pre> 打标记（净化之后打，避免被 DOMPurify 处理掉）；工具条由 mountArtifacts 挂载
  return (typeof markArtifactBlocks === 'function') ? markArtifactBlocks(html) : html;
}

function copyCode(btn) {
  const code = btn.nextElementSibling;
  if (!code) return;
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.textContent = '已复制';
    setTimeout(() => btn.textContent = '复制', 1500);
  });
}

// ── 复制按钮事件委托（替代内联 onclick，兼容 DOMPurify） ──
document.addEventListener('click', e => {
  const btn = e.target.closest && e.target.closest('button.copy-btn[data-copy-code]');
  if (btn) { e.preventDefault(); copyCode(btn); }
});

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
  let outTokens = 0;
  for (const node of path) {
    if (node.usage) outTokens += (node.usage.completion_tokens || 0);
  }
  const tokenInfo = outTokens > 0 ? ` · ${outTokens.toLocaleString()} 输出tokens` : '';
  $('topbarInfo').textContent = `${conv.title} · ${msgCount} 条消息${tokenInfo}`;

  if (typeof reattachCodeResultCards === 'function') reattachCodeResultCards();
  if (typeof mountArtifacts === 'function') mountArtifacts(container);

  /* 这里必须强制置底：上面重建了 innerHTML，scrollTop 已被浏览器归零，
     "用户是否贴底"的判断此刻永远为假，不强制的话切换会话会停在顶部。 */
  requestAnimationFrame(() => {
    scrollChatToBottom(true);
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
