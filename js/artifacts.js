/* ============================================================
   ETA (Edge Thin Agent) — Artifacts 产物预览
   ------------------------------------------------------------
   挂载方案：renderMd() 返回的是 HTML 字符串，且 renderChat 整体 innerHTML 赋值，
   所以分两步：
     1) markArtifactBlocks(html) 在 renderMd 内给可预览代码块的 <pre> 打 class 标记
        （用 class 而非 data-*，因为 DOMPurify 配置了 ALLOW_DATA_ATTR:false）
     2) mountArtifacts(root) 在 renderChat 赋值完 innerHTML 后扫描 DOM 挂工具条，
        以 pre.dataset.artifactMounted 做幂等；STATE.generating 期间直接跳过，
        避免流式重绘反复初始化 iframe（流式路径只改 contentEl.innerHTML，不走 renderChat）
   安全：所有预览一律 <iframe sandbox="allow-scripts">，不带 allow-same-origin
   ============================================================ */

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';
const REACT_CDN = 'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js';
const REACT_DOM_CDN = 'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js';
const BABEL_CDN = 'https://cdn.jsdelivr.net/npm/@babel/standalone@7.24.7/babel.min.js';

/* 代码块语言 → 产物类型 */
const ARTIFACT_LANG_MAP = {
  html: 'html', htm: 'html',
  svg: 'svg',
  mermaid: 'mermaid', mmd: 'mermaid',
  jsx: 'react', tsx: 'react', react: 'react',
};

/* ── 语言识别（纯逻辑，可在 node 中单测） ── */
function artifactKind(lang) {
  if (!lang) return null;
  return ARTIFACT_LANG_MAP[String(lang).trim().toLowerCase()] || null;
}

/* ── 给可预览代码块的 <pre> 打标记（在 renderMd 内调用，输入输出均为字符串） ── */
function markArtifactBlocks(html) {
  if (!html || html.indexOf('<pre') === -1) return html;
  // between 只允许「空」或「一个 button 标签」（render.js 的复制按钮），避免跨块误匹配
  return html.replace(/<pre(?![^>]*artifact-pre)([^>]*)>((?:<button[^>]*>[^<]*<\/button>)?)<code([^>]*)class="([^"]*)language-([\w-]+)([^"]*)"/g,
    (full, preAttrs, between, codePre, clsPre, lang, clsPost) => {
      const kind = artifactKind(lang);
      if (!kind) return full;
      const merged = /class="/.test(preAttrs)
        ? preAttrs.replace(/class="([^"]*)"/, `class="$1 artifact-pre artifact-${kind}"`)
        : `${preAttrs} class="artifact-pre artifact-${kind}"`;
      return `<pre${merged}>${between}<code${codePre}class="${clsPre}language-${lang}${clsPost}"`;
    });
}

/* ── 从 <pre> 里的 <code class="language-xxx"> 反推产物类型 ──
   不依赖 markArtifactBlocks 的结果（那只是 CSS 钩子），保证标记失配时仍能挂载 */
function artifactKindOfPre(pre) {
  const code = pre.querySelector('code');
  if (!code) return null;
  const m = /(?:^|\s)language-([\w-]+)/.exec(code.className || '');
  return m ? artifactKind(m[1]) : null;
}

const _artifactStore = {};

/* ── 扫描并挂载工具条（幂等；流式生成期间跳过，避免反复初始化 iframe） ── */
function mountArtifacts(root) {
  if (typeof document === 'undefined') return;
  if (typeof STATE !== 'undefined' && STATE.generating) return;
  const scope = root || document.getElementById('chatMessages');
  if (!scope || !scope.querySelectorAll) return;
  for (const pre of scope.querySelectorAll('pre')) {
    if (pre.dataset.artifactMounted === '1') continue;
    const kind = artifactKindOfPre(pre);
    if (!kind) continue;
    pre.dataset.artifactMounted = '1';
    attachArtifactBar(pre, kind);
  }
}

