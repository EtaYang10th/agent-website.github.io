/* ============================================================
   ETA (Edge Thin Agent) — Storage Layer (IndexedDB, zero deps)
   ------------------------------------------------------------
   为什么需要它：localStorage 只有 ~5MB，图片 base64 + 抓取全文很容易撑爆，
   而旧代码把 quota 错误吞掉了，导致此后所有对话静默不落盘。

   分层设计：
     - main  store：对话主体（去掉大字段后的 JSON），体积小、读写频繁
     - blobs store：大体积字段（图片 dataUrl、缓存区全文），按确定性键存放
   主表只保留引用键，加载时 rehydrate 还原。
   IndexedDB 不可用（隐私模式等）时整体回退 localStorage。
   ============================================================ */

// ── 常量 ──
const IDB_NAME = 'eta-store';
const IDB_VERSION = 1;
const STORE_MAIN = 'main';
const STORE_BLOBS = 'blobs';
const STATE_KEY = 'chat-state';            // main store 内的主记录键
const LEGACY_STATE_KEY = 'ai-chat-studio'; // 旧 localStorage 键（迁移后清理）
const LS_FALLBACK_KEY = 'eta-state-fallback';
const BLOB_REF_PREFIX = 'idb-blob:';       // 主表内引用标记

// IndexedDB 可用性：null=未探测，true/false=已探测结果
let _idbAvailable = null;
let _idbPromise = null;
let _fallbackNotified = false;
// 已落盘的 blob 指纹（key -> 长度）。大字段写入后不再变化，
// 流式生成时 saveState 高频触发，靠它跳过重复写入几 MB 的图片。
const _blobWritten = new Map();

// ── 打开数据库（惰性单例） ──
function idbOpen() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      _idbAvailable = false;
      return reject(new Error('IndexedDB 不可用'));
    }
    let req;
    try { req = indexedDB.open(IDB_NAME, IDB_VERSION); }
    catch (e) { _idbAvailable = false; return reject(e); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MAIN)) db.createObjectStore(STORE_MAIN);
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
    };
    req.onsuccess = () => { _idbAvailable = true; resolve(req.result); };
    req.onerror = () => { _idbAvailable = false; reject(req.error || new Error('open failed')); };
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞'));
  });
  // 失败后允许下次重试（例如用户退出隐私模式）
  _idbPromise.catch(() => { _idbPromise = null; });
  return _idbPromise;
}

// ── 基础 KV 操作 ──
function _idbTx(store, mode, fn) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.onabort = () => reject(tx.error || new Error('tx aborted'));
    tx.onerror = () => reject(tx.error || new Error('tx error'));
    if (req) {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } else {
      tx.oncomplete = () => resolve();
    }
  }));
}

function idbGet(key, store = STORE_MAIN) {
  return _idbTx(store, 'readonly', s => s.get(key));
}
function idbSet(key, value, store = STORE_MAIN) {
  return _idbTx(store, 'readwrite', s => s.put(value, key));
}
function idbDel(key, store = STORE_MAIN) {
  return _idbTx(store, 'readwrite', s => s.delete(key));
}
function idbKeys(store = STORE_BLOBS) {
  return _idbTx(store, 'readonly', s => s.getAllKeys());
}

function idbGetBlob(key) { return idbGet(key, STORE_BLOBS); }
function idbSetBlob(key, value) { return idbSet(key, value, STORE_BLOBS); }
function idbDelBlob(key) { return idbDel(key, STORE_BLOBS); }

/* ── 大字段拆分 / 合并（纯函数，依赖注入 put/get 回调） ──
   put(key, value) / get(key) 可返回 Promise，也可以是同步的（便于用 Map 测试）。
   键名是确定性的（convId:nodeId:att<i> / convId:ctx:<itemId>），
   同一字段重复写入会覆盖同一条记录，保证幂等、不产生垃圾。 */
const BLOB_MIN_SIZE = 2048; // 小于此长度的字段不值得分表，直接留在主表

