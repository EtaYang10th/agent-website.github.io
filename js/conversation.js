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
  const doomed = STATE.conversations[id];
  delete STATE.conversations[id];
  // 清理该对话的大字段记录，否则图片会永久占用 IndexedDB
  if (doomed && typeof storageDeleteConvBlobs === 'function') {
    storageDeleteConvBlobs(id, doomed).catch(e => console.warn('[Storage] blob 清理失败:', e));
  }
  // 同步清理该对话的检索索引，否则 IndexedDB 里会留下孤儿索引（js/retrieval.js）
  if (typeof retrClearConv === 'function') retrClearConv(id);
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

function getActivePath(conv) {
  if (!conv || !conv.activeLeaf) return [];
  return getPathToNode(conv, conv.activeLeaf);
}

function buildApiMessages(conv, upToNodeId) {
  const cfg = getConfig();
  const path = getPathToNode(conv, upToNodeId || conv.activeLeaf);
  const messages = [];
  const searchPrompt = getSearchSystemPrompt();
  const ctxBufferPrompt = buildContextBufferPrompt();
  const langSuffix = getLangSystemSuffix();
  // 用户档案（手填）与长期记忆（Agent 自行维护）：都是软依赖，模块缺失时为空串
  const profilePrompt = (typeof profPromptBlock === 'function') ? profPromptBlock() : '';
  const memoryPrompt = (typeof memPromptBlock === 'function') ? memPromptBlock() : '';
  const systemContent = (cfg.system || '') + langSuffix + profilePrompt + memoryPrompt
    + searchPrompt + ctxBufferPrompt;
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