/* ── 在代码块外包一层容器，加「预览 / 代码 / 下载 / 存缓存」工具条 ── */
function attachArtifactBar(pre, kind) {
  const code = pre.querySelector('code');
  const source = code ? code.textContent : '';
  const id = (typeof uid === 'function' ? uid() : 'a' + Math.random().toString(36).slice(2));
  _artifactStore[id] = { kind, source };

  const wrap = document.createElement('div');
  wrap.className = 'artifact-wrap';
  wrap.dataset.artifactId = id;
  pre.parentNode.insertBefore(wrap, pre);

  const bar = document.createElement('div');
  bar.className = 'artifact-bar';
  const LABEL = { html: 'HTML', svg: 'SVG', mermaid: 'Mermaid', react: 'React/JSX' };
  bar.innerHTML = `<span class="artifact-kind">🧩 ${LABEL[kind] || kind}</span>
    <button type="button" class="artifact-btn" data-act="preview">▶ 预览</button>
    <button type="button" class="artifact-btn active" data-act="code">&lt;/&gt; 代码</button>
    <button type="button" class="artifact-btn" data-act="download">⬇ 下载</button>
    <button type="button" class="artifact-btn" data-act="save">📚 存缓存</button>`;
  wrap.appendChild(bar);
  wrap.appendChild(pre);

  const host = document.createElement('div');
  host.className = 'artifact-preview';
  host.style.display = 'none';
  wrap.appendChild(host);

  bar.addEventListener('click', e => {
    const btn = e.target.closest('button.artifact-btn');
    if (!btn) return;
    e.preventDefault();
    onArtifactAction(btn.dataset.act, id, wrap, bar, pre, host);
  });
}

const ARTIFACT_EXT = { html: 'html', svg: 'svg', mermaid: 'mmd', react: 'jsx' };

function onArtifactAction(act, id, wrap, bar, pre, host) {
  const entry = _artifactStore[id];
  if (!entry) return;
  const setActive = which => {
    for (const b of bar.querySelectorAll('.artifact-btn')) {
      if (b.dataset.act === 'preview' || b.dataset.act === 'code') b.classList.toggle('active', b.dataset.act === which);
    }
  };
  if (act === 'code') {
    host.style.display = 'none'; pre.style.display = '';
    setActive('code');
    return;
  }
  if (act === 'preview') {
    pre.style.display = 'none'; host.style.display = '';
    setActive('preview');
    if (host.dataset.rendered !== '1') renderArtifactPreview(entry, host);
    return;
  }
  if (act === 'download') {
    const ext = ARTIFACT_EXT[entry.kind] || 'txt';
    downloadArtifact(entry.source, `artifact-${id}.${ext}`, entry.kind === 'svg' ? 'image/svg+xml' : 'text/plain');
    return;
  }
  if (act === 'save') {
    if (typeof ctxAddItem !== 'function') { if (typeof toast === 'function') toast('缓存区不可用', 'fail'); return; }
    ctxAddItem({ type: 'text', name: `产物: ${entry.kind} (${id.slice(0, 6)})`, source: 'artifact', content: entry.source });
  }
}

function downloadArtifact(text, filename, mime) {
  downloadBlob(text, filename, (mime || 'text/plain') + ';charset=utf-8');
}

/* ── 源码 → 可安全嵌入 <script> 的 JS 字面量 ── */
function artifactJsLiteral(src) {
  // 除 </script> 外还要拆掉 <script 与 <!--，否则会把解析器带进 script-data-escaped 状态
  return JSON.stringify(String(src == null ? '' : src))
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/<script/gi, m => '<\\' + m.slice(1))
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/* ── 创建沙箱 iframe。刻意不给 allow-same-origin：
   与 allow-scripts 同时出现会让 iframe 能自行移除 sandbox 属性，沙箱形同虚设 ── */
function artifactIframe(srcdoc) {
  const f = document.createElement('iframe');
  f.className = 'artifact-iframe';
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('loading', 'lazy');
  f.srcdoc = srcdoc;
  return f;
}

const ARTIFACT_BASE_CSS = 'html,body{margin:0;padding:10px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;'
  + 'background:#fff;color:#111}*{box-sizing:border-box}svg{max-width:100%;height:auto}';

