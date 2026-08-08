/* ============================================================
   ETA (Edge Thin Agent) — Context Buffer (Knowledge Cache)
   ============================================================ */

function getCtxBuffer() {
  const conv = getActiveConv();
  if (!conv) return [];
  if (!conv.contextBuffer) conv.contextBuffer = [];
  return conv.contextBuffer;
}

function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    tokens += (code > 0x4e00 && code < 0x9fff) ? 1.5 : 0.3;
  }
  return Math.ceil(tokens);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

// ── 右侧面板折叠/展开 ──
function toggleCtxPanel() {
  const panel = $('ctxPanel');
  panel.classList.toggle('open');
  const btn = $('ctxToggleBtn');
  if (panel.classList.contains('open')) {
    btn.style.color = 'var(--accent2)';
    renderCtxBuffer();
    if (typeof retrLocalizePanel === 'function') retrLocalizePanel();
  } else {
    btn.style.color = '';
  }
}

// ── 核心操作 ──
function ctxAddItem(item) {
  const buf = getCtxBuffer();
  const entry = {
    id: item.id || uid(),
    type: item.type || 'text',
    name: item.name || '未命名',
    source: item.source || '',
    content: item.content || '',
    size: new Blob([item.content || '']).size,
    tokens: estimateTokens(item.content),
    addedAt: Date.now(),
    selected: item.selected !== undefined ? item.selected : true,
  };
  buf.push(entry);
  saveState();
  renderCtxBuffer();
  toast(`已添加到缓存区: ${entry.name}`, 'ok');
  updateCtxBtnBadge();
  // 异步建分块索引，不阻塞 UI（js/retrieval.js）
  if (typeof retrScheduleIndex === 'function') retrScheduleIndex();
  return entry;
}

function ctxRemoveItem(id) {
  const conv = getActiveConv();
  if (!conv) return;
  conv.contextBuffer = (conv.contextBuffer || []).filter(i => i.id !== id);
  saveState();
  renderCtxBuffer();
  updateCtxBtnBadge();
  if (typeof retrRemoveItem === 'function') retrRemoveItem(id, conv.id);
}

function ctxClearAll() {
  const buf = getCtxBuffer();
  if (!buf.length) return;
  if (!confirm('确定清空当前对话的所有缓存项？')) return;
  const conv = getActiveConv();
  if (conv) conv.contextBuffer = [];
  saveState();
  renderCtxBuffer();
  updateCtxBtnBadge();
  if (conv && typeof retrClearConv === 'function') retrClearConv(conv.id);
  toast('缓存区已清空', 'ok');
}

function ctxToggleItem(id) {
  const buf = getCtxBuffer();
  const item = buf.find(i => i.id === id);
  if (item) { item.selected = !item.selected; saveState(); renderCtxBuffer(); }
}

function ctxSelectAll() {
  getCtxBuffer().forEach(i => i.selected = true);
  saveState(); renderCtxBuffer();
}

function ctxDeselectAll() {
  getCtxBuffer().forEach(i => i.selected = false);
  saveState(); renderCtxBuffer();
}

function updateCtxBtnBadge() {
  const buf = getCtxBuffer();
  const btn = $('ctxToggleBtn');
  if (btn) btn.title = buf.length > 0 ? `缓存区 (${buf.length})` : '缓存区';
}

