/* ============================================================
   ETA (Edge Thin Agent) — 导出增强（PDF 打印 / 单文件 HTML）
   ------------------------------------------------------------
   PDF：不引入 jsPDF（要额外 200KB 且中文字体是老大难），改走浏览器打印。
   css/styles.css 里配了 @media print 规则，把侧栏/输入区/面板全部隐藏，
   只留消息内容，用户在打印对话框里选「另存为 PDF」即可。

   单文件 HTML：把渲染后的 HTML + 内联样式 + 图片 base64 打成一个文件。
   图片本来就是 dataUrl（见 storage.js 的 blob 拆分），天然可内嵌。
   代码高亮与公式在离线文件里降级为纯文本块 —— 不为了好看去内联 900KB 的库。
   ============================================================ */

// ── PDF：调起打印 ──
function exportConversationPdf() {
  const conv = getActiveConv();
  if (!conv) { toast(STATE.lang === 'en' ? 'No active conversation' : '没有活跃对话', 'fail'); return; }
  const isZh = STATE.lang !== 'en';
  // 打印时 document.title 就是默认文件名
  const oldTitle = document.title;
  document.title = (conv.title || 'ETA chat').slice(0, 80);
  toast(isZh ? '已调起打印，请在对话框中选择「另存为 PDF」' : 'Print dialog opened — choose "Save as PDF"', 'info');
  const cleanup = () => { document.title = oldTitle; };
  // afterprint 在部分浏览器不触发，加个兜底定时器
  window.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(() => { try { window.print(); } catch (e) { cleanup(); } }, 60);
  setTimeout(cleanup, 60000);
}

/* ── 单文件 HTML ──
   自包含、可离线双击打开。样式内联（只取需要的那一小撮），
   图片用消息节点里已有的 dataUrl 直接嵌入。 */
function exportConversationHtml() {
  const conv = getActiveConv();
  if (!conv) { toast(STATE.lang === 'en' ? 'No active conversation' : '没有活跃对话', 'fail'); return; }
  const html = buildStandaloneHtml(conv);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (conv.title || 'chat').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(STATE.lang === 'en' ? 'Single-file HTML exported' : '已导出单文件 HTML', 'ok');
}