function renderArtifactPreview(entry, host) {
  host.dataset.rendered = '1';
  host.innerHTML = '<div class="artifact-loading">正在渲染预览...</div>';
  let doc;
  if (entry.kind === 'html') doc = artifactHtmlDoc(entry.source);
  else if (entry.kind === 'svg') doc = artifactSvgDoc(entry.source);
  else if (entry.kind === 'mermaid') doc = artifactMermaidDoc(entry.source);
  else if (entry.kind === 'react') doc = artifactReactDoc(entry.source);
  else { host.innerHTML = '<div class="artifact-loading">不支持的产物类型</div>'; return; }
  host.innerHTML = '';
  host.appendChild(artifactIframe(doc));
}

/* HTML：整段直接注入 iframe。已是完整文档则原样，否则补壳 */
function artifactHtmlDoc(src) {
  const s = String(src || '');
  if (/<html[\s>]/i.test(s)) return s;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${ARTIFACT_BASE_CSS}</style></head><body>${s}</body></html>`;
}

/* SVG：不执行脚本也能显示，仍走 iframe 隔离 */
function artifactSvgDoc(src) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${ARTIFACT_BASE_CSS}</style></head><body>${String(src || '')}</body></html>`;
}

/* Mermaid：在 iframe 内按需拉 CDN（仅当用户点开 mermaid 预览时才产生下载） */
function artifactMermaidDoc(src) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${ARTIFACT_BASE_CSS}
.err{color:#b91c1c;font-family:monospace;font-size:12px;white-space:pre-wrap}</style></head><body>
<div id="out">加载 Mermaid...</div>
<script src="${MERMAID_CDN}"></script>
<script>
var SRC = ${artifactJsLiteral(src)};
(function(){
  var out = document.getElementById('out');
  if (typeof mermaid === 'undefined') { out.innerHTML = '<div class="err">Mermaid CDN 加载失败</div>'; return; }
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
  mermaid.render('eta-mmd', SRC).then(function(r){ out.innerHTML = r.svg; })
    .catch(function(e){ out.innerHTML = '<div class="err">Mermaid 渲染失败: ' + (e && e.message ? e.message : e) + '</div>'; });
})();
<\/script></body></html>`;
}

/* React/JSX：React + ReactDOM + Babel standalone 全部在 iframe 内懒加载，
   转译后挂载。约定优先渲染 default 导出 / App / 首个大写开头的组件 */
function artifactReactDoc(src) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${ARTIFACT_BASE_CSS}
.err{color:#b91c1c;font-family:monospace;font-size:12px;white-space:pre-wrap}</style></head><body>
<div id="root">加载 React...</div>
<script src="${REACT_CDN}"></script>
<script src="${REACT_DOM_CDN}"></script>
<script src="${BABEL_CDN}"></script>
<script>
var SRC = ${artifactJsLiteral(src)};
(function(){
  var root = document.getElementById('root');
  var fail = function(m){ root.innerHTML = '<div class="err">' + m + '</div>'; };
  if (typeof React === 'undefined' || typeof ReactDOM === 'undefined') return fail('React CDN 加载失败');
  if (typeof Babel === 'undefined') return fail('Babel CDN 加载失败');
  try {
    var clean = SRC.replace(/^\\s*import[^\\n]*$/gm, '')
      .replace(/^\\s*export\\s+default\\s+/gm, 'var __ETA_DEFAULT = ')
      .replace(/^\\s*export\\s+/gm, '');
    var js = Babel.transform(clean, { presets: [['react', {}]] }).code;
    var pick = new Function('React', 'ReactDOM', js + '\\n;return (typeof __ETA_DEFAULT !== "undefined" && __ETA_DEFAULT)'
      + ' || (typeof App !== "undefined" && App) || null;');
    var Comp = pick(React, ReactDOM);
    if (!Comp) return fail('未找到可渲染组件：请导出 default 或定义名为 App 的组件');
    root.innerHTML = '';
    ReactDOM.createRoot(root).render(React.createElement(Comp));
  } catch (e) { fail('JSX 转译/渲染失败: ' + (e && e.message ? e.message : e)); }
})();
<\/script></body></html>`;
}

/* 供 index.html 自检使用 */
const ARTIFACTS_READY = true;
