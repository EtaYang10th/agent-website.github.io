/* ============================================================
   ETA (Edge Thin Agent) — 用户档案 (User Profile)
   ------------------------------------------------------------
   与 memory.js 刻意分开：这里的内容完全由用户手填，模型只读不写，
   不参与自动压缩，也不会被记忆的预算裁剪波及。

   字段是固定的几项 + 一个自由文本，避免变成第二个 System Prompt：
   称呼 / 身份角色 / 技术栈 / 语言与风格偏好 / 回答格式偏好 / 其他补充。

   存储：storage.js 的 main store，键 'profile:v1'。
   ============================================================ */

const PROF_STORE_KEY = 'profile:v1';
const PROF_FIELD_MAX = 600;    // 单字段字符上限
const PROF_TOTAL_MAX = 2500;   // 注入 prompt 的总量上限（超出按字段顺序截断）

const PROF_FIELDS = [
  { key: 'name',    zh: '希望被怎么称呼', en: 'Preferred name',
    zhPh: '例如：小李 / Dr. Wang',  enPh: 'e.g. Alex' },
  { key: 'role',    zh: '身份 / 职业角色', en: 'Role / occupation',
    zhPh: '例如：CS 博士生，方向是多模态大模型', enPh: 'e.g. PhD student in multimodal ML' },
  { key: 'stack',   zh: '常用技术栈与工具', en: 'Tech stack & tools',
    zhPh: '例如：Python / PyTorch / Slurm 集群，编辑器用 Vim', enPh: 'e.g. Python, PyTorch, Slurm; Vim' },
  { key: 'style',   zh: '语言与语气偏好', en: 'Language & tone',
    zhPh: '例如：中文回答，专业术语保留英文，别用客套话', enPh: 'e.g. concise, no filler, keep jargon in English' },
  { key: 'format',  zh: '回答格式偏好', en: 'Answer format',
    zhPh: '例如：先给结论再给理由；代码要完整可运行，附注释', enPh: 'e.g. conclusion first; complete runnable code' },
  { key: 'notes',   zh: '其他想让模型知道的事', en: 'Anything else',
    zhPh: '例如：所在时区 UTC+8；不要推荐付费服务', enPh: 'e.g. timezone UTC+8; avoid paid services' },
];

let PROFILE = {};
let PROF_ENABLED = true;

function profNormalize(p) {
  const out = {};
  for (const f of PROF_FIELDS) {
    const v = p && p[f.key];
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s) out[f.key] = s.slice(0, PROF_FIELD_MAX);
  }
  return out;
}

// ── 持久化 ──
async function profLoad() {
  try {
    const rec = await idbGet(PROF_STORE_KEY, STORE_MAIN);
    if (rec && typeof rec === 'object') {
      PROFILE = profNormalize(rec.fields || rec);
      PROF_ENABLED = rec.enabled !== false;
    }
  } catch (e) { console.warn('[Profile] 读取失败:', e); }
  return PROFILE;
}

async function profSave() {
  try { await idbSet(PROF_STORE_KEY, { enabled: PROF_ENABLED, fields: PROFILE }, STORE_MAIN); }
  catch (e) {
    console.warn('[Profile] 保存失败:', e);
    toast(STATE.lang === 'en' ? 'Failed to save profile' : '个人信息保存失败', 'fail');
  }
}

// ── 查询 / 写入 ──
function profFields() { return PROF_FIELDS; }
function profGet() { return PROFILE; }
function profEnabled() { return !!PROF_ENABLED; }
function profIsEmpty() { return !Object.keys(PROFILE).length; }
function profTotalChars() { return Object.values(PROFILE).reduce((s, v) => s + v.length, 0); }
function profFilledCount() { return Object.keys(PROFILE).length; }

async function profSetAll(fields) {
  PROFILE = profNormalize(fields);
  await profSave();
  return PROFILE;
}

async function profSetEnabled(on) { PROF_ENABLED = !!on; await profSave(); }

async function profClear() {
  PROFILE = {};
  await profSave();
}

// ── 注入 system prompt ──
function profPromptBlock() {
  if (!PROF_ENABLED || profIsEmpty()) return '';
  const isZh = STATE.lang !== 'en';
  const lines = [];
  let total = 0;
  for (const f of PROF_FIELDS) {
    const v = PROFILE[f.key];
    if (!v) continue;
    const line = `- ${isZh ? f.zh : f.en}: ${v}`;
    if (total + line.length > PROF_TOTAL_MAX) break;
    total += line.length;
    lines.push(line);
  }
  if (!lines.length) return '';
  const head = isZh
    ? '\n\n[用户档案（用户本人填写）]\n以下内容由用户手填，视为其明确表达的偏好，在不与本轮具体要求冲突的前提下遵守；本轮指令与档案冲突时以本轮为准。不要主动复述这些内容。\n'
    : '\n\n[User profile (written by the user)]\nThe following was filled in by the user; treat it as their explicitly stated preferences and follow it unless the current request says otherwise. Do not recite it back to the user.\n';
  return head + lines.join('\n');
}

// ── 导入 / 导出 ──
function profExport() {
  downloadJson({
    kind: 'eta-profile', version: 1, exportedAt: new Date().toISOString(),
    fields: PROFILE,
  }, 'eta-profile.json');
  toast(STATE.lang === 'en' ? 'Profile exported' : '个人信息已导出', 'ok');
}

profLoad();