function blobKeyForAttachment(convId, nodeId, index) {
  return `${convId}:${nodeId}:att${index}`;
}
function blobKeyForCtxItem(convId, itemId) {
  return `${convId}:ctx:${itemId}`;
}
function isBlobRef(v) {
  return typeof v === 'string' && v.startsWith(BLOB_REF_PREFIX);
}
function blobRefToKey(v) {
  return v.slice(BLOB_REF_PREFIX.length);
}

// 深拷贝主体并把大字段替换为引用，返回 { data, writes: [[key, value]...] }
function splitBlobs(conversations) {
  const writes = [];
  const out = {};
  for (const [convId, conv] of Object.entries(conversations || {})) {
    const c = Object.assign({}, conv);
    c.tree = {};
    for (const [nodeId, node] of Object.entries(conv.tree || {})) {
      const n = Object.assign({}, node);
      if (Array.isArray(node.attachments) && node.attachments.length) {
        n.attachments = node.attachments.map((att, i) => {
          const a = Object.assign({}, att);
          if (typeof a.dataUrl === 'string' && !isBlobRef(a.dataUrl) && a.dataUrl.length >= BLOB_MIN_SIZE) {
            const key = blobKeyForAttachment(convId, nodeId, i);
            writes.push([key, a.dataUrl]);
            a.dataUrl = BLOB_REF_PREFIX + key;
          }
          return a;
        });
      }
      c.tree[nodeId] = n;
    }
    if (Array.isArray(conv.contextBuffer) && conv.contextBuffer.length) {
      c.contextBuffer = conv.contextBuffer.map(item => {
        const it = Object.assign({}, item);
        if (typeof it.content === 'string' && !isBlobRef(it.content) && it.content.length >= BLOB_MIN_SIZE) {
          const key = blobKeyForCtxItem(convId, it.id);
          writes.push([key, it.content]);
          it.content = BLOB_REF_PREFIX + key;
        }
        return it;
      });
    }
    out[convId] = c;
  }
  return { data: out, writes };
}

// 收集一批对话涉及的全部 blob 键（删除对话时用来清理）
function collectBlobKeys(conversations) {
  const keys = [];
  for (const [convId, conv] of Object.entries(conversations || {})) {
    for (const [nodeId, node] of Object.entries(conv.tree || {})) {
      (node.attachments || []).forEach((att, i) => {
        if (isBlobRef(att && att.dataUrl)) keys.push(blobRefToKey(att.dataUrl));
        else if (att && typeof att.dataUrl === 'string') keys.push(blobKeyForAttachment(convId, nodeId, i));
      });
    }
    for (const item of conv.contextBuffer || []) {
      if (isBlobRef(item && item.content)) keys.push(blobRefToKey(item.content));
      else if (item && item.id) keys.push(blobKeyForCtxItem(convId, item.id));
    }
  }
  return keys;
}

/* 把引用还原成实际内容。get 可同步或返回 Promise。
   缺失的 blob 不抛错，退化为空串并计入 missing，避免整库加载失败。 */
async function mergeBlobs(conversations, get) {
  const missing = [];
  const resolve = async ref => {
    const key = blobRefToKey(ref);
    const v = await get(key);
    if (v === undefined || v === null) { missing.push(key); return ''; }
    return v;
  };
  for (const conv of Object.values(conversations || {})) {
    for (const node of Object.values(conv.tree || {})) {
      for (const att of node.attachments || []) {
        if (isBlobRef(att && att.dataUrl)) att.dataUrl = await resolve(att.dataUrl);
      }
    }
    for (const item of conv.contextBuffer || []) {
      if (isBlobRef(item && item.content)) item.content = await resolve(item.content);
    }
  }
  return { data: conversations, missing };
}

// ── localStorage 回退（IndexedDB 不可用时） ──
function _notifyFallback() {
  if (_fallbackNotified) return;
  _fallbackNotified = true;
  const msg = (typeof STATE !== 'undefined' && STATE.lang === 'en')
    ? 'IndexedDB unavailable, falling back to localStorage (~5MB limit)'
    : 'IndexedDB 不可用，已回退 localStorage（约 5MB 上限，大图片可能存不下）';
  if (typeof toast === 'function') toast(msg, 'fail');
  else console.warn('[Storage] ' + msg);
}

