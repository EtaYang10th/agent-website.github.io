/* ============================================================
   ETA (Edge Thin Agent) — File Upload & Parsing (PDF, DOCX, PPTX, XLSX)
   ============================================================ */

// ── 文件/图片上传 ──
function handleFileSelect(event) {
  const files = event.target.files;
  if (!files) return;
  for (const file of files) { processFile(file); }
  event.target.value = '';
}

function processFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const type = file.type || '';

  if (type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = e => {
      STATE.attachments.push({ name: file.name, type: file.type, dataUrl: e.target.result });
      renderAttachPreview();
    };
    reader.readAsDataURL(file);
    return;
  }
  if (ext === 'pdf' || type === 'application/pdf') { extractPdfText(file); return; }
  if (ext === 'docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') { extractDocxText(file); return; }
  if (ext === 'pptx' || type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') { extractPptxText(file); return; }
  if (ext === 'xlsx' || type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') { extractXlsxText(file); return; }

  const reader = new FileReader();
  reader.onload = e => {
    STATE.attachments.push({ name: file.name, type: file.type, textContent: e.target.result });
    renderAttachPreview();
  };
  reader.readAsText(file);
}

// ── PDF 文本提取 ──
async function extractPdfText(file) {
  toast('正在解析 PDF...', 'info');
  try {
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js 库未加载');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const arrayBuf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map(item => item.str).join(' ');
      if (text.trim()) pages.push(`[第${i}页]\n${text.trim()}`);
    }
    const fullText = pages.join('\n\n');
    STATE.attachments.push({ name: file.name, type: 'application/pdf', textContent: fullText || '[PDF 无可提取文本（可能是扫描件）]' });
    renderAttachPreview();
    toast(`PDF 解析完成: ${pdf.numPages} 页`, 'ok');
  } catch(e) {
    toast('PDF 解析失败: ' + e.message, 'fail');
    STATE.attachments.push({ name: file.name, type: 'application/pdf', textContent: `[PDF 解析失败: ${e.message}]` });
    renderAttachPreview();
  }
}

// ── DOCX 文本提取 ──
async function extractDocxText(file) {
  toast('正在解析 Word 文档...', 'info');
  try {
    if (typeof mammoth === 'undefined') throw new Error('mammoth 库未加载');
    const arrayBuf = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: arrayBuf });
    const text = result.value || '';
    STATE.attachments.push({ name: file.name, type: file.type, textContent: text || '[DOCX 无文本内容]' });
    renderAttachPreview();
    toast('Word 文档解析完成', 'ok');
  } catch(e) {
    toast('DOCX 解析失败: ' + e.message, 'fail');
    STATE.attachments.push({ name: file.name, type: file.type, textContent: `[DOCX 解析失败: ${e.message}]` });
    renderAttachPreview();
  }
}

// ── PPTX 文本提取 ──
async function extractPptxText(file) {
  toast('正在解析 PPT...', 'info');
  try {
    if (typeof JSZip === 'undefined') throw new Error('JSZip 库未加载');
    const arrayBuf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuf);

    const slideFiles = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

    const slides = [];
    for (const sf of slideFiles) {
      const num = sf.match(/slide(\d+)/)[1];
      const xml = await zip.files[sf].async('text');
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const texts = [];
      const allEls = doc.getElementsByTagName('*');
      for (let i = 0; i < allEls.length; i++) {
        const el = allEls[i];
        const tag = el.tagName || '';
        const local = el.localName || '';
        const isTextNode = local === 't' && (
          tag === 'a:t' || tag === 'a16:t' ||
          (el.namespaceURI || '').includes('drawingml') ||
          (el.namespaceURI || '').includes('schemas.openxmlformats.org')
        );
        const isFallback = local === 't' && tag.includes(':t');
        if ((isTextNode || isFallback) && el.textContent.trim()) {
          texts.push(el.textContent.trim());
        }
      }
      slides.push(`[幻灯片 ${num}]\n${texts.length ? texts.join(' ') : '(此页无可提取文本，可能仅含图片/图表)'}`);
    }

    // 图表/SmartArt/diagram 文本
    const extraTexts = [];
    const extraFiles = Object.keys(zip.files).filter(f =>
      f.startsWith('ppt/diagrams/') || f.startsWith('ppt/charts/')
    ).filter(f => f.endsWith('.xml'));
    for (const ef of extraFiles) {
      try {
        const xml = await zip.files[ef].async('text');
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const allEls = doc.getElementsByTagName('*');
        for (let i = 0; i < allEls.length; i++) {
          const el = allEls[i];
          const local = el.localName || '';
          if ((local === 't' || local === 'v') && el.textContent.trim() && !el.children.length) {
            extraTexts.push(el.textContent.trim());
          }
        }
      } catch(e) {}
    }
    if (extraTexts.length) slides.push(`[图表/SmartArt 文本]\n${extraTexts.join(' ')}`);

    // 备注
    const noteFiles = Object.keys(zip.files)
      .filter(f => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    for (const nf of noteFiles) {
      try {
        const num = nf.match(/notesSlide(\d+)/)[1];
        const xml = await zip.files[nf].async('text');
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const allEls = doc.getElementsByTagName('*');
        const noteTexts = [];
        for (let i = 0; i < allEls.length; i++) {
          const el = allEls[i];
          if ((el.localName === 't') && el.textContent.trim()) {
            const t = el.textContent.trim();
            if (t !== '‹#›' && !/^\d+$/.test(t)) noteTexts.push(t);
          }
        }
        if (noteTexts.length) slides.push(`[幻灯片 ${num} 备注]\n${noteTexts.join(' ')}`);
      } catch(e) {}
    }

    const fullText = slides.join('\n\n');
    STATE.attachments.push({ name: file.name, type: file.type, textContent: fullText || '[PPTX 无可提取文本]' });
    renderAttachPreview();
    toast(`PPT 解析完成: ${slideFiles.length} 页`, 'ok');
  } catch(e) {
    toast('PPTX 解析失败: ' + e.message, 'fail');
    STATE.attachments.push({ name: file.name, type: file.type, textContent: `[PPTX 解析失败: ${e.message}]` });
    renderAttachPreview();
  }
}

