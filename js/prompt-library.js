/* ============================================================
   ETA (Edge Thin Agent) — Prompt 模板库 + 全局对话搜索
   ------------------------------------------------------------
   模板库：预设角色与常用指令，一键填入输入框或设为 system prompt。
   存 IndexedDB（复用 main store，键 p4:prompts），可增删改。

   全局搜索：跨所有会话检索消息正文。分词与 BM25 打分复用
   js/retrieval.js 的 retrTokenize / retrBM25Search（第三期已实现），
   把每条消息当作一个"块"临时建索引；retrieval.js 未加载时退化为子串匹配。
   ============================================================ */

const PL_KEY = 'p4:prompts';

// 内置模板：首次加载时写入，用户可改可删
const PL_BUILTIN = [
  { id: 'b1', name: '代码审查员', role: 'system', text: '你是一位资深工程师。审查我给出的代码，按「正确性 → 安全 → 性能 → 可读性」四层给出问题清单，每条指明行号、原因和修法。不要重写整个文件，只给最小必要的 diff。' },
  { id: 'b2', name: '论文精读', role: 'system', text: '你是学术阅读助手。对我给出的论文，输出：① 一句话结论 ② 问题设定与动机 ③ 方法核心（含关键公式含义）④ 实验设计与主要数字 ⑤ 局限与可质疑处 ⑥ 与相关工作的差异。用中文，术语保留英文原词。' },
  { id: 'b3', name: '英文润色', role: 'user', text: '请把下面的文字改写成地道、简洁的学术英文，保持原意与专业术语，不要添加新内容。给出修改后的版本，并用列表说明主要改动点：\n\n' },
  { id: 'b4', name: '逐步推理', role: 'user', text: '请一步步推理这个问题，先列出已知条件与待求目标，再分步推导，每步说明依据，最后给出结论并自检一次：\n\n' },
  { id: 'b5', name: '数据分析', role: 'system', text: '你是数据分析师。拿到数据后先用 run_python 探查结构与缺失值，再做统计与可视化。所有数字必须由代码算出，禁止估算。结论部分要指出不确定性来源。' },
  { id: 'b6', name: '文献调研', role: 'user', text: '请围绕以下主题做文献调研：先用 search_arxiv 与 search_scholar 各检索一轮，挑出最相关的 5-8 篇，逐篇给出「标题 / 作者年份 / 核心贡献 / 与本主题的关系」，最后总结研究脉络与空白点。主题：\n\n' },
];

let PL_ITEMS = [];
let _plLoaded = false;

async function plLoad() {
  if (_plLoaded) return PL_ITEMS;
  try {
    const saved = await idbGet(PL_KEY);
    if (Array.isArray(saved)) PL_ITEMS = saved.map(plNormalize).filter(Boolean);
    else { PL_ITEMS = PL_BUILTIN.map(plNormalize); await plSave(); }
  } catch (e) {
    console.warn('[Prompts] 读取失败，用内置模板:', e);
    PL_ITEMS = PL_BUILTIN.map(plNormalize);
  }
  _plLoaded = true;
  return PL_ITEMS;
}

async function plSave() {
  try { await idbSet(PL_KEY, PL_ITEMS); }
  catch (e) { console.warn('[Prompts] 保存失败:', e); }
}

function plNormalize(t) {
  if (!t || typeof t !== 'object') return null;
  const text = String(t.text || '').trim();
  const name = String(t.name || '').trim();
  if (!name || !text) return null;
  return {
    id: String(t.id || (typeof uid === 'function' ? uid() : Date.now().toString(36))),
    name: name.slice(0, 60),
    role: t.role === 'system' ? 'system' : 'user',
    text,
  };
}

function plList() { return PL_ITEMS; }

// ── 应用模板 ──
function plApply(id) {
  const t = PL_ITEMS.find(x => x.id === id);
  if (!t) return;
  const isZh = STATE.lang !== 'en';
  if (t.role === 'system') {
    const box = $('cfgSystem');
    if (box) { box.value = t.text; saveConfig(); }
    toast((isZh ? '已设为 System Prompt: ' : 'Set as system prompt: ') + t.name, 'ok');
  } else {
    const input = $('userInput');
    if (input) {
      input.value = t.text + (input.value ? input.value : '');
      autoResize(input);
      input.focus();
    }
    toast((isZh ? '已填入输入框: ' : 'Inserted: ') + t.name, 'ok');
  }
  closeModal();
}