// 组装完整文档（纯函数，便于 node 下断言结构）
function buildStandaloneHtml(conv) {
  const path = (typeof getActivePath === 'function') ? getActivePath(conv) : [];
  const title = String((conv && conv.title) || 'ETA Chat');
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  let body = '';
  for (const node of path) {
    const isUser = node.role === 'user';
    const role = isUser ? '👤 User' : '🤖 Assistant';
    let inner = '';
    for (const att of (node.attachments || [])) {
      if (att && att.type && att.type.startsWith('image/') && att.dataUrl) {
        inner += `<div class="att"><img src="${esc(att.dataUrl)}" alt="${esc(att.name || 'image')}"></div>`;
      }
    }
    for (const fn of (node.fileNames || [])) inner += `<div class="chip">📄 ${esc(fn)}</div>`;
    if (node.thinking) {
      inner += `<details class="think"><summary>🧠 思考过程 (${String(node.thinking).length} 字)</summary>`
        + `<pre>${esc(node.thinking)}</pre></details>`;
    }
    inner += `<div class="text">${mdToStaticHtml(String(node.content || ''), esc)}</div>`;
    const meta = [esc(node.time || ''), node.model ? esc(node.model) : '',
      (node.usage && node.usage.completion_tokens) ? node.usage.completion_tokens + ' out tokens' : '']
      .filter(Boolean).join(' · ');
    body += `<div class="msg ${isUser ? 'user' : 'ai'}">`
      + `<div class="head"><span class="role">${role}</span><span class="meta">${meta}</span></div>`
      + inner + `</div>`;
  }
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STANDALONE_CSS}</style>
</head><body>
<h1>${esc(title)}</h1>
<div class="sub">ETA — Edge Thin Agent · ${esc(new Date().toLocaleString())} · ${path.length} messages</div>
${body}
</body></html>`;
}

// 内联样式：只覆盖导出文件需要的部分，深浅色由 prefers-color-scheme 决定
const STANDALONE_CSS = `
:root{--bg:#fff;--fg:#1e293b;--muted:#64748b;--line:#e2e8f0;--card:#f8fafc;--accent:#6366f1}
@media (prefers-color-scheme:dark){
:root{--bg:#0a0a0f;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e1e2e;--card:#16161f}}
*{box-sizing:border-box}
body{margin:0 auto;padding:32px 20px 64px;max-width:860px;background:var(--bg);color:var(--fg);
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;line-height:1.7}
h1{font-size:1.5rem;margin:0 0 4px}
.sub{color:var(--muted);font-size:.8rem;margin-bottom:28px}
.msg{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:16px;background:var(--card)}
.msg.user{background:transparent}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:8px}
.role{font-size:.78rem;font-weight:700;letter-spacing:.03em;color:var(--accent)}
.meta{font-size:.7rem;color:var(--muted)}
.text{font-size:.92rem;word-break:break-word}
.text p{margin:0 0 .6em}
.text pre{background:rgba(99,102,241,.08);border:1px solid var(--line);border-radius:8px;
padding:12px;overflow-x:auto;font-size:.8rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.text code{font-family:'Fira Code',Consolas,monospace;font-size:.85em}
.text :not(pre)>code{background:rgba(99,102,241,.12);padding:1px 5px;border-radius:4px}
.text blockquote{margin:.5em 0;padding-left:12px;border-left:3px solid var(--line);color:var(--muted)}
.text table{border-collapse:collapse;margin:.6em 0;font-size:.85rem}
.text th,.text td{border:1px solid var(--line);padding:5px 9px;text-align:left}
.att img{max-width:100%;max-height:340px;border-radius:8px;border:1px solid var(--line);margin-bottom:8px}
.chip{display:inline-block;font-size:.78rem;color:var(--muted);border:1px solid var(--line);
border-radius:6px;padding:3px 9px;margin:0 6px 8px 0}
.think{margin-bottom:10px;font-size:.82rem;color:var(--muted)}
.think summary{cursor:pointer}
.think pre{background:transparent;border:none;padding:6px 0;color:var(--muted)}
@media print{body{padding:0;max-width:none}.msg{break-inside:avoid;border-color:#ccc;background:#fff}}
`;

/* Markdown → 静态 HTML（不依赖 marked/DOMPurify，导出文件里没有它们）
   刻意只做最小子集：代码块、标题、列表、引用、粗斜体、行内代码、链接、表格。
   所有文本先转义再拼标签，因此不会引入可执行内容。 */
function mdToStaticHtml(src, esc) {
  const escape = esc || (s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const blocks = [];
  // 先把围栏代码块摘出来，避免其内部内容被后续规则改写
  let text = String(src || '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code class="lang-${escape(lang || 'text')}">${escape(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  const inline = s => {
    let out = escape(s);
    out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => `<img src="${url}" alt="${alt}">`);
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label, url) =>
      /^(https?:|mailto:|#)/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : label);
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return out;
  };

  const lines = text.split('\n');
  let html = '';
  let listType = null;
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ph = line.match(/^\u0000B(\d+)\u0000$/);
    if (ph) { closeList(); html += blocks[Number(ph[1])]; continue; }
    if (!line.trim()) { closeList(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const lv = h[1].length; html += `<h${lv}>${inline(h[2])}</h${lv}>`; continue; }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { closeList(); html += '<hr>'; continue; }
    const q = line.match(/^>\s?(.*)$/);
    if (q) { closeList(); html += `<blockquote>${inline(q[1])}</blockquote>`; continue; }
    // 表格：当前行是 | a | b |，下一行是分隔行
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      closeList();
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      let tbl = `<table><thead><tr>${cells(line).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tbl += `<tr>${cells(lines[i]).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`;
        i++;
      }
      i--;
      html += tbl + '</tbody></table>';
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) { closeList(); html += `<${want}>`; listType = want; }
      html += `<li>${inline((ul || ol)[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

// ── 导出菜单：把三种格式收进一个模态框（原有 exportConversation 保持不变）──
function showExportModal() {
  const isZh = STATE.lang !== 'en';
  showModal(isZh ? '📥 导出对话' : '📥 Export', `
    <div class="ex-list">
      <button class="ex-item" onclick="closeModal();exportConversation()">
        <span class="ex-ico">📄</span><span><b>Markdown (.md)</b>
        <small>${isZh ? '纯文本，适合再编辑' : 'Plain text, easy to edit'}</small></span></button>
      <button class="ex-item" onclick="closeModal();exportConversationHtml()">
        <span class="ex-ico">🌐</span><span><b>${isZh ? '单文件 HTML' : 'Single-file HTML'}</b>
        <small>${isZh ? '图片内嵌、样式内联，离线可直接打开' : 'Images and styles inlined, opens offline'}</small></span></button>
      <button class="ex-item" onclick="closeModal();exportConversationPdf()">
        <span class="ex-ico">🖨</span><span><b>PDF</b>
        <small>${isZh ? '走浏览器打印，在对话框里选「另存为 PDF」' : 'Via browser print — choose "Save as PDF"'}</small></span></button>
      <button class="ex-item" onclick="closeModal();exportAllConversations()">
        <span class="ex-ico">📦</span><span><b>${isZh ? '全部对话 (JSON)' : 'All chats (JSON)'}</b>
        <small>${isZh ? '完整备份，可再导入' : 'Full backup'}</small></span></button>
    </div>`);
}