// ── XLSX 文本提取 ──
async function extractXlsxText(file) {
  toast('正在解析 Excel...', 'info');
  try {
    if (typeof JSZip === 'undefined') throw new Error('JSZip 库未加载');
    const arrayBuf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuf);
    const sharedStrings = [];
    if (zip.files['xl/sharedStrings.xml']) {
      const ssXml = await zip.files['xl/sharedStrings.xml'].async('text');
      const ssDoc = new DOMParser().parseFromString(ssXml, 'text/xml');
      ssDoc.querySelectorAll('*').forEach(el => {
        if (el.localName === 'si') sharedStrings.push(el.textContent.trim());
      });
    }
    const sheets = [];
    const sheetFiles = Object.keys(zip.files)
      .filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/sheet(\d+)/)[1]);
        const nb = parseInt(b.match(/sheet(\d+)/)[1]);
        return na - nb;
      });
    for (const sf of sheetFiles) {
      const xml = await zip.files[sf].async('text');
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const rows = [];
      doc.querySelectorAll('*').forEach(el => {
        if (el.localName === 'row') {
          const cells = [];
          el.querySelectorAll('*').forEach(c => {
            if (c.localName === 'c') {
              const t = c.getAttribute('t');
              const vEl = [...c.children].find(ch => ch.localName === 'v');
              let val = vEl?.textContent || '';
              if (t === 's' && sharedStrings[parseInt(val)]) val = sharedStrings[parseInt(val)];
              cells.push(val);
            }
          });
          if (cells.some(c => c)) rows.push(cells.join('\t'));
        }
      });
      const num = sf.match(/sheet(\d+)/)[1];
      if (rows.length) sheets.push(`[Sheet ${num}]\n${rows.join('\n')}`);
    }
    const fullText = sheets.join('\n\n');
    STATE.attachments.push({ name: file.name, type: file.type, textContent: fullText || '[XLSX 无数据]' });
    renderAttachPreview();
    toast(`Excel 解析完成: ${sheetFiles.length} 个工作表`, 'ok');
  } catch(e) {
    toast('XLSX 解析失败: ' + e.message, 'fail');
    STATE.attachments.push({ name: file.name, type: file.type, textContent: `[XLSX 解析失败: ${e.message}]` });
    renderAttachPreview();
  }
}

function renderAttachPreview() {
  const container = $('attachPreview');
  container.innerHTML = STATE.attachments.map((att, i) => {
    const preview = att.dataUrl && att.type.startsWith('image/')
      ? `<img src="${att.dataUrl}" alt="${escHtml(att.name)}">`
      : '📄';
    return `<div class="attachment-chip">${preview} ${escHtml(att.name)}
      <span class="remove-attach" onclick="removeAttachment(${i})">✕</span></div>`;
  }).join('');
}

function removeAttachment(idx) {
  STATE.attachments.splice(idx, 1);
  renderAttachPreview();
}

// ── 拖拽上传 ──
document.addEventListener('DOMContentLoaded', () => {
  const inputBox = $('inputBox');
  ['dragenter', 'dragover'].forEach(e => {
    inputBox.addEventListener(e, ev => { ev.preventDefault(); inputBox.style.borderColor = 'var(--accent)'; });
  });
  ['dragleave', 'drop'].forEach(e => {
    inputBox.addEventListener(e, ev => { ev.preventDefault(); inputBox.style.borderColor = ''; });
  });
  inputBox.addEventListener('drop', ev => {
    const files = ev.dataTransfer.files;
    for (const f of files) processFile(f);
  });
});

// ── 粘贴上传 ──
document.addEventListener('paste', ev => {
  if (document.activeElement !== $('userInput')) return;
  const items = ev.clipboardData.items;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      ev.preventDefault();
      const file = item.getAsFile();
      if (file) processFile(file);
    }
  }
});