// ── 管理界面 ──
async function showPromptLibraryModal() {
  await plLoad();
  const isZh = STATE.lang !== 'en';
  const rows = PL_ITEMS.length ? PL_ITEMS.map(t => `
    <div class="pl-row">
      <div class="pl-row-main" onclick="plApply('${t.id}')" title="${isZh ? '点击应用' : 'Click to apply'}">
        <div class="pl-row-name">${escHtml(t.name)}
          <span class="pl-role pl-role-${t.role}">${t.role === 'system' ? 'system' : (isZh ? '填入输入框' : 'insert')}</span></div>
        <div class="pl-row-text">${escHtml(t.text.slice(0, 140))}</div>
      </div>
      <div class="pl-row-ops">
        <button class="btn btn-ghost btn-sm" onclick="plEdit('${t.id}')">✎</button>
        <button class="btn btn-ghost btn-sm" onclick="plDelete('${t.id}')">🗑</button>
      </div>
    </div>`).join('')
    : `<div class="ct-empty">${isZh ? '还没有模板' : 'No templates yet'}</div>`;
  showModal(isZh ? '📝 Prompt 模板库' : '📝 Prompt Library', `
    <div class="pl-wrap">
      <div class="pl-list">${rows}</div>
      <div class="ct-bar">
        <button class="btn btn-primary btn-sm" onclick="plEdit('')">＋ ${isZh ? '新建' : 'New'}</button>
        <button class="btn btn-ghost btn-sm" onclick="plRestoreBuiltin()">↺ ${isZh ? '恢复内置' : 'Restore builtin'}</button>
      </div>
      <div class="ct-note">${isZh
        ? 'role=system 的模板会写入侧栏 System Prompt；其余模板填入输入框，原有内容保留在后面。'
        : 'system templates overwrite the sidebar System Prompt; others are inserted into the input box.'}</div>
    </div>`);
}

function plEdit(id) {
  const isZh = STATE.lang !== 'en';
  const t = PL_ITEMS.find(x => x.id === id) || { id: '', name: '', role: 'user', text: '' };
  const inp = 'width:100%;background:var(--input-bg);border:1px solid var(--border);border-radius:6px;'
    + 'padding:7px 10px;color:var(--text);font-size:.8rem;outline:none;font-family:var(--font)';
  showModal(id ? (isZh ? '✎ 编辑模板' : '✎ Edit template') : (isZh ? '＋ 新建模板' : '＋ New template'), `
    <div class="ct-form">
      <input type="hidden" id="plfId" value="${escHtml(t.id)}">
      <label>${isZh ? '名称' : 'Name'}</label>
      <input id="plfName" style="${inp}" value="${escHtml(t.name)}">
      <label>${isZh ? '用途' : 'Target'}</label>
      <select id="plfRole" style="${inp}">
        <option value="user" ${t.role === 'user' ? 'selected' : ''}>${isZh ? '填入输入框' : 'Insert into input'}</option>
        <option value="system" ${t.role === 'system' ? 'selected' : ''}>${isZh ? '设为 System Prompt' : 'Set as system prompt'}</option>
      </select>
      <label>${isZh ? '内容' : 'Content'}</label>
      <textarea id="plfText" rows="8" style="${inp}">${escHtml(t.text)}</textarea>
      <div class="ct-bar" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="plSubmit()">${isZh ? '保存' : 'Save'}</button>
        <button class="btn btn-ghost btn-sm" onclick="showPromptLibraryModal()">${isZh ? '返回' : 'Back'}</button>
      </div>
    </div>`);
}

