/* ============================================================
   ETA (Edge Thin Agent) — Knowledge Retrieval (Chunking + BM25)
   ------------------------------------------------------------
   为什么需要它：ctx_read 原先把整条内容塞进上下文并在 15000 字符处硬截断，
   大 PDF 的后半部分直接丢失，且一条就能挤爆上下文窗口。

   方案：入库时把长文切成约 1000 字符、重叠 150 的块，建立纯 JS 的
   BM25 倒排统计（中文二元切分 / 英文按词），检索只回传命中片段及其前后文，
   由模型决定是否再用 ctx_read 分页精读。

   索引持久化：STORE_BLOBS 内以 `retr:idx:<convId>` 为键存整份索引
   （复用现有 store，避免动 IndexedDB 版本号）。索引只存块边界与词频，
   不存正文 —— 正文本来就在 conv.contextBuffer 里，避免双份体积。
   ============================================================ */

// ── 参数（改这里即可调优）──
const RETR_CHUNK_SIZE = 1000;      // 目标块长（字符）
const RETR_CHUNK_OVERLAP = 150;    // 相邻块重叠字符数
const RETR_BOUNDARY_WINDOW = 200;  // 向前回溯寻找句子/段落边界的窗口
const RETR_BM25_K1 = 1.5;          // 词频饱和系数
const RETR_BM25_B = 0.75;          // 文档长度归一化强度
const RETR_IDX_PREFIX = 'retr:idx:';
const RETR_IDX_VERSION = 1;
const RETR_CTX_PAD = 200;          // 命中片段回传时额外附带的前后文字符数

// convId -> index 内存缓存，避免每次检索都读 IndexedDB
const _retrIndexCache = new Map();
// 串行化建索引任务，避免并发写同一份索引互相覆盖
let _retrQueue = Promise.resolve();

/* ── 分块 ──
   返回 [{ s, e, text }]，保证：s 严格递增、chunks[0].s===0、末块 e===text.length、
   且 chunks[i].s <= chunks[i-1].e（无空洞），因此按 s/e 可无损拼回原文。 */
function retrChunkText(text) {
  const src = String(text == null ? '' : text);
  const n = src.length;
  const out = [];
  if (!n) return out;
  let start = 0;
  while (start < n) {
    let end = Math.min(start + RETR_CHUNK_SIZE, n);
    if (end < n) {
      const cut = retrFindBoundary(src, start, end);
      // 边界过于靠前会让块碎掉，只有切点仍保有半块以上才采纳
      if (cut > start + Math.floor(RETR_CHUNK_SIZE / 2)) end = cut;
    }
    out.push({ s: start, e: end, text: src.slice(start, end) });
    if (end >= n) break;
    const next = end - RETR_CHUNK_OVERLAP;
    start = next > start ? next : end; // 必须前进，否则死循环
  }
  return out;
}

// 在 [end-窗口, end] 内向前找断点：段落 > 句末标点 > 空白（英文退化到词边界）
function retrFindBoundary(src, start, end) {
  const low = Math.max(start + 1, end - RETR_BOUNDARY_WINDOW);
  for (let i = end; i > low; i--) if (src[i - 1] === '\n') return i;
  for (let i = end; i > low; i--) {
    const ch = src[i - 1];
    if ('。！？；…!?;'.indexOf(ch) !== -1) return i;
    if (ch === '.' && i < src.length && /\s/.test(src[i])) return i;
  }
  for (let i = end; i > low; i--) if (/\s/.test(src[i - 1])) return i;
  return end;
}

/* ── 分词 ──
   英文/数字按空白+标点切并转小写；中文用二元切分（bigram），
   单字成词的情况保留单字，保证短查询（如「熵」）也能命中。 */
function retrTokenize(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  const tokens = [];
  const re = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+|[a-z0-9_][a-z0-9_'+-]*/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const seg = m[0];
    if (/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/.test(seg[0])) {
      if (seg.length === 1) { tokens.push(seg); continue; }
      for (let i = 0; i + 1 < seg.length; i++) tokens.push(seg.slice(i, i + 2));
    } else {
      tokens.push(seg.replace(/^[-'+]+|[-'+]+$/g, '') || seg);
    }
  }
  return tokens;
}

