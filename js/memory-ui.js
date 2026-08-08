/* ============================================================
   ETA (Edge Thin Agent) — 记忆 / 档案 的管理界面
   ------------------------------------------------------------
   两个独立模态框：
     showMemoryModal()  —— 长期记忆：逐条编辑/删除、开关、上限、手动压缩
     showProfileModal() —— 用户档案：固定字段表单，用户自己填

   记忆条目允许用户直接改文本，所以每条都是一个 textarea + 保存按钮；
   编辑不走 memWrite 的近似去重（那是给模型用的），用户改什么就是什么。
   ============================================================ */

// 设置面板里的一行状态摘要（折叠也能看出记了多少、档案填没填）
function memSettingsSummary(isZh) {
  const parts = [];
  if (typeof profFilledCount === 'function') {
    const n = profFilledCount();
    if (!profEnabled()) parts.push(isZh ? '档案已关' : 'profile off');
    else parts.push(isZh ? `档案 ${n} 项` : `${n} profile field(s)`);
  }
  if (typeof memList === 'function') {
    if (!memEnabled()) parts.push(isZh ? '记忆已关' : 'memory off');
    else parts.push(isZh ? `记忆 ${memList().length} 条 / ${memTotalChars()} 字符` : `${memList().length} memories, ${memTotalChars()} chars`);
  }
  return escHtml(parts.join(' · '));
}

// ── 长期记忆 ──
function showMemoryModal() {
  const isZh = STATE.lang !== 'en';
  const total = memTotalChars();
  const limit = memLimit();
  const pct = Math.min(100, Math.round(total / limit * 100));
  const barColor = pct > 90 ? 'var(--fail)' : (pct > 70 ? 'var(--warn)' : 'var(--ok)');
  showModal(isZh ? '🧠 长期记忆' : '🧠 Long-term Memory',
    memHeaderHtml(isZh, total, limit, pct, barColor) + memRowsHtml(isZh) + memFooterHtml(isZh));
}

function memHeaderHtml(isZh, total, limit, pct, barColor) {
  return `<div class="mem-wrap">
    <div class="setting-row" style="margin-top:0">
      <div><div class="setting-label">${isZh ? '启用长期记忆' : 'Enable long-term memory'}</div>
        <div class="setting-hint">${isZh
          ? '关闭后记忆不再注入对话，模型也拿不到写入工具（已存条目保留）'
          : 'When off, memory is not injected and the write tools are hidden (entries are kept)'}</div></div>
      <input type="checkbox" id="memEnabled" ${memEnabled() ? 'checked' : ''} onchange="memUiToggle(this.checked)">
    </div>
    <div class="mem-meter">
      <div class="mem-meter-head">
        <span>${isZh ? '已用' : 'Used'} ${total} / ${limit} ${isZh ? '字符' : 'chars'} · ${memList().length} ${isZh ? '条' : 'entries'}</span>
        <span class="mem-limit-edit">${isZh ? '上限' : 'Limit'}
          <input type="number" id="memLimitInput" value="${limit}" min="500" max="20000" step="500"
            onchange="memUiSetLimit(this.value)"></span>
      </div>
      <div class="mem-bar"><div class="mem-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
    </div>`;
}