async function plSubmit() {
  const id = ($('plfId') || {}).value || '';
  const draft = plNormalize({
    id: id || (typeof uid === 'function' ? uid() : String(Date.now())),
    name: ($('plfName') || {}).value,
    role: ($('plfRole') || {}).value,
    text: ($('plfText') || {}).value,
  });
  if (!draft) { toast(STATE.lang === 'en' ? 'Name and content are required' : '名称和内容不能为空', 'fail'); return; }
  const idx = PL_ITEMS.findIndex(x => x.id === draft.id);
  if (idx >= 0) PL_ITEMS[idx] = draft; else PL_ITEMS.push(draft);
  await plSave();
  showPromptLibraryModal();
  toast(STATE.lang === 'en' ? 'Saved' : '已保存', 'ok');
}

async function plDelete(id) {
  const t = PL_ITEMS.find(x => x.id === id);
  if (!t) return;
  if (!confirm((STATE.lang === 'en' ? 'Delete template ' : '确定删除模板 ') + t.name + ' ?')) return;
  PL_ITEMS = PL_ITEMS.filter(x => x.id !== id);
  await plSave();
  showPromptLibraryModal();
}

async function plRestoreBuiltin() {
  const have = new Set(PL_ITEMS.map(t => t.name));
  for (const b of PL_BUILTIN) if (!have.has(b.name)) PL_ITEMS.push(plNormalize(b));
  await plSave();
  showPromptLibraryModal();
  toast(STATE.lang === 'en' ? 'Builtin templates restored' : '已补回内置模板', 'ok');
}

/* ── 全局对话搜索 ──
   打分复用 js/retrieval.js 的 retrTokenize + retrBM25Search：把每条消息
   包成一个 chunk，itemId = "convId|msgId"，直接喂进现成的 BM25 实现。
   retrieval.js 未加载时退化为不区分大小写的子串匹配。 */
function gsHasBM25() {
  return typeof retrTokenize === 'function' && typeof retrBM25Search === 'function'
    && typeof retrTermFreq === 'function';
}

// 收集全部会话的消息为可检索单元
function gsCollectDocs() {
  const docs = [];
  for (const conv of Object.values((typeof STATE !== 'undefined' && STATE.conversations) || {})) {
    if (!conv || !conv.tree) continue;
    for (const node of Object.values(conv.tree)) {
      const text = String((node && node.content) || '').trim();
      if (!text) continue;
      docs.push({ convId: conv.id, convTitle: conv.title || '', msgId: node.id, role: node.role, text });
    }
  }
  return docs;
}

function gsSearch(query, topK) {
  const q = String(query || '').trim();
  if (!q) return [];
  const k = Math.max(1, Math.min(100, parseInt(topK, 10) || 30));
  const docs = gsCollectDocs();
  if (!docs.length) return [];
  if (gsHasBM25()) {
    // 拼成 retrBM25Search 期望的 index 结构：items[itemId].chunks[]
    const items = Object.create(null);
    for (const d of docs) {
      const tokens = retrTokenize(d.text);
      items[d.convId + '|' + d.msgId] = { chunks: [{ s: 0, e: d.text.length, dl: tokens.length, tf: retrTermFreq(tokens) }] };
    }
    const hits = retrBM25Search({ items }, q, k);
    const byKey = new Map(docs.map(d => [d.convId + '|' + d.msgId, d]));
    return hits.map(h => {
      const d = byKey.get(h.itemId);
      if (!d) return null;
      return Object.assign({}, d, { score: h.score, snippet: gsSnippet(d.text, q), engine: 'bm25' });
    }).filter(Boolean);
  }
  // 退化路径：子串匹配，按出现次数粗排
  const needle = q.toLowerCase();
  const out = [];
  for (const d of docs) {
    const lower = d.text.toLowerCase();
    let pos = lower.indexOf(needle), n = 0;
    while (pos !== -1 && n < 50) { n++; pos = lower.indexOf(needle, pos + needle.length); }
    if (n) out.push(Object.assign({}, d, { score: n, snippet: gsSnippet(d.text, q), engine: 'substring' }));
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

// 命中片段：定位第一个匹配位置，取前后文并高亮关键词
function gsSnippet(text, query, pad) {
  const src = String(text || '');
  const p = Number(pad) || 90;
  const needle = String(query || '').trim().toLowerCase();
  let at = needle ? src.toLowerCase().indexOf(needle) : -1;
  if (at === -1 && needle) {
    // 整串没命中（BM25 是分词命中），退而找最长的单个词
    const parts = needle.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const part of parts) { at = src.toLowerCase().indexOf(part); if (at !== -1) break; }
  }
  if (at === -1) at = 0;
  const from = Math.max(0, at - p);
  const to = Math.min(src.length, at + p * 2);
  return (from > 0 ? '…' : '') + src.slice(from, to).replace(/\s+/g, ' ').trim() + (to < src.length ? '…' : '');
}

// 把命中词包成 <mark>（输入已经过 escHtml，这里对转义后的文本做替换）
function gsHighlight(escapedText, query) {
  const terms = String(query || '').trim().split(/\s+/).filter(t => t.length >= 1).slice(0, 6);
  let out = escapedText;
  for (const term of terms) {
    const safe = escHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!safe) continue;
    out = out.replace(new RegExp(safe, 'gi'), m => `<mark class="gs-mark">${m}</mark>`);
  }
  return out;
}

