/* ============================================================
   ETA (Edge Thin Agent) — 长期记忆 (Long-term Memory)
   ------------------------------------------------------------
   跨对话保留的一小份用户长期信息。设计上刻意做「小而克制」：

   1) 不自动抓取。写入只发生在模型主动调用 memory_write 时，
      判据写在 memGuidancePrompt() 里（只记稳定、跨对话仍有用的信息）。
   2) 硬字符上限。总量超过 memLimit() 就强制压缩：优先用一次 LLM 调用把
      同类条目合并改写，失败则退化为按「最久未被更新」丢弃，绝不无声地
      把整份记忆清空。
   3) 用户是最终所有者。memory-ui.js 提供逐条查看/编辑/删除/清空/导入导出，
      以及一键关闭整个功能。

   存储：storage.js 的 main store，键 'memory:v1'（不动 DB 版本号）。
   记忆是全局的，不隶属任何单个对话。
   ============================================================ */

const MEM_STORE_KEY = 'memory:v1';
const MEM_LIMIT_DEFAULT = 4000;   // 全部条目正文的字符总量上限
const MEM_LIMIT_RANGE = [500, 20000];
const MEM_ENTRY_MAX_CHARS = 400;  // 单条上限，防止模型把整段对话塞进来
const MEM_MAX_ENTRIES = 120;
const MEM_COMPRESS_TARGET = 0.6;  // 压缩目标：降到上限的 60%

let MEM_ENTRIES = [];
let MEM_ENABLED = true;
let MEM_LIMIT = MEM_LIMIT_DEFAULT;
let _memCompressing = false;