function memRowsHtml(isZh) {
  const list = memList();
  if (!list.length) {
    return `<div class="mem-empty">${isZh
      ? '还没有记忆。Agent 会在对话中自行判断，只把值得长期保留的信息写进来；你也可以在下面手动添加。'
      : 'No memories yet. The agent decides on its own what is worth keeping; you can also add entries manually below.'}</div>`;
  }
  const rows = list.map(e => {
    const tag = e.source === 'user'
      ? `<span class="mem-tag mem-tag-user">${isZh ? '手动' : 'manual'}</span>`
      : `<span class="mem-tag">${isZh ? 'Agent' : 'agent'}</span>`;
    const when = new Date(e.updatedAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US');
    return `<div class="mem-row">
      <div class="mem-row-head">
        <span class="mem-row-meta">${tag}<span class="mem-row-id">${escHtml(e.id)}</span>
          <span>${when}</span><span>${e.text.length} ${isZh ? '字符' : 'ch'}</span></span>
        <span class="mem-row-ops">
          <button class="btn btn-ghost btn-sm" onclick="memUiSaveRow('${escHtml(e.id)}')">${isZh ? '保存' : 'Save'}</button>
          <button class="btn btn-ghost btn-sm" onclick="memUiDelete('${escHtml(e.id)}')">🗑</button></span>
      </div>
      <textarea class="mem-row-text" id="memText_${escHtml(e.id)}" rows="2"
        maxlength="400">${escHtml(e.text)}</textarea>
    </div>`;
  }).join('');
  return `<div class="mem-list">${rows}</div>`;
}

function memFooterHtml(isZh) {
  return `<div class="mem-add">
      <textarea id="memNewText" rows="2" placeholder="${isZh
        ? '手动添加一条，例如：用户偏好先给结论再给理由'
        : 'Add one entry, e.g. prefers the conclusion before the reasoning'}" maxlength="400"></textarea>
      <button class="btn btn-primary btn-sm" onclick="memUiAdd()">＋ ${isZh ? '添加' : 'Add'}</button>
    </div>
    <div class="ct-bar" style="margin-top:10px">
      <button class="btn btn-ghost btn-sm" onclick="memUiCompress()">🗜 ${isZh ? '立即压缩' : 'Compress now'}</button>
      <button class="btn btn-ghost btn-sm" onclick="memUiExport()">📤 ${isZh ? '导出' : 'Export'}</button>
      <button class="btn btn-ghost btn-sm" onclick="memUiImport()">📥 ${isZh ? '导入' : 'Import'}</button>
      <button class="btn btn-ghost btn-sm" onclick="memUiClear()">🗑 ${isZh ? '全部清空' : 'Clear all'}</button>
    </div>
    <div class="ct-note">${isZh
      ? '记忆是全局的，所有对话共享，只存在你的浏览器里（IndexedDB），不会上传到除模型 API 之外的任何地方。超出上限时会先尝试用一次 LLM 调用合并压缩，失败则丢弃最久未更新的条目。'
      : 'Memory is global across conversations and stored only in your browser (IndexedDB). When it exceeds the cap, one LLM call merges and shortens it; if that fails, the least recently updated entries are dropped.'}</div>
  </div>`;
}

// ── 记忆操作回调 ──
async function memUiToggle(on) {
  await memSetEnabled(on);
  toast(STATE.lang === 'en' ? (on ? 'Memory enabled' : 'Memory disabled')
    : (on ? '长期记忆已启用' : '长期记忆已关闭'), 'ok');
}

async function memUiSetLimit(v) {
  await memSetLimit(v);
  showMemoryModal();
  toast(STATE.lang === 'en' ? 'Limit updated' : '上限已更新', 'ok');
}

async function memUiSaveRow(id) {
  const el = $('memText_' + id);
  if (!el) return;
  const text = el.value.trim();
  if (!text) { toast(STATE.lang === 'en' ? 'Entry is empty' : '内容为空', 'fail'); return; }
  const entry = memFind(id);
  if (!entry) return;
  // 用户直接改写：不做近似去重，也不改 source（手动新增的仍标手动）
  entry.text = text.slice(0, 400);
  entry.updatedAt = Date.now();
  await memSave();
  showMemoryModal();
  toast(STATE.lang === 'en' ? 'Saved' : '已保存', 'ok');
}

async function memUiDelete(id) {
  await memDelete(id);
  showMemoryModal();
}

async function memUiAdd() {
  const el = $('memNewText');
  if (!el) return;
  const text = el.value.trim();
  if (!text) return;
  await memWrite(text, '', 'user');
  showMemoryModal();
  toast(STATE.lang === 'en' ? 'Entry added' : '已添加', 'ok');
}

async function memUiClear() {
  const msg = STATE.lang === 'en'
    ? 'Delete ALL long-term memory? This cannot be undone.'
    : '确定清空全部长期记忆？此操作不可撤销。';
  if (!confirm(msg)) return;
  await memClear();
  showMemoryModal();
  toast(STATE.lang === 'en' ? 'Memory cleared' : '长期记忆已清空', 'ok');
}

async function memUiCompress() {
  if (!memList().length) { toast(STATE.lang === 'en' ? 'Nothing to compress' : '没有可压缩的内容', 'fail'); return; }
  toast(STATE.lang === 'en' ? 'Compressing...' : '正在压缩...', 'info');
  const ok = await memCompress();
  if (ok) await memSave();
  else toast(STATE.lang === 'en' ? 'Compression failed (check API config)' : '压缩失败（请检查 API 配置）', 'fail');
  showMemoryModal();
}

function memUiExport() {
  downloadJson({
    kind: 'eta-memory', version: 1, exportedAt: new Date().toISOString(),
    limit: memLimit(), entries: memList(),
  }, 'eta-memory.json');
  toast(STATE.lang === 'en' ? 'Memory exported' : '记忆已导出', 'ok');
}

function memUiImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const list = Array.isArray(payload) ? payload : (payload && payload.entries);
      if (!Array.isArray(list)) throw new Error(STATE.lang === 'en' ? 'Unrecognized format' : '文件格式无法识别');
      let n = 0;
      for (const raw of list) {
        const text = typeof raw === 'string' ? raw : (raw && raw.text);
        if (!text) continue;
        await memWrite(text, '', (raw && raw.source === 'user') ? 'user' : 'agent');
        n++;
      }
      showMemoryModal();
      toast((STATE.lang === 'en' ? `Imported ${n} entries` : `已导入 ${n} 条记忆`), n ? 'ok' : 'fail');
    } catch (e) {
      toast((STATE.lang === 'en' ? 'Import failed: ' : '导入失败: ') + e.message, 'fail');
    }
  };
  input.click();
}