// ── 渲染列表 ──
function renderCtxBuffer() {
  const list = $('ctxList');
  if (!list) return;
  // 切换对话后旧的检索结果不再适用，丢掉（js/retrieval.js）
  if (typeof retrDropStaleResults === 'function') retrDropStaleResults();
  const conv = getActiveConv();
  const buf = conv ? (conv.contextBuffer || []) : [];
  if (!buf.length) {
    list.innerHTML = `<div class="ctx-panel .ctx-empty" style="text-align:center;padding:24px;color:var(--text3);font-size:.82rem">
      ${conv ? '当前对话缓存区为空' : '请先选择或创建对话'}
      <div style="font-size:.72rem;margin-top:6px;line-height:1.5">Agent 搜索/抓取的内容会自动存入<br>也可手动上传文件或粘贴 URL</div>
    </div>`;
    updateCtxStats();
    return;
  }
  list.innerHTML = buf.map(item => {
    const icon = {webpage:'🌐',paper:'📄',file:'📎',search:'🔍',text:'📝'}[item.type] || '📄';
    const count = item.readCount || 0;
    const thisTurn = item.readThisTurn;
    let readTag = '';
    if (thisTurn && count > 0) {
      readTag = `<span style="font-size:.6rem;color:var(--ok);margin-left:4px" title="本轮已读，累计 ${count} 次">🟢 本轮已读(${count})</span>`;
    } else if (count > 0) {
      readTag = `<span style="font-size:.6rem;color:var(--text3);margin-left:4px" title="累计读取 ${count} 次，本轮未读">⚪ 已读(${count})</span>`;
    }
    return `<div class="ctx-item" data-ctx-id="${item.id}">
      <div class="ctx-item-body" onclick="ctxPreviewItem('${item.id}')" style="cursor:pointer">
        <span class="ctx-item-name">${icon} ${escHtml(item.name)}${readTag}</span>
        <div class="ctx-item-meta">
          <span>📊 ${item.tokens.toLocaleString()} tok</span>
          <span>💾 ${formatSize(item.size)}</span>
        </div>
      </div>
      <span class="ctx-item-del" onclick="ctxRemoveItem('${item.id}')" title="删除">✕</span>
    </div>`;
  }).join('');
  updateCtxStats();
}

function updateCtxStats() {
  const buf = getCtxBuffer();
  const total = buf.length;
  const totalTokens = buf.reduce((s, i) => s + i.tokens, 0);
  const readCount = buf.filter(i => i.readCount > 0).length;
  const thisTurnCount = buf.filter(i => i.readThisTurn).length;
  const stats = $('ctxStats');
  if (stats) stats.innerHTML = `<span>${total} 项 · ${totalTokens.toLocaleString()} tok</span><span>本轮: ${thisTurnCount} 已读 · 累计: ${readCount} 已读</span>`;
  const hint = $('ctxHint');
  if (hint) {
    hint.innerHTML = total > 0 ? `📚 ${total} 项缓存 (~${totalTokens.toLocaleString()} tok，仅标题注入) · ` : '';
    hint.style.color = total > 0 ? 'var(--accent2)' : '';
  }
}

function ctxPreviewItem(id) {
  const item = getCtxBuffer().find(i => i.id === id);
  if (!item) return;
  const preview = item.content.length > 2000 ? item.content.slice(0, 2000) + '\n\n[...已截断]' : item.content;
  // name/type 可能来自抓取的网页标题或模型给的文件名，两者都要转义（retrieval.js 同处已转义）
  showModal(`📄 ${escHtml(item.name)}`, `<div style="font-size:.78rem;color:var(--text3);margin-bottom:8px">${escHtml(item.type)} · ${item.tokens.toLocaleString()} tokens · ${formatSize(item.size)}</div>
    <pre style="background:var(--input-bg);padding:12px;border-radius:8px;font-size:.78rem;overflow:auto;max-height:50vh;white-space:pre-wrap;word-break:break-word;color:var(--text2)">${escHtml(preview)}</pre>`);
}

// ── URL 抓取入库 ──
async function ctxFetchUrl() {
  const conv = getActiveConv();
  if (!conv) { toast('请先创建或选择一个对话', 'fail'); return; }
  const input = $('ctxUrlInput');
  const url = input.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) { toast('请输入有效的 URL', 'fail'); return; }
  input.value = '';
  toast('正在抓取网页...', 'info');
  try {
    const result = await fetchWebPage(url);
    if (result.error) { toast(result.error, 'fail'); return; }
    const name = url.replace(/^https?:\/\//, '').slice(0, 60);
    const type = extractArxivId(url) ? 'paper' : 'webpage';
    ctxAddItem({ type, name, source: url, content: result.content });
  } catch(e) { toast('抓取失败: ' + e.message, 'fail'); }
}

// ── 文件上传入库 ──
function ctxUploadFile() { $('ctxFileInput').click(); }

async function ctxHandleFileUpload(event) {
  const files = event.target.files;
  if (!files) return;
  for (const file of files) { await ctxProcessFile(file); }
  event.target.value = '';
}