function _lsSave(payload) {
  localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(payload));
}
function _lsLoad() {
  const raw = localStorage.getItem(LS_FALLBACK_KEY) || localStorage.getItem(LEGACY_STATE_KEY);
  return raw ? JSON.parse(raw) : null;
}

/* ── 高层 API：整份状态落盘 ──
   写入前拆分大字段，主表只存引用；失败时回退 localStorage 并明确告警。 */
async function storageSaveChatState(conversations, activeConvId) {
  const { data, writes } = splitBlobs(conversations);
  const payload = { conversations: data, activeConvId, savedAt: Date.now() };
  try {
    await idbOpen();
    let wrote = 0;
    for (const [key, value] of writes) {
      if (_blobWritten.get(key) === value.length) continue;
      await idbSetBlob(key, value);
      _blobWritten.set(key, value.length);
      wrote++;
    }
    await idbSet(STATE_KEY, payload);
    return { ok: true, backend: 'idb', blobs: writes.length, wrote };
  } catch (e) {
    _notifyFallback();
    try {
      // 回退路径存完整数据（无引用），保证单独可读
      _lsSave({ conversations, activeConvId, savedAt: Date.now() });
      return { ok: true, backend: 'localStorage', error: e };
    } catch (e2) {
      throw e2;
    }
  }
}

/* ── 高层 API：读取状态（含首次自动迁移） ──
   返回 { conversations, activeConvId, backend, migrated }。 */
async function storageLoadChatState() {
  try {
    await idbOpen();
    let payload = await idbGet(STATE_KEY);
    let migrated = false;
    if (!payload) {
      const legacy = _readLegacyLocalStorage();
      if (legacy) {
        await storageSaveChatState(legacy.conversations, legacy.activeConvId);
        try { localStorage.removeItem(LEGACY_STATE_KEY); } catch (e) {}
        migrated = true;
        payload = await idbGet(STATE_KEY);
      }
    }
    if (!payload) return { conversations: {}, activeConvId: null, backend: 'idb', migrated };
    // 加载时登记指纹，避免首次 saveState 把所有已存在的 blob 重写一遍
    const trackingGet = async key => {
      const v = await idbGetBlob(key);
      if (typeof v === 'string') _blobWritten.set(key, v.length);
      return v;
    };
    const { data, missing } = await mergeBlobs(payload.conversations || {}, trackingGet);
    if (missing.length) console.warn('[Storage] 缺失 blob 记录 ' + missing.length + ' 条:', missing.slice(0, 5));
    return { conversations: data, activeConvId: payload.activeConvId || null, backend: 'idb', migrated, missing };
  } catch (e) {
    _notifyFallback();
    try {
      const p = _lsLoad();
      if (!p) return { conversations: {}, activeConvId: null, backend: 'localStorage' };
      return { conversations: p.conversations || {}, activeConvId: p.activeConvId || null, backend: 'localStorage' };
    } catch (e2) {
      console.warn('[Storage] 回退读取也失败:', e2);
      return { conversations: {}, activeConvId: null, backend: 'none' };
    }
  }
}

// 读取旧版 localStorage 对话数据（迁移用）
function _readLegacyLocalStorage() {
  try {
    const raw = localStorage.getItem(LEGACY_STATE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return null;
    return { conversations: d.conversations || {}, activeConvId: d.activeConvId || null };
  } catch (e) { return null; }
}

// 删除对话时清理其 blob，避免 IndexedDB 里留下孤儿大对象
async function storageDeleteConvBlobs(convId, conv) {
  if (!conv) return 0;
  const keys = collectBlobKeys({ [convId]: conv });
  let n = 0;
  for (const k of keys) { try { await idbDelBlob(k); _blobWritten.delete(k); n++; } catch (e) {} }
  return n;
}

// 清空全部数据（清空所有对话时用）
async function storageClearAll() {
  try {
    await _idbTx(STORE_BLOBS, 'readwrite', s => s.clear());
    await idbDel(STATE_KEY);
    _blobWritten.clear();
  } catch (e) { console.warn('[Storage] 清空失败:', e); }
  try { localStorage.removeItem(LS_FALLBACK_KEY); } catch (e) {}
}
