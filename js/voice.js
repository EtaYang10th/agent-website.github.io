/* ============================================================
   ETA (Edge Thin Agent) — 语音输入与朗读（Web Speech API，零依赖）
   ------------------------------------------------------------
   SpeechRecognition 只在 Chrome / Edge / Safari 上可用（Firefox 至今没实现），
   speechSynthesis 覆盖面广一些。不支持时直接隐藏入口，不弹错误 —— 用户不需要
   知道浏览器缺了什么 API，只需要看不到那个按钮。
   ============================================================ */

const SR_IMPL = (typeof window !== 'undefined')
  ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

function voiceInputSupported() { return !!SR_IMPL; }
function voiceSpeakSupported() {
  return typeof window !== 'undefined' && !!window.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined';
}

let _sr = null;
let _srActive = false;
let _srBaseText = '';   // 开始识别时输入框里已有的内容，识别结果追加在其后

function voiceToggleInput() {
  if (!voiceInputSupported()) return;
  if (_srActive) { voiceStopInput(); return; }
  const input = $('userInput');
  if (!input) return;
  try {
    _sr = new SR_IMPL();
  } catch (e) {
    console.warn('[Voice] 无法创建 SpeechRecognition:', e);
    toast(STATE.lang === 'en' ? 'Speech recognition unavailable' : '语音识别不可用', 'fail');
    return;
  }
  _sr.lang = (STATE.lang === 'en') ? 'en-US' : 'zh-CN';
  _sr.continuous = true;
  _sr.interimResults = true;
  _srBaseText = input.value;
  _srActive = true;
  voiceSyncMicBtn();

  _sr.onresult = ev => {
    let finalText = '';
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (finalText) _srBaseText = (_srBaseText ? _srBaseText.replace(/\s*$/, ' ') : '') + finalText;
    input.value = _srBaseText + (interim ? (_srBaseText ? ' ' : '') + interim : '');
    autoResize(input);
  };
  _sr.onerror = ev => {
    const err = ev && ev.error;
    // no-speech / aborted 是常态，不值得打扰用户
    if (err && err !== 'no-speech' && err !== 'aborted') {
      const isZh = STATE.lang !== 'en';
      const msg = err === 'not-allowed'
        ? (isZh ? '麦克风权限被拒绝' : 'Microphone permission denied')
        : (isZh ? '语音识别出错: ' + err : 'Speech recognition error: ' + err);
      toast(msg, 'fail');
    }
    voiceStopInput();
  };
  _sr.onend = () => { _srActive = false; voiceSyncMicBtn(); };
  try { _sr.start(); }
  catch (e) { _srActive = false; voiceSyncMicBtn(); }
}

function voiceStopInput() {
  if (_sr) { try { _sr.stop(); } catch (e) {} }
  _srActive = false;
  voiceSyncMicBtn();
}

function voiceSyncMicBtn() {
  const btn = $('micBtn');
  if (!btn) return;
  btn.classList.toggle('mic-active', _srActive);
  const isZh = STATE.lang !== 'en';
  btn.title = _srActive
    ? (isZh ? '停止语音输入' : 'Stop dictation')
    : (isZh ? '语音输入' : 'Voice input');
}

/* ── 朗读 ──
   朗读前把 markdown 噪音去掉，否则会把 ``` 和 ** 一个个念出来。 */
let _speakingMsgId = null;

function voiceStripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块整体跳过
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function voiceSpeakMsg(msgId) {
  if (!voiceSpeakSupported()) return;
  if (_speakingMsgId === msgId) { voiceStopSpeak(); return; }
  voiceStopSpeak();
  const conv = getActiveConv();
  const node = conv && conv.tree[msgId];
  if (!node) return;
  const text = voiceStripMarkdown(node.content);
  if (!text) { toast(STATE.lang === 'en' ? 'Nothing to read' : '没有可朗读的内容', 'info'); return; }
  // 部分实现对超长 utterance 会静默失败，切成句子块排队更稳
  const chunks = text.match(/[^。！？.!?\n]{1,180}[。！？.!?]?/g) || [text.slice(0, 180)];
  _speakingMsgId = msgId;
  voiceSyncSpeakBtns();
  chunks.forEach((chunk, i) => {
    const u = new SpeechSynthesisUtterance(chunk);
    u.lang = (STATE.lang === 'en') ? 'en-US' : 'zh-CN';
    u.rate = 1;
    if (i === chunks.length - 1) {
      u.onend = () => { _speakingMsgId = null; voiceSyncSpeakBtns(); };
      u.onerror = () => { _speakingMsgId = null; voiceSyncSpeakBtns(); };
    }
    window.speechSynthesis.speak(u);
  });
}

function voiceStopSpeak() {
  if (voiceSpeakSupported()) { try { window.speechSynthesis.cancel(); } catch (e) {} }
  _speakingMsgId = null;
  voiceSyncSpeakBtns();
}

function voiceSyncSpeakBtns() {
  for (const btn of document.querySelectorAll('[data-speak-msg]')) {
    const id = btn.getAttribute('data-speak-msg');
    const on = id === _speakingMsgId;
    btn.textContent = on ? '⏹ ' + (STATE.lang === 'en' ? 'Stop' : '停止') : '🔊 ' + (STATE.lang === 'en' ? 'Read' : '朗读');
  }
}

/* ── 给 assistant 消息补挂朗读按钮 ──
   render.js 的 renderMessageNode 不可修改（属于避让范围之外但改动会与
   其它模块冲突），所以走 etaAfterRender 钩子把按钮插进 .msg-actions。 */
function voiceMountSpeakButtons() {
  if (!voiceSpeakSupported()) return;
  const isZh = STATE.lang !== 'en';
  for (const msg of document.querySelectorAll('.msg.msg-ai')) {
    const id = msg.getAttribute('data-msg-id');
    const actions = msg.querySelector('.msg-actions');
    if (!id || !actions || actions.querySelector('[data-speak-msg]')) continue;
    const btn = document.createElement('button');
    btn.className = 'msg-action-btn';
    btn.setAttribute('data-speak-msg', id);
    btn.textContent = '🔊 ' + (isZh ? '朗读' : 'Read');
    btn.addEventListener('click', () => voiceSpeakMsg(id));
    actions.appendChild(btn);
  }
  voiceSyncSpeakBtns();
}

// 入口按钮：不支持的浏览器直接移除，不留一个按了没反应的图标
function voiceInitButtons() {
  const mic = $('micBtn');
  if (mic && !voiceInputSupported()) mic.remove();
  else voiceSyncMicBtn();
}

if (typeof etaAfterRender === 'function') etaAfterRender(voiceMountSpeakButtons);
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', voiceInitButtons);
  else voiceInitButtons();
  // 离开页面时停掉朗读，否则 speechSynthesis 会在后台继续念
  window.addEventListener('beforeunload', () => { try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {} });
}
