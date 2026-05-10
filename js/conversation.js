/* ============================================================
   ETA (Edge Thin Agent) — Conversation Management & Tree Operations
   ============================================================ */

// ── 会话管理 ──
function newConversation() {
  const id = uid();
  STATE.conversations[id] = {
    id, title: STATE.lang === 'zh' ? '新对话' : 'New Chat', createdAt: Date.now(),
    tree: {},
    rootIds: [],
    activeLeaf: null,
    contextBuffer: [],
  };
  STATE.activeConvId = id;
  saveState();
  renderConvList();
  renderChat();
  renderCtxBuffer();
  $('userInput').focus();
  return id;
}

function switchConversation(id) {
  STATE.activeConvId = id;
  saveState();
  renderConvList();
  renderChat();
  renderCtxBuffer();
}

function deleteConversation(id) {
  delete STATE.conversations[id];
  if (STATE.activeConvId === id) {
    const ids = Object.keys(STATE.conversations);
    STATE.activeConvId = ids.length ? ids[ids.length - 1] : null;
  }
  saveState();
  renderConvList();
  renderChat();
  renderCtxBuffer();
}

function getActiveConv() {
  return STATE.conversations[STATE.activeConvId] || null;
}

// ── 对话树操作 ──
function addMessageToTree(conv, parentId, role, content, model, attachments) {
  const msgId = uid();
  const node = {
    id: msgId, parentId: parentId || null, role, content, model: model || '',
    time: now(), attachments: attachments || [], children: [],
    usage: null,
    thinking: '',
  };
  conv.tree[msgId] = node;
  if (parentId && conv.tree[parentId]) {
    conv.tree[parentId].children.push(msgId);
  } else if (!parentId) {
    conv.rootIds.push(msgId);
  }
  conv.activeLeaf = msgId;
  return msgId;
}

// 获取从根到指定节点的路径
function getPathToNode(conv, nodeId) {
  const path = [];
  let cur = nodeId;
  while (cur) {
    const node = conv.tree[cur];
    if (!node) break;
    path.unshift(node);
    cur = node.parentId;
  }
  return path;
}

// 获取当前活跃路径
function getActivePath(conv) {
  if (!conv || !conv.activeLeaf) return [];
  return getPathToNode(conv, conv.activeLeaf);
}

// 构建发送给API的messages数组
function buildApiMessages(conv, upToNodeId) {
  const cfg = getConfig();
  const path = getPathToNode(conv, upToNodeId || conv.activeLeaf);
  const messages = [];
  const searchPrompt = getSearchSystemPrompt();
  const ctxBufferPrompt = buildContextBufferPrompt();
  const langSuffix = getLangSystemSuffix();
  const systemContent = (cfg.system || '') + langSuffix + searchPrompt + ctxBufferPrompt;
  if (systemContent) messages.push({ role: 'system', content: systemContent });
  for (const node of path) {
    const textForApi = node.apiContent || node.content;
    if (node.role === 'user' && node.attachments && node.attachments.length > 0) {
      const contentParts = [];
      for (const att of node.attachments) {
        if (att.type && att.type.startsWith('image/')) {
          contentParts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
        }
      }
      if (textForApi) contentParts.push({ type: 'text', text: textForApi });
      messages.push({ role: 'user', content: contentParts });
    } else {
      messages.push({ role: node.role, content: textForApi });
    }
  }
  return messages;
}

// 回退到某个节点
function rewindToNode(conv, nodeId) {
  conv.activeLeaf = nodeId;
  saveState();
  renderChat();
}

// 从某个节点创建新分支
function branchFromNode(conv, nodeId, newContent, newAttachments) {
  const node = conv.tree[nodeId];
  if (!node) return null;
  const newMsgId = addMessageToTree(conv, node.parentId, 'user', newContent, '', newAttachments);
  return newMsgId;
}

function getSiblings(conv, node) {
  if (node.parentId) {
    const parent = conv.tree[node.parentId];
    return parent ? parent.children : [node.id];
  }
  return conv.rootIds;
}

function navBranch(nodeId, dir) {
  const conv = getActiveConv();
  if (!conv) return;
  const node = conv.tree[nodeId];
  if (!node) return;
  const siblings = getSiblings(conv, node);
  const idx = siblings.indexOf(nodeId);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= siblings.length) return;
  const newNodeId = siblings[newIdx];
  let leaf = newNodeId;
  while (true) {
    const n = conv.tree[leaf];
    if (!n || !n.children.length) break;
    leaf = n.children[n.children.length - 1];
  }
  conv.activeLeaf = leaf;
  saveState();
  renderChat();
}