function memNormalize(e) {
  if (!e) return null;
  const text = String(e.text == null ? '' : e.text).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // id 会被拼进 onclick 属性，限制字符集免得导入的脏数据拼出可执行内容
  const rawId = String(e.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return {
    id: rawId || uid(),
    text: text.slice(0, MEM_ENTRY_MAX_CHARS),
    createdAt: Number(e.createdAt) || Date.now(),
    updatedAt: Number(e.updatedAt) || Number(e.createdAt) || Date.now(),
    source: e.source === 'user' ? 'user' : 'agent',
  };
}

function memClampLimit(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return MEM_LIMIT_DEFAULT;
  return Math.min(MEM_LIMIT_RANGE[1], Math.max(MEM_LIMIT_RANGE[0], v));
}

// ── 持久化 ──
async function memLoad() {
  try {
    const rec = await idbGet(MEM_STORE_KEY, STORE_MAIN);
    if (rec && typeof rec === 'object') {
      MEM_ENTRIES = Array.isArray(rec.entries) ? rec.entries.map(memNormalize).filter(Boolean) : [];
      MEM_ENABLED = rec.enabled !== false;
      MEM_LIMIT = memClampLimit(rec.limit);
    }
  } catch (e) { console.warn('[Memory] 读取失败:', e); }
  return MEM_ENTRIES;
}

async function memSave() {
  try {
    await idbSet(MEM_STORE_KEY, { enabled: MEM_ENABLED, limit: MEM_LIMIT, entries: MEM_ENTRIES }, STORE_MAIN);
  } catch (e) {
    console.warn('[Memory] 保存失败:', e);
    toast(STATE.lang === 'en' ? 'Failed to save memory' : '长期记忆保存失败', 'fail');
  }
}

// ── 查询 ──
function memList() { return MEM_ENTRIES; }
function memEnabled() { return !!MEM_ENABLED; }
function memLimit() { return memClampLimit(MEM_LIMIT); }
function memTotalChars() { return MEM_ENTRIES.reduce((s, e) => s + e.text.length, 0); }
function memFind(id) { return MEM_ENTRIES.find(e => e.id === id) || null; }

async function memSetEnabled(on) { MEM_ENABLED = !!on; await memSave(); }
async function memSetLimit(n) {
  MEM_LIMIT = memClampLimit(n);
  const r = await memEnsureBudget();
  // 压缩/裁剪会改动 MEM_ENTRIES，必须在其之后落盘，否则新上限下的裁剪结果丢失
  await memSave();
  return r;
}

/* 近似重复检测：模型很容易把「用户偏好简洁回答」这类事实换个说法重写一遍。
   用词集合的 Jaccard 相似度粗判，命中就更新原条目而不是新增。 */
function memTokenSet(text) {
  const s = String(text || '').toLowerCase();
  // 中文按字、西文按词，混排文本两种都能拿到有效特征
  const parts = (s.match(/[a-z0-9]+/g) || []).concat(s.match(/[\u4e00-\u9fff]/g) || []);
  return new Set(parts);
}

function memSimilar(text, excludeId) {
  const a = memTokenSet(text);
  if (!a.size) return null;
  let best = null, bestScore = 0;
  for (const e of MEM_ENTRIES) {
    if (excludeId && e.id === excludeId) continue;
    const b = memTokenSet(e.text);
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const score = inter / (a.size + b.size - inter);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 0.72 ? best : null;
}

/* ── 写入 ──
   传 id 则覆盖该条；不传 id 时先查近似重复，命中即更新。
   返回 { ok, action, id, total, limit, compressed, error }。 */
async function memWrite(rawText, id, source, signal) {
  const entry = memNormalize({ text: rawText, id: id || undefined, source: source || 'agent' });
  if (!entry) return { ok: false, error: 'empty' };
  let action = 'added';
  const target = (id && memFind(id)) || memSimilar(entry.text, id);
  if (target) {
    target.text = entry.text;
    target.updatedAt = Date.now();
    if (source === 'user') target.source = 'user';
    action = 'updated';
  } else {
    if (MEM_ENTRIES.length >= MEM_MAX_ENTRIES) MEM_ENTRIES.shift();
    MEM_ENTRIES.push(entry);
  }
  const budget = await memEnsureBudget(signal);
  await memSave();
  if (typeof memRefreshUi === 'function') memRefreshUi();
  return { ok: true, action, id: (target || entry).id, total: memTotalChars(), limit: memLimit(), compressed: budget.compressed };
}

async function memDelete(id) {
  const i = MEM_ENTRIES.findIndex(e => e.id === id);
  if (i === -1) return { ok: false, error: 'not_found' };
  const gone = MEM_ENTRIES[i];
  MEM_ENTRIES.splice(i, 1);
  await memSave();
  if (typeof memRefreshUi === 'function') memRefreshUi();
  return { ok: true, text: gone.text };
}

async function memClear() {
  MEM_ENTRIES = [];
  await memSave();
  if (typeof memRefreshUi === 'function') memRefreshUi();
}

// ── 预算控制：超上限就压缩 ──
async function memEnsureBudget(signal) {
  if (memTotalChars() <= memLimit()) return { compressed: false };
  const ok = await memCompress(signal);
  // 压缩后仍超标（模型没听话写长了）也要裁到线内，否则上限就是个建议值
  if (!ok || memTotalChars() > memLimit()) memTrimFallback();
  return { compressed: true, byLlm: ok };
}

/* 兜底裁剪：按 updatedAt 升序丢弃，直到降到目标线以下。
   用户手写的条目（source==='user'）排在最后才动，用户的输入优先于模型的猜测。 */
function memTrimFallback() {
  const target = Math.floor(memLimit() * MEM_COMPRESS_TARGET);
  const order = MEM_ENTRIES.slice().sort((a, b) =>
    (a.source === b.source) ? a.updatedAt - b.updatedAt : (a.source === 'user' ? 1 : -1));
  const doomed = new Set();
  let total = memTotalChars();
  for (const e of order) {
    if (total <= target) break;
    doomed.add(e.id);
    total -= e.text.length;
  }
  if (!doomed.size) return;
  MEM_ENTRIES = MEM_ENTRIES.filter(e => !doomed.has(e.id));
  console.warn(`[Memory] LLM 压缩不可用，已按最久未更新丢弃 ${doomed.size} 条`);
  toast(STATE.lang === 'en'
    ? `Memory over limit: dropped ${doomed.size} stale entries`
    : `记忆超出上限，已丢弃 ${doomed.size} 条最久未更新的条目`, 'info');
}

/* LLM 压缩：把全部条目交给模型合并改写成更少、更短的陈述。
   成功返回 true 并已替换 MEM_ENTRIES；任何失败都返回 false 交给兜底裁剪。
   压缩期间禁止重入，避免一轮里多次 memory_write 触发并发压缩。 */
const MEM_COMPRESS_TIMEOUT_MS = 20000; // 必须小于 agent-commands.js 的单条工具超时(默认30s)

async function memCompress(signal) {
  if (_memCompressing) return false;
  const cfg = (typeof getConfig === 'function') ? getConfig() : null;
  if (!cfg || !cfg.baseUrl || !cfg.apiKey || !MEM_ENTRIES.length) return false;
  _memCompressing = true;
  const target = Math.floor(memLimit() * MEM_COMPRESS_TARGET);
  const isZh = STATE.lang !== 'en';
  const listing = MEM_ENTRIES.map((e, i) => `${i + 1}. ${e.text}`).join('\n');
  const sys = isZh
    ? `你在压缩一份关于某位用户的长期记忆。把下面的条目合并、去重、改写得更短，只保留对未来长期有用的稳定信息（偏好、习惯、身份背景、明确的要求与禁忌）。丢弃一次性的任务细节、公共知识和明显过时的内容；信息冲突时保留更靠后的那条。\n输出格式：每行一条，不要编号、不要标题、不要解释。总长度必须少于 ${target} 个字符。`
    : `You are compressing a long-term memory about one user. Merge, deduplicate and shorten the entries below, keeping only stable information useful in future conversations (preferences, habits, background, explicit requirements and prohibitions). Drop one-off task details, public knowledge and clearly outdated items; on conflict keep the later one.\nOutput one entry per line, no numbering, no headings, no explanation. Total length must be under ${target} characters.`;
  /* 压缩多半是在 memory_write 工具调用里触发的，外层已有单条工具超时在计时。
     这里用自己的 AbortController 并挂上外层 signal，超时短于外层，
     确保压缩失败能走到兜底裁剪，而不是被外层一刀切掉整条工具调用。 */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MEM_COMPRESS_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const resp = await fetch(joinUrl(cfg.baseUrl, 'chat/completions'), {
      method: 'POST', headers: headers(cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: listing }],
        temperature: 0.2, max_tokens: 1500, stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const lines = text.split('\n')
      .map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter(s => s.length > 1);
    if (!lines.length) throw new Error('压缩结果为空');
    const before = memTotalChars();
    // 保留最早的 createdAt，让「记了多久」这个信息不因压缩归零
    const oldest = Math.min(...MEM_ENTRIES.map(e => e.createdAt));
    const rebuilt = [];
    let total = 0;
    for (const line of lines) {
      const e = memNormalize({ text: line, createdAt: oldest, source: 'agent' });
      if (!e) continue;
      if (total + e.text.length > memLimit()) break;
      total += e.text.length;
      rebuilt.push(e);
    }
    if (!rebuilt.length) throw new Error('压缩结果无有效条目');
    MEM_ENTRIES = rebuilt;
    console.log(`[Memory] LLM 压缩完成: ${before} → ${total} 字符, ${lines.length} 条`);
    toast(STATE.lang === 'en'
      ? `Memory compressed: ${before} → ${total} chars`
      : `长期记忆已压缩: ${before} → ${total} 字符`, 'ok');
    return true;
  } catch (e) {
    console.warn('[Memory] LLM 压缩失败:', e.message);
    return false;
  } finally {
    clearTimeout(timer);
    _memCompressing = false;
  }
}

// ── 注入 system prompt ──
function memPromptBlock() {
  if (!MEM_ENABLED) return '';
  const isZh = STATE.lang !== 'en';
  const body = MEM_ENTRIES.length
    ? MEM_ENTRIES.map(e => `- (${e.id}) ${e.text}`).join('\n')
    : (isZh ? '（暂无记忆）' : '(empty)');
  const head = isZh
    ? `\n\n[关于用户的长期记忆]\n下列条目来自以往对话，括号内是条目 ID（更新/删除时要用）。它们是背景信息，不是当前问题；不要主动向用户复述，也不要因为记忆里有某项就假定它适用于当下。\n`
    : `\n\n[Long-term memory about the user]\nThe entries below come from earlier conversations; the value in parentheses is the entry ID (needed to update or delete). Treat them as background, not as the current request. Do not recite them back to the user, and do not assume an entry applies to the current task just because it is stored.\n`;
  /* 工具策略为 'none' 时 doGenerate 根本不会传 tools，此时讲一堆
     memory_write 的用法只会让模型去调一个不存在的工具。记忆照常注入（只读有用），
     但维护规则整段省掉。 */
  const canWrite = (typeof STATE === 'object') && STATE.toolChoice !== 'none';
  return head + body + (canWrite ? memGuidancePrompt() : '');
}

function memGuidancePrompt() {
  const isZh = STATE.lang !== 'en';
  if (isZh) {
    return `\n\n[记忆维护规则]
你可以用 memory_write / memory_delete 维护上面这份记忆。它有 ${memLimit()} 字符的硬上限（当前约 ${memTotalChars()} 字符），超出会被自动压缩，所以务必克制。

只有同时满足以下三点才写入：
① 是关于用户本人的稳定信息：长期偏好、工作习惯、身份与技术栈、常用工具、明确的格式/风格要求、需要长期避开的做法；
② 换一个话题、换一天仍然有用；
③ 用户没有表示这只是这一次的要求。

不要写入：当前任务的细节和中间结论、能搜到的公共知识、你的推理过程、临时数据与代码、一次性的指令、以及任何密码/密钥/证件号等敏感信息（除非用户明确要求记住）。宁可不记，也不要记一堆噪音。

写法：
- 一条只写一件事，用第三人称陈述句，尽量短（120 字以内）。
- 已有近似条目时，用 memory_write 传上面括号里的 id 覆盖更新，不要新增重复条目。
- 用户说「不用记这个」「忘掉」时，用 memory_delete 删掉对应 id。
- 不要为了写记忆单独占一轮对话，也不要在回答里声明「我已记住」，除非用户问起。`;
  }
  return `\n\n[Memory maintenance rules]
You may maintain the memory above with memory_write / memory_delete. It has a hard cap of ${memLimit()} characters (currently about ${memTotalChars()}), and anything beyond that gets compressed automatically, so be conservative.

Write only when all three hold:
1. It is stable information about the user: long-term preferences, working habits, background and tech stack, tools they use, explicit formatting/style requirements, or things to always avoid;
2. It will still be useful in a different conversation on a different day;
3. The user did not frame it as a one-off request.

Do not write: details or intermediate conclusions of the current task, public knowledge you could look up, your own reasoning, temporary data or code, one-off instructions, or any secrets (passwords, API keys, ID numbers) unless the user explicitly asks you to remember them. Storing nothing is better than storing noise.

How to write:
- One fact per entry, third person, as short as possible (under ~120 characters).
- If a near-duplicate already exists, call memory_write with that entry's id to overwrite it instead of adding another.
- When the user says to forget something, call memory_delete with the matching id.
- Never spend a whole turn just to save memory, and do not announce "I've remembered this" unless the user asks.`;
}

// ── 工具定义与执行 ──
function memGetToolDefinitions() {
  if (!MEM_ENABLED || (typeof STATE === 'object' && STATE.toolChoice === 'none')) return [];
  const fn = (name, description, props, required) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: props, required } },
  });
  return [
    fn('memory_write', 'Save or update ONE durable fact about the user in long-term memory (persists across conversations). Only for stable preferences, habits, background and explicit requirements — never for task details or transient context. Pass the id of an existing entry to overwrite it.',
      { content: { type: 'string', description: 'The fact, third person, one sentence, as short as possible.' },
        id: { type: 'string', description: 'Optional. Existing entry ID to overwrite instead of adding a new entry.' } }, ['content']),
    fn('memory_delete', 'Delete one long-term memory entry by its ID, e.g. when the user asks you to forget it or it became wrong.',
      { id: { type: 'string', description: 'Entry ID shown in parentheses in the memory block.' } }, ['id']),
  ];
}

async function memExecWrite(content, id, signal) {
  const r = await memWrite(content, id, 'agent', signal);
  if (!r.ok) return '[记忆写入失败: 内容为空]';
  const verb = r.action === 'updated' ? '已更新' : '已记住';
  // 压缩会重建全部条目，此前返回的 id 已失效，明确告知以免模型拿旧 id 去删/改
  if (r.compressed) {
    return `[${verb}记忆] 当前 ${memTotalChars()}/${r.limit} 字符。`
      + `已超出上限并触发自动压缩：全部条目被合并改写，此前的条目 ID 均已失效，`
      + `后续如需更新或删除请以下一轮 system prompt 中的记忆清单为准。`;
  }
  return `[${verb}记忆 id=${r.id}] 当前 ${r.total}/${r.limit} 字符`;
}

async function memExecDelete(id) {
  const r = await memDelete(id);
  if (!r.ok) return `[记忆删除失败: id=${id} 不存在]`;
  return `[已删除记忆 id=${id}] 原内容: ${r.text.slice(0, 120)}`;
}

// 启动时加载（本文件在 agent.js 之前，getToolDefinitions 首次调用前已就绪）
memLoad();