function retrTermFreq(tokens) {
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

// ── 条目指纹：内容长度 + 轻量哈希，用于判断索引是否过期 ──
function retrFingerprint(content) {
  const s = String(content == null ? '' : content);
  let h = 5381;
  // 长文本抽样哈希：全量遍历几 MB 文本没必要，步长采样已足够识别变更
  const step = s.length > 20000 ? Math.floor(s.length / 4000) : 1;
  for (let i = 0; i < s.length; i += step) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return s.length + ':' + h.toString(36);
}

// ── 给单个缓存条目建索引（纯函数，可在 node 下单测）──
function retrIndexItem(item) {
  const content = String(item && item.content ? item.content : '');
  const chunks = retrChunkText(content).map(c => {
    const tokens = retrTokenize(c.text);
    return { s: c.s, e: c.e, dl: tokens.length, tf: retrTermFreq(tokens) };
  });
  return {
    fp: retrFingerprint(content),
    name: (item && item.name) || '',
    type: (item && item.type) || 'text',
    total: content.length,
    chunks,
  };
}

/* ── BM25 检索 ──
   index: { items: { itemId: {chunks:[{s,e,dl,tf}], ...} } }
   返回 [{ itemId, chunkIdx, s, e, score, matched:[term...] }]，按分数降序。 */
function retrBM25Search(index, query, topK) {
  const qTokens = retrTokenize(query);
  if (!qTokens.length) return [];
  const qTerms = Array.from(new Set(qTokens));
  const items = (index && index.items) || {};

  // 语料统计：N=块总数、df=含该词的块数、avgdl=平均块长
  const docs = [];
  let totalLen = 0;
  for (const [itemId, entry] of Object.entries(items)) {
    const chunks = (entry && entry.chunks) || [];
    for (let i = 0; i < chunks.length; i++) {
      docs.push({ itemId, chunkIdx: i, c: chunks[i] });
      totalLen += chunks[i].dl || 0;
    }
  }
  const N = docs.length;
  if (!N) return [];
  const avgdl = totalLen / N || 1;
  const df = Object.create(null);
  for (const d of docs) for (const t of qTerms) if (d.c.tf[t]) df[t] = (df[t] || 0) + 1;

  const idf = Object.create(null);
  for (const t of qTerms) {
    const n = df[t] || 0;
    // 标准 BM25 概率型 idf，加 1 保证非负（避免高频词把总分拉成负数）
    idf[t] = Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  const hits = [];
  for (const d of docs) {
    let score = 0;
    const matched = [];
    for (const t of qTerms) {
      const f = d.c.tf[t];
      if (!f) continue;
      const dl = d.c.dl || 1;
      const norm = f * (RETR_BM25_K1 + 1) / (f + RETR_BM25_K1 * (1 - RETR_BM25_B + RETR_BM25_B * dl / avgdl));
      score += idf[t] * norm;
      matched.push(t);
    }
    if (score > 0) hits.push({ itemId: d.itemId, chunkIdx: d.chunkIdx, s: d.c.s, e: d.c.e, score, matched });
  }
  hits.sort((a, b) => b.score - a.score || a.s - b.s);
  const k = Math.max(1, Math.min(50, parseInt(topK, 10) || 5));
  return hits.slice(0, k);
}

// ── 索引持久化（复用 STORE_BLOBS，键前缀 retr:idx:）──
function retrIdxKey(convId) { return RETR_IDX_PREFIX + convId; }

async function retrLoadIndex(convId) {
  if (!convId) return { v: RETR_IDX_VERSION, items: {} };
  if (_retrIndexCache.has(convId)) return _retrIndexCache.get(convId);
  let idx = null;
  try { idx = await idbGetBlob(retrIdxKey(convId)); } catch (e) { idx = null; }
  if (!idx || idx.v !== RETR_IDX_VERSION || typeof idx.items !== 'object') {
    idx = { v: RETR_IDX_VERSION, items: {} };
  }
  _retrIndexCache.set(convId, idx);
  return idx;
}

async function retrSaveIndex(convId, idx) {
  if (!convId) return;
  _retrIndexCache.set(convId, idx);
  try { await idbSetBlob(retrIdxKey(convId), idx); }
  catch (e) { console.warn('[Retrieval] 索引落盘失败:', e); }
}

/* ── 增量构建当前对话的索引（异步、不阻塞 UI）──
   只为指纹变化或新出现的条目重建；已消失的条目顺手清理。
   所有入库点（ctxAddItem / ctxAutoSaveSearch / ctxAutoSaveFetch）都调它。 */
function retrScheduleIndex(convId) {
  const cid = convId || (typeof STATE !== 'undefined' ? STATE.activeConvId : null);
  if (!cid) return _retrQueue;
  _retrQueue = _retrQueue.then(() => retrBuildIndex(cid)).catch(e => console.warn('[Retrieval] 建索引失败:', e));
  return _retrQueue;
}

async function retrBuildIndex(convId) {
  const conv = (typeof STATE !== 'undefined' && STATE.conversations) ? STATE.conversations[convId] : null;
  if (!conv) return null;
  const buf = conv.contextBuffer || [];
  const idx = await retrLoadIndex(convId);
  const alive = new Set();
  let changed = false;
  for (const item of buf) {
    if (!item || !item.id) continue;
    alive.add(item.id);
    const fp = retrFingerprint(item.content || '');
    const old = idx.items[item.id];
    if (old && old.fp === fp) {
      // 内容未变但重命名过，同步元数据即可
      if (old.name !== item.name) { old.name = item.name; changed = true; }
      continue;
    }
    idx.items[item.id] = retrIndexItem(item);
    changed = true;
    await new Promise(r => setTimeout(r, 0)); // 让出主线程，长 PDF 不卡 UI
  }
  for (const id of Object.keys(idx.items)) {
    if (!alive.has(id)) { delete idx.items[id]; changed = true; }
  }
  if (changed) await retrSaveIndex(convId, idx);
  return idx;
}

// ── 条目删除时清理索引 ──
async function retrRemoveItem(itemId, convId) {
  const cid = convId || (typeof STATE !== 'undefined' ? STATE.activeConvId : null);
  if (!cid || !itemId) return;
  const idx = await retrLoadIndex(cid);
  if (idx.items[itemId]) { delete idx.items[itemId]; await retrSaveIndex(cid, idx); }
}

// 清空所有对话时调用：storageClearAll 会清掉 STORE_BLOBS，内存缓存必须一起失效
function retrClearAllIndexes() { _retrIndexCache.clear(); }

async function retrClearConv(convId) {
  const cid = convId || (typeof STATE !== 'undefined' ? STATE.activeConvId : null);
  if (!cid) return;
  _retrIndexCache.delete(cid);
  try { await idbDelBlob(retrIdxKey(cid)); } catch (e) {}
}

/* ── 高层检索：跨当前对话所有缓存条目 ──
   返回 [{ itemId, name, type, s, e, score, total, snippet }]，
   snippet 是命中块 + 前后各 RETR_CTX_PAD 字符的上下文。 */
async function retrSearch(query, topK, convId) {
  const cid = convId || (typeof STATE !== 'undefined' ? STATE.activeConvId : null);
  const conv = (cid && typeof STATE !== 'undefined') ? STATE.conversations[cid] : null;
  if (!conv) return [];
  const buf = conv.contextBuffer || [];
  if (!buf.length) return [];
  // 索引可能还没建（刚刷新、或旧对话），先补齐再查
  let idx = await retrLoadIndex(cid);
  const needBuild = buf.some(it => it && it.id && !idx.items[it.id]);
  if (needBuild) idx = (await retrBuildIndex(cid)) || idx;

  const hits = retrBM25Search(idx, query, topK);
  const byId = new Map(buf.map(i => [i.id, i]));
  return hits.map(h => {
    const item = byId.get(h.itemId);
    const content = item ? String(item.content || '') : '';
    const from = Math.max(0, h.s - RETR_CTX_PAD);
    const to = Math.min(content.length, h.e + RETR_CTX_PAD);
    return {
      itemId: h.itemId,
      name: item ? item.name : (idx.items[h.itemId] || {}).name || '?',
      type: item ? item.type : 'text',
      s: h.s, e: h.e, from, to,
      total: content.length,
      score: h.score,
      matched: h.matched,
      snippet: content.slice(from, to),
    };
  });
}

// ── 供 ctx_search 工具使用：把检索结果格式化成给模型看的文本 ──
function retrFormatForLLM(query, hits) {
  if (!hits.length) return `[ctx_search: 未在知识库中找到与 "${query}" 相关的片段]`;
  let out = `[ctx_search 结果] 查询: "${query}"，命中 ${hits.length} 个片段。\n`
    + `每个片段标注了来源条目 ID 与在原文中的字符区间；需要更完整的上下文时，`
    + `调用 ctx_read 并传入该 ID 与 offset（可用片段起点附近的位置）继续分页读取。\n\n`;
  hits.forEach((h, i) => {
    out += `── 片段 ${i + 1} | ID=${h.itemId} | 来源: ${h.name} | 位置 ${h.from}-${h.to} / 共 ${h.total} 字符 | 相关度 ${h.score.toFixed(2)}\n`;
    out += h.snippet.trim() + '\n\n';
  });
  out += `[/ctx_search 结果]`;
  return out;
}

// ── 缓存区面板检索框 ──
async function ctxPanelSearch() {
  const input = $('ctxSearchInput');
  const box = $('ctxSearchResults');
  if (!input || !box) return;
  const q = input.value.trim();
  const isZh = STATE.lang !== 'en';
  if (!q) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = `<div class="ctx-search-empty">${isZh ? '检索中…' : 'Searching…'}</div>`;
  let hits = [];
  try { hits = await retrSearch(q, 8); }
  catch (e) { box.innerHTML = `<div class="ctx-search-empty">${escHtml((isZh ? '检索失败: ' : 'Search failed: ') + e.message)}</div>`; return; }
  if (!hits.length) {
    box.innerHTML = `<div class="ctx-search-empty">${isZh ? '没有匹配的片段' : 'No matching passages'}</div>`;
    return;
  }
  box.innerHTML = hits.map(h => {
    const preview = h.snippet.replace(/\s+/g, ' ').trim().slice(0, 160);
    return `<div class="ctx-search-hit" onclick="ctxJumpToHit('${h.itemId}',${h.from},${h.to})">
      <div class="ctx-search-hit-head">${escHtml(h.name)}
        <span class="ctx-search-hit-pos">${h.from}-${h.to} / ${h.total}</span></div>
      <div class="ctx-search-hit-text">${escHtml(preview)}</div>
    </div>`;
  }).join('');
}

// 点击命中片段：打开条目预览并把片段区间高亮出来
function ctxJumpToHit(itemId, from, to) {
  const item = getCtxBuffer().find(i => i.id === itemId);
  if (!item) { toast(STATE.lang === 'en' ? 'Entry no longer exists' : '该条目已不存在', 'fail'); return; }
  const content = String(item.content || '');
  const lead = content.slice(Math.max(0, from - 400), from);
  const hit = content.slice(from, to);
  const tail = content.slice(to, Math.min(content.length, to + 400));
  const isZh = STATE.lang !== 'en';
  showModal(`🔍 ${escHtml(item.name)}`, `
    <div style="font-size:.78rem;color:var(--text3);margin-bottom:8px">
      ${isZh ? '片段位置' : 'Passage'} ${from}-${to} / ${content.length} ${isZh ? '字符' : 'chars'}</div>
    <pre class="ctx-hit-pre">${escHtml(lead)}<mark class="ctx-hit-mark">${escHtml(hit)}</mark>${escHtml(tail)}</pre>`);
}

function ctxSearchKey(event) {
  if (event.key === 'Enter') { event.preventDefault(); ctxPanelSearch(); }
}

// 检索框文案本地化（面板打开时调用；I18N 表在 state.js，此处自带文案避免改动该文件）
function retrLocalizePanel() {
  const input = $('ctxSearchInput');
  if (input) input.placeholder = STATE.lang === 'en' ? 'Search cached content (BM25)...' : '检索缓存内容 (BM25)...';
}

// 对话切换/列表重绘时清掉过期结果（结果里的 itemId 属于上一个对话）
let _retrResultConvId = null;
function retrDropStaleResults() {
  const cid = STATE.activeConvId;
  if (cid === _retrResultConvId) return;
  _retrResultConvId = cid;
  const box = $('ctxSearchResults');
  const input = $('ctxSearchInput');
  if (box) { box.innerHTML = ''; box.style.display = 'none'; }
  if (input) input.value = '';
}

// 输入防抖，避免每敲一个字都跑一遍 BM25
let _ctxSearchTimer = null;
function ctxSearchInputChanged() {
  if (_ctxSearchTimer) clearTimeout(_ctxSearchTimer);
  _ctxSearchTimer = setTimeout(() => { _ctxSearchTimer = null; ctxPanelSearch(); }, 300);
}

/* ── ctx_read 分页切片（纯函数，供 agent-commands.js 使用）──
   不传 offset 时行为与旧版一致（从 0 开始、上限 15000），
   但返回值总会带上总长度与下一段 offset，模型据此继续读。 */
const RETR_READ_DEFAULT_LEN = 15000;

function retrSlicePage(content, offset, length) {
  const src = String(content == null ? '' : content);
  const total = src.length;
  let off = parseInt(offset, 10);
  if (!Number.isFinite(off) || off < 0) off = 0;
  if (off > total) off = total;
  let len = parseInt(length, 10);
  if (!Number.isFinite(len) || len <= 0) len = RETR_READ_DEFAULT_LEN;
  len = Math.min(len, RETR_READ_DEFAULT_LEN);
  const end = Math.min(total, off + len);
  return { total, offset: off, end, text: src.slice(off, end), hasMore: end < total, nextOffset: end < total ? end : null };
}