// ── 用户档案 ──
function showProfileModal() {
  const isZh = STATE.lang !== 'en';
  const cur = profGet();
  const rows = profFields().map(f => `
    <label class="prof-label" for="prof_${f.key}">${isZh ? f.zh : f.en}</label>
    <textarea class="prof-input" id="prof_${f.key}" rows="2" maxlength="600"
      placeholder="${escHtml(isZh ? f.zhPh : f.enPh)}">${escHtml(cur[f.key] || '')}</textarea>`).join('');
  showModal(isZh ? '👤 个人信息' : '👤 Personal Info', `
    <div class="prof-wrap">
      <div class="setting-row" style="margin-top:0">
        <div><div class="setting-label">${isZh ? '在对话中使用这些信息' : 'Use this profile in conversations'}</div>
          <div class="setting-hint">${isZh
            ? '关闭后不再注入，内容保留'
            : 'When off, the profile is not injected but is kept'}</div></div>
        <input type="checkbox" id="profEnabled" ${profEnabled() ? 'checked' : ''} onchange="profUiToggle(this.checked)">
      </div>
      <div class="prof-form">${rows}</div>
      <div class="ct-bar" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="profUiSave()">${isZh ? '保存' : 'Save'}</button>
        <button class="btn btn-ghost btn-sm" onclick="profExport()">📤 ${isZh ? '导出' : 'Export'}</button>
        <button class="btn btn-ghost btn-sm" onclick="profUiImport()">📥 ${isZh ? '导入' : 'Import'}</button>
        <button class="btn btn-ghost btn-sm" onclick="profUiClear()">🗑 ${isZh ? '清空' : 'Clear'}</button>
      </div>
      <div class="ct-note">${isZh
        ? '这些内容会以「用户档案」的形式加进每次请求的 system prompt，只保存在你的浏览器里。留空的字段不会注入。与长期记忆不同，这里模型只读不写，也不会被自动压缩。'
        : 'These fields are added to the system prompt of every request and stored only in your browser. Empty fields are skipped. Unlike long-term memory, the model can only read this and it is never auto-compressed.'}</div>
    </div>`);
}

async function profUiToggle(on) {
  await profSetEnabled(on);
  toast(STATE.lang === 'en' ? (on ? 'Profile enabled' : 'Profile disabled')
    : (on ? '个人信息已启用' : '个人信息已关闭'), 'ok');
}

async function profUiSave() {
  const fields = {};
  for (const f of profFields()) {
    const el = $('prof_' + f.key);
    if (el) fields[f.key] = el.value;
  }
  await profSetAll(fields);
  closeModal();
  toast(STATE.lang === 'en'
    ? `Profile saved (${profFilledCount()} fields, ${profTotalChars()} chars)`
    : `个人信息已保存（${profFilledCount()} 项，${profTotalChars()} 字符）`, 'ok');
}

async function profUiClear() {
  const msg = STATE.lang === 'en' ? 'Clear all profile fields?' : '确定清空所有个人信息？';
  if (!confirm(msg)) return;
  await profClear();
  showProfileModal();
  toast(STATE.lang === 'en' ? 'Profile cleared' : '个人信息已清空', 'ok');
}

function profUiImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const fields = (payload && payload.fields) || payload;
      if (!fields || typeof fields !== 'object') throw new Error(STATE.lang === 'en' ? 'Unrecognized format' : '文件格式无法识别');
      await profSetAll(fields);
      showProfileModal();
      toast(STATE.lang === 'en' ? 'Profile imported' : '个人信息已导入', 'ok');
    } catch (e) {
      toast((STATE.lang === 'en' ? 'Import failed: ' : '导入失败: ') + e.message, 'fail');
    }
  };
  input.click();
}

/* ── 模型写入后刷新界面 ──
   memory.js 在 memWrite / memDelete 后调用。只在记忆模态框确实开着时重绘：
   靠 DOM 里有没有 .mem-wrap 判断，而不是靠标志位——closeModal() 不经过本模块，
   标志位会残留，而残留的标志位会让模型后台写记忆时凭空弹出一个模态框。
   同理，档案表单开着时绝不重绘，否则用户填一半的内容会被冲掉。 */
function memRefreshUi() {
  if (!document.querySelector('.modal-overlay .mem-wrap')) return;
  showMemoryModal();
}