// ── 侧栏搜索交互 ──
let _gsTimer = null;

function gsInputChanged() {
  if (_gsTimer) clearTimeout(_gsTimer);
  _gsTimer = setTimeout(() => { _gsTimer = null; gsRender(); }, 250);
}

function gsKey(event) {
  if (event.key === 'Enter') { event.preventDefault(); gsRender(); }
  if (event.key === 'Escape') { const i = $('gsInput'); if (i) { i.value = ''; } gsRender(); }
}

function gsRender() {
  const input = $('gsInput');
  const box = $('gsResults');
  const convList = $('convList');
  if (!input || !box) return;
  const q = input.value.trim();
  const isZh = STATE.lang !== 'en';
  if (!q) {
    box.innerHTML = '';
    box.style.display = 'none';
    if (convList) convList.style.display = '';
    return;
  }
  box.style.display = 'block';
  if (convList) convList.style.display = 'none';
  let hits = [];
  try { hits = gsSearch(q, 40); }
  catch (e) { box.innerHTML = `<div class="gs-empty">${escHtml((isZh ? '搜索失败: ' : 'Search failed: ') + e.message)}</div>`; return; }
  if (!hits.length) {
    box.innerHTML = `<div class="gs-empty">${isZh ? '没有匹配的消息' : 'No matching messages'}</div>`;
    return;
  }
  const engineTag = hits[0].engine === 'bm25' ? 'BM25' : (isZh ? '子串匹配' : 'substring');
  box.innerHTML = `<div class="gs-count">${hits.length} ${isZh ? '条结果' : 'results'} · ${engineTag}</div>`
    + hits.map(h => `<div class="gs-hit" onclick="gsJump('${h.convId}','${h.msgId}')">
        <div class="gs-hit-head"><span class="gs-hit-role">${h.role === 'user' ? '👤' : '🤖'}</span>
          <span class="gs-hit-conv">${escHtml(h.convTitle || (isZh ? '未命名对话' : 'Untitled'))}</span></div>
        <div class="gs-hit-text">${gsHighlight(escHtml(h.snippet), q)}</div>
      </div>`).join('');
}

// 跳到命中的消息：切会话 + 把 activeLeaf 落到该节点所在的分支末端
function gsJump(convId, msgId) {
  const conv = STATE.conversations[convId];
  if (!conv || !conv.tree[msgId]) { toast(STATE.lang === 'en' ? 'Message no longer exists' : '该消息已不存在', 'fail'); return; }
  STATE.activeConvId = convId;
  let leaf = msgId;
  while (true) {
    const n = conv.tree[leaf];
    if (!n || !n.children || !n.children.length) break;
    leaf = n.children[n.children.length - 1];
  }
  conv.activeLeaf = leaf;
  saveState();
  renderConvList();
  renderChat();
  renderCtxBuffer();
  requestAnimationFrame(() => {
    const el = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('gs-flash');
      setTimeout(() => el.classList.remove('gs-flash'), 1600);
    }
  });
}

// 启动时预热模板库（不阻塞首屏）
if (typeof document !== 'undefined') setTimeout(() => { plLoad(); }, 0);