async function ctxProcessFile(file) {
  const conv = getActiveConv();
  if (!conv) { toast('请先创建或选择一个对话', 'fail'); return; }
  const ext = file.name.split('.').pop().toLowerCase();
  const type = file.type || '';
  if (ext === 'pdf' || type === 'application/pdf') {
    toast('正在解析 PDF...', 'info');
    try {
      if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js 未加载');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        const text = tc.items.map(it => it.str).join(' ');
        if (text.trim()) pages.push(`[第${i}页]\n${text.trim()}`);
      }
      ctxAddItem({ type: 'paper', name: file.name, content: pages.join('\n\n') || '[无可提取文本]' });
    } catch(e) { toast('PDF 解析失败: ' + e.message, 'fail'); }
    return;
  }
  try {
    const text = await file.text();
    ctxAddItem({ type: 'file', name: file.name, content: text });
  } catch(e) { toast('文件读取失败: ' + e.message, 'fail'); }
}

// ── 从搜索/抓取结果收藏 ──
function ctxSaveFromSearch(results, query) {
  const content = formatSearchResultsForLLM(results, query);
  ctxAddItem({ type: 'search', name: `搜索: ${query}`.slice(0, 60), source: 'search', content });
}

function ctxSaveFromFetch(url, content) {
  const name = url.replace(/^https?:\/\//, '').slice(0, 60);
  const type = extractArxivId(url) ? 'paper' : 'webpage';
  ctxAddItem({ type, name, source: url, content });
}

// ── Agent 自动存储（带去重）──
function ctxIsDuplicate(name, source) {
  const buf = getCtxBuffer();
  return buf.some(i => (source && i.source === source) || i.name === name);
}

function ctxAutoSaveSearch(results, query, type) {
  const name = `搜索: ${query}`.slice(0, 60);
  if (ctxIsDuplicate(name, '')) return;
  const content = formatSearchResultsForLLM(results, query);
  const buf = getCtxBuffer();
  buf.push({
    id: uid(), type: 'search', name, source: 'search:' + query,
    content, size: new Blob([content]).size,
    tokens: estimateTokens(content), addedAt: Date.now(), selected: false,
  });
  saveState(); renderCtxBuffer(); updateCtxBtnBadge();
  if (typeof retrScheduleIndex === 'function') retrScheduleIndex();
}

function ctxAutoSaveFetch(url, content) {
  if (ctxIsDuplicate('', url)) return;
  const name = url.replace(/^https?:\/\//, '').slice(0, 60);
  const type = extractArxivId(url) ? 'paper' : 'webpage';
  const buf = getCtxBuffer();
  buf.push({
    id: uid(), type, name, source: url,
    content, size: new Blob([content]).size,
    tokens: estimateTokens(content), addedAt: Date.now(), selected: false,
  });
  saveState(); renderCtxBuffer(); updateCtxBtnBadge();
  if (typeof retrScheduleIndex === 'function') retrScheduleIndex();
}

// ── 构建注入内容 ──
function buildContextBufferPrompt() {
  const buf = getCtxBuffer();
  if (!buf.length) return '';
  const icon = {webpage:'🌐',paper:'📄',file:'📎',search:'🔍',text:'📝'};
  let prompt = '\n\n[知识库索引] 以下是你的缓存资料清单（仅标题与体积，正文未注入）。'
    + '检索方式：先用 ctx_search(query, top_k) 跨全部条目做关键词检索，拿到命中片段、来源 ID 与字符位置；'
    + '需要更多上下文时用 ctx_read(id, offset, length) 从该位置分页续读（每页上限 15000 字符，返回值会给出下一段 offset）。'
    + '不再需要的条目用 ctx_delete 删除。\n';
  for (const item of buf) {
    const ic = icon[item.type] || '📄';
    const tokStr = item.tokens ? ` (~${item.tokens.toLocaleString()} tok` : '';
    const lenStr = tokStr ? `${tokStr}, ${(item.content || '').length} 字符)` : '';
    prompt += `  ID=${item.id} ${ic} ${item.name}${lenStr}\n`;
  }
  prompt += `共 ${buf.length} 条缓存。不要凭标题猜内容，也不要一次性读全文：先 ctx_search 定位，再按需 ctx_read 分页精读。\n[/知识库索引]\n`;
  return prompt;
}
