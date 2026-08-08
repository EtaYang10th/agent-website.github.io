/* ============================================================
   ETA (Edge Thin Agent) — Search Engines (CORS, Brave, arXiv, Scholar, GitHub, Web Fetch)
   ============================================================ */

// ── CORS 代理 ──
const CORS_PROXIES = [
  url => `https://cors-get-proxy.sirjosh.workers.dev/?url=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

/* ── 直连优先取文本 ──
   给已确认返回 Access-Control-Allow-Origin 的接口用（维基百科需带 origin=*，
   PubMed/NCBI 原生就发 ACAO: *）。这类请求没有理由经过第三方 CORS 代理：
   代理会看到完整 URL（含搜索词），还多一跳延迟和一个故障点。

   直连失败才回退 fetchViaProxy，保证 file:// 打开、或对方临时改动 CORS 策略时
   功能不至于直接挂掉。file:// 下 origin 是 'null'，多数接口不会放行，
   所以那种情况直接走代理不浪费一次必然失败的请求。 */
async function fetchDirectText(url, timeoutMs = 15000, parentSignal) {
  if (location.protocol !== 'file:') {
    const ctrl = new AbortController();
    let onAbort;
    if (parentSignal) {
      if (parentSignal.aborted) ctrl.abort();
      else { onAbort = () => ctrl.abort(); parentSignal.addEventListener('abort', onAbort, { once: true }); }
    }
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (r.ok) return await r.text();
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      // 用户主动中止不该被当成"直连失败"而触发代理重试
      if (parentSignal?.aborted) throw e;
      console.warn(`[Search] 直连失败，回退 CORS 代理: ${e.message}`);
    } finally {
      clearTimeout(timer);
      if (parentSignal && onAbort) parentSignal.removeEventListener('abort', onAbort);
    }
  }
  return fetchViaProxy(url, timeoutMs, parentSignal);
}

async function fetchViaProxy(url, timeoutMs = 15000, parentSignal) {
  const localCtrl = new AbortController();
  const localSignal = localCtrl.signal;
  let onParentAbort;
  if (parentSignal) {
    if (parentSignal.aborted) { localCtrl.abort(); }
    else {
      onParentAbort = () => localCtrl.abort();
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  const timer = setTimeout(() => localCtrl.abort(), timeoutMs);
  const isFileProtocol = location.protocol === 'file:';
  const urls = isFileProtocol ? CORS_PROXIES.map(p => p(url)) : [url, ...CORS_PROXIES.map(p => p(url))];
  try {
    const resp = await Promise.any(urls.map(async u => {
      const r = await fetch(u, { signal: localSignal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    }));
    const text = await resp.text();
    return text;
  } catch(e) {
    throw new Error('All request methods failed (direct + CORS proxies)');
  } finally {
    clearTimeout(timer);
    localCtrl.abort();
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

// ── Brave Search API ──
async function doBraveSearch(query, numResults = 8, parentSignal) {
  const braveKey = $('cfgBraveKey').value.trim();
  if (!braveKey) return { error: 'Brave Search Key 未配置', results: [], engine: 'Brave' };
  const apiUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(numResults, 20)}`;
  try {
    const signals = [AbortSignal.timeout(15000)];
    if (parentSignal) signals.push(parentSignal);
    const resp = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey },
      signal: AbortSignal.any ? AbortSignal.any(signals) : signals[0],
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { error: `Brave Search 错误 (HTTP ${resp.status}): ${errText.slice(0, 100)}`, results: [], engine: 'Brave' };
    }
    const data = await resp.json();
    const results = [];
    for (const item of (data.web?.results || [])) {
      if (results.length >= numResults) break;
      results.push({
        title: item.title || '',
        link: item.url || '',
        snippet: (item.description || '').replace(/<\/?strong>/g, ''),
        source: 'Brave',
      });
    }
    return { error: null, results, engine: 'Brave' };
  } catch(e) {
    return { error: `Brave Search 异常 (可能是 CORS 限制): ${e.message}`, results: [], engine: 'Brave' };
  }
}

// ── 通用搜索 ──
async function doWebSearch(query, numResults = 6, parentSignal) {
  const braveKey = $('cfgBraveKey').value.trim();
  if (braveKey) return doBraveSearch(query, numResults, parentSignal);
  return { error: '搜索不可用，请配置 Brave Search Key', results: [], engine: 'none' };
}

// ── arXiv 原生 API 搜索 ──
async function doArxivSearch(query, numResults = 10, parentSignal) {
  const apiUrl = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${numResults}&sortBy=relevance&sortOrder=descending`;
  try {
    const xml = await fetchViaProxy(apiUrl, 15000, parentSignal);
    const res = parseArxivSearchResults(xml, numResults);
    res.engine = 'arXiv API';
    return res;
  } catch(e) {
    return { error: `arXiv search failed: ${e.message}`, results: [], engine: 'arXiv API' };
  }
}

function parseArxivSearchResults(xml, max) {
  const results = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const entries = doc.querySelectorAll('entry');
  for (const entry of entries) {
    if (results.length >= max) break;
    const title = entry.querySelector('title')?.textContent?.trim().replace(/\s+/g, ' ') || '';
    const summary = entry.querySelector('summary')?.textContent?.trim().replace(/\s+/g, ' ') || '';
    const authors = [...entry.querySelectorAll('author name')].map(n => n.textContent.trim());
    const published = entry.querySelector('published')?.textContent?.slice(0, 10) || '';
    const idEl = entry.querySelector('id');
    const link = idEl?.textContent?.trim() || '';
    if (!title) continue;
    results.push({
      title: title,
      link: link,
      snippet: `${authors.slice(0, 3).join(', ')}${authors.length > 3 ? ' et al.' : ''} (${published}) — ${summary.slice(0, 200)}${summary.length > 200 ? '...' : ''}`,
      source: 'arXiv',
    });
  }
  return { error: null, results };
}

/* ── 学术搜索 ──
   策略: Semantic Scholar → OpenAlex → CrossRef，三者都免费且无需密钥。
   原先第一档是 SerpAPI 的 Google Scholar，已移除（密钥会经 CORS 代理泄露）。 */
async function doScholarSearch(query, numResults = 10, parentSignal) {
  // 1. Semantic Scholar（免费，无需 key，覆盖面广）
  try {
    const ssResult = await doSemanticScholarSearch(query, numResults, parentSignal);
    if (!ssResult.error && ssResult.results.length > 0) return ssResult;
    console.warn('Semantic Scholar 无结果，尝试 OpenAlex');
  } catch(e) {
    console.warn('Semantic Scholar 异常:', e.message);
  }

  // 2. OpenAlex（完全免费，无反爬，覆盖 2.5 亿+ 论文）
  try {
    const oaResult = await doOpenAlexSearch(query, numResults, parentSignal);
    if (!oaResult.error && oaResult.results.length > 0) return oaResult;
    console.warn('OpenAlex 无结果，尝试 CrossRef');
  } catch(e) {
    console.warn('OpenAlex 异常:', e.message);
  }

  // 3. CrossRef（完全免费，覆盖 DOI 文献）
  try {
    return await doCrossRefSearch(query, numResults, parentSignal);
  } catch(e) {
    return { error: `所有学术搜索源均失败 (最后: ${e.message})`, results: [], engine: 'Scholar (all failed)' };
  }
}

// ── Semantic Scholar ──
async function doSemanticScholarSearch(query, numResults = 10, parentSignal) {
  const apiUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${numResults}&fields=title,authors,year,abstract,externalIds,url,citationCount,venue`;
  const text = await fetchViaProxy(apiUrl, 15000, parentSignal);
  const data = JSON.parse(text);
  const res = parseScholarResults(data, numResults);
  res.engine = 'Semantic Scholar';
  return res;
}

function parseScholarResults(data, max) {
  const results = [];
  const papers = data?.data || [];
  for (const p of papers) {
    if (results.length >= max) break;
    const authors = (p.authors || []).map(a => a.name);
    const arxivId = p.externalIds?.ArXiv;
    let link = p.url || '';
    if (arxivId) link = `https://arxiv.org/abs/${arxivId}`;
    const citations = p.citationCount ? ` [cited: ${p.citationCount}]` : '';
    const venue = p.venue ? ` @ ${p.venue}` : '';
    results.push({
      title: p.title || '(无标题)',
      link: link,
      snippet: `${authors.slice(0, 3).join(', ')}${authors.length > 3 ? ' et al.' : ''} (${p.year || '?'})${venue}${citations} — ${(p.abstract || '').slice(0, 200)}${(p.abstract || '').length > 200 ? '...' : ''}`,
      source: 'Semantic Scholar',
    });
  }
  return { error: null, results };
}

// ── OpenAlex（完全免费，无反爬，2.5亿+ 论文）──
async function doOpenAlexSearch(query, numResults = 10, parentSignal) {
  const apiUrl = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${numResults}&sort=relevance_score:desc&select=id,title,authorships,publication_year,doi,cited_by_count,primary_location,abstract_inverted_index`;
  try {
    const text = await fetchDirectText(apiUrl, 15000, parentSignal);
    const data = JSON.parse(text);
    const results = [];
    for (const work of (data.results || [])) {
      if (results.length >= numResults) break;
      const authors = (work.authorships || []).map(a => a.author?.display_name).filter(Boolean);
      const doi = work.doi ? work.doi.replace('https://doi.org/', '') : '';
      let link = work.doi || work.primary_location?.landing_page_url || work.id || '';
      const abstract = invertedIndexToText(work.abstract_inverted_index);
      const citations = work.cited_by_count ? ` [cited: ${work.cited_by_count}]` : '';
      const venue = work.primary_location?.source?.display_name || '';
      results.push({
        title: work.title || '(无标题)',
        link: link,
        snippet: `${authors.slice(0, 3).join(', ')}${authors.length > 3 ? ' et al.' : ''} (${work.publication_year || '?'})${venue ? ' @ ' + venue : ''}${citations}${doi ? ' DOI:' + doi : ''} — ${abstract.slice(0, 200)}${abstract.length > 200 ? '...' : ''}`,
        source: 'OpenAlex',
      });
    }
    return { error: null, results, engine: 'OpenAlex' };
  } catch(e) {
    return { error: `OpenAlex search failed: ${e.message}`, results: [], engine: 'OpenAlex' };
  }
}

// OpenAlex 的 abstract 是 inverted index 格式，需要还原
function invertedIndexToText(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) { words[pos] = word; }
  }
  return words.filter(Boolean).join(' ');
}

// ── CrossRef（完全免费，覆盖 DOI 文献）──
async function doCrossRefSearch(query, numResults = 10, parentSignal) {
  const apiUrl = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${numResults}&sort=relevance&order=desc&select=DOI,title,author,published-print,published-online,container-title,abstract,URL`;
  try {
    const text = await fetchDirectText(apiUrl, 15000, parentSignal);
    const data = JSON.parse(text);
    const results = [];
    for (const item of (data.message?.items || [])) {
      if (results.length >= numResults) break;
      const title = Array.isArray(item.title) ? item.title[0] : (item.title || '');
      const authors = (item.author || []).map(a => [a.given, a.family].filter(Boolean).join(' '));
      const year = item['published-print']?.['date-parts']?.[0]?.[0] || item['published-online']?.['date-parts']?.[0]?.[0] || '?';
      const venue = Array.isArray(item['container-title']) ? item['container-title'][0] : '';
      const doi = item.DOI || '';
      const link = item.URL || (doi ? `https://doi.org/${doi}` : '');
      let abstract = (item.abstract || '').replace(/<[^>]+>/g, '').trim();
      results.push({
        title: title || '(无标题)',
        link: link,
        snippet: `${authors.slice(0, 3).join(', ')}${authors.length > 3 ? ' et al.' : ''} (${year})${venue ? ' @ ' + venue : ''}${doi ? ' DOI:' + doi : ''} — ${abstract.slice(0, 200)}${abstract.length > 200 ? '...' : ''}`,
        source: 'CrossRef',
      });
    }
    return { error: null, results, engine: 'CrossRef' };
  } catch(e) {
    return { error: `CrossRef search failed: ${e.message}`, results: [], engine: 'CrossRef' };
  }
}

// ── GitHub 搜索 ──
async function doGithubSearch(query, numResults = 10, parentSignal) {
  const apiUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${numResults}`;
  try {
    const text = await fetchDirectText(apiUrl, 15000, parentSignal);
    const data = JSON.parse(text);
    const res = parseGithubResults(data, numResults);
    res.engine = 'GitHub API';
    return res;
  } catch(e) {
    return { error: `GitHub search failed: ${e.message}`, results: [], engine: 'GitHub API' };
  }
}

/* ── 通用网页搜索 ──
   原先走 SerpAPI，已彻底移除：SerpAPI 不返回 CORS 头，纯前端只能把
   「带 api_key 的完整 URL」交给第三方 CORS 代理转发，密钥必然落进代理的
   访问日志。Brave 把密钥放在 X-Subscription-Token 请求头且支持直连，
   不经任何代理，因此现在统一走 Brave。
   函数名保留，调用方（agent-commands.js 的 SEARCH_TOOLS）无需改动。 */
async function doGoogleSearch(query, numResults = 8, parentSignal) {
  return doBraveSearch(query, numResults, parentSignal);
}

function parseGithubResults(data, max) {
  const results = [];
  const items = data?.items || [];
  for (const repo of items) {
    if (results.length >= max) break;
    results.push({
      title: `${repo.full_name} ⭐${repo.stargazers_count}`,
      link: repo.html_url || '',
      snippet: `${repo.description || '(no description)'} | Language: ${repo.language || '?'} | Updated: ${(repo.updated_at || '').slice(0, 10)}`,
      source: 'GitHub',
    });
  }
  return { error: null, results };
}

// ── 通用：去掉 HTML 标签与常见实体（Wikipedia / HN / Stack Exchange 的字段都带标记）──
function decodeHtmlSnippet(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// ══════════════════════════════════════════════════════════
//  免 key 数据源：Wikipedia / Hacker News / PubMed / Stack Exchange
// ══════════════════════════════════════════════════════════

// ── Wikipedia（MediaWiki API，免 key，origin=* 原生支持 CORS）──
// 未显式指定 lang 时：含中日韩字符的查询走 zh 站，其余走 en 站
function detectWikiLang(query, lang) {
  if (lang) return String(lang).toLowerCase();
  return /[\u4e00-\u9fff\u3040-\u30ff]/.test(query || '') ? 'zh' : 'en';
}

async function doWikipediaSearch(query, numResults = 5, parentSignal, lang) {
  const site = detectWikiLang(query, lang);
  const engine = `Wikipedia (${site})`;
  // origin=* 让 MediaWiki 返回 ACAO: *（已实测），因此走直连而不是第三方代理
  const searchUrl = `https://${site}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${Math.min(numResults, 20)}&srprop=snippet|wordcount&format=json&origin=*`;
  try {
    const text = await fetchDirectText(searchUrl, 15000, parentSignal);
    const data = JSON.parse(text);
    const hits = data?.query?.search || [];
    if (!hits.length) return { error: null, results: [], engine };
    // 用页面标题批量取正文摘要（explaintext 去掉 wiki 标记）
    const titles = hits.slice(0, numResults).map(h => h.title);
    const extracts = await fetchWikipediaExtracts(site, titles, parentSignal);
    const results = [];
    for (const h of hits) {
      if (results.length >= numResults) break;
      const intro = extracts[h.title] || decodeHtmlSnippet(h.snippet);
      results.push({
        title: h.title,
        link: `https://${site}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
        snippet: `${intro.slice(0, 600)}${intro.length > 600 ? '...' : ''}${h.wordcount ? ` [${h.wordcount} words]` : ''}`,
        source: engine,
      });
    }
    return { error: null, results, engine };
  } catch(e) {
    return { error: `Wikipedia search failed: ${e.message}`, results: [], engine };
  }
}

// 批量取多个条目的开头摘要，返回 { 标题: 纯文本 }
async function fetchWikipediaExtracts(site, titles, parentSignal) {
  const map = {};
  if (!titles.length) return map;
  const url = `https://${site}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exintro=1&exlimit=max&redirects=1&titles=${encodeURIComponent(titles.join('|'))}&format=json&origin=*`;
  try {
    const text = await fetchDirectText(url, 15000, parentSignal);
    const pages = JSON.parse(text)?.query?.pages || {};
    for (const key of Object.keys(pages)) {
      const p = pages[key];
      if (p.title && p.extract) map[p.title] = p.extract.replace(/\s+/g, ' ').trim();
    }
  } catch(e) { /* 摘要取不到时回落到搜索 snippet */ }
  return map;
}

// Wikipedia 条目全文（explaintext 纯文本，比抓 HTML 干净得多）
async function fetchWikipediaFullText(title, site, originalUrl, parentSignal) {
  const url = `https://${site}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
  const text = await fetchDirectText(url, 20000, parentSignal);
  const pages = JSON.parse(text)?.query?.pages || {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined || !page.extract) {
    throw new Error(`Wikipedia 条目不存在或无正文: ${title}`);
  }
  let body = page.extract.replace(/\n{3,}/g, '\n\n').trim();
  const MAX_CHARS = 50000;
  if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + `\n\n[...content truncated, full text ${body.length} chars]`;
  return { error: null, content: `[Wikipedia Article] ${originalUrl}\nTitle: ${page.title}\nSite: ${site}.wikipedia.org\n\n${body}` };
}

function extractWikipediaTitle(url) {
  const m = url.match(/^https?:\/\/([a-z-]{2,12})\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
  if (!m) return null;
  try { return { site: m[1].toLowerCase(), title: decodeURIComponent(m[2]).replace(/_/g, ' ') }; }
  catch(e) { return { site: m[1].toLowerCase(), title: m[2].replace(/_/g, ' ') }; }
}

// ── Hacker News（Algolia API，免 key，原生 CORS）──
async function doHackerNewsSearch(query, numResults = 10, parentSignal) {
  const engine = 'Hacker News';
  const apiUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${Math.min(numResults, 30)}`;
  try {
    const text = await fetchDirectText(apiUrl, 15000, parentSignal);
    const data = JSON.parse(text);
    const results = [];
    for (const hit of (data.hits || [])) {
      if (results.length >= numResults) break;
      const title = hit.title || hit.story_title || decodeHtmlSnippet(hit.comment_text).slice(0, 80);
      if (!title) continue;
      const hnLink = `https://news.ycombinator.com/item?id=${hit.objectID}`;
      const origin = hit.url || hit.story_url || '';
      const date = (hit.created_at || '').slice(0, 10);
      const parts = [
        `${hit.points || 0} points`,
        `${hit.num_comments || 0} comments`,
        hit.author ? `by ${hit.author}` : '',
        date,
      ].filter(Boolean);
      results.push({
        title: title,
        link: hnLink,
        snippet: `${parts.join(' | ')}${origin ? ` | Article: ${origin}` : ''}${hit.story_text ? ` — ${decodeHtmlSnippet(hit.story_text).slice(0, 200)}` : ''}`,
        source: engine,
      });
    }
    return { error: null, results, engine };
  } catch(e) {
    return { error: `Hacker News search failed: ${e.message}`, results: [], engine };
  }
}

// ── PubMed（NCBI E-utilities，免 key）──
// 两步：esearch 拿 PMID 列表 → esummary 拿标题/作者/期刊/年份
async function doPubMedSearch(query, numResults = 10, parentSignal) {
  const engine = 'PubMed';
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const searchUrl = `${base}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${Math.min(numResults, 30)}&retmode=json&sort=relevance`;
  try {
    const sd = await fetchJsonWithRetry(searchUrl, parentSignal);
    const sr = sd?.esearchresult || null;
    if (sr && sr.ERROR) return { error: `PubMed 查询错误: ${sr.ERROR}`, results: [], engine };
    const ids = sr?.idlist || [];
    if (!ids.length) {
      if (!sd) return { error: 'PubMed 请求失败（可能触发 NCBI 限流，稍后重试或改用 search_scholar）', results: [], engine };
      return { error: null, results: [], engine };
    }
    const sumUrl = `${base}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`;
    const sumData = await fetchJsonWithRetry(sumUrl, parentSignal);
    if (!sumData) return { error: 'PubMed 摘要请求失败（可能触发 NCBI 限流）', results: [], engine };
    const res = parsePubMedResults(sumData, numResults);
    res.engine = engine;
    return res;
  } catch(e) {
    return { error: `PubMed search failed: ${e.message}`, results: [], engine };
  }
}

/* NCBI 免 key 限 3 请求/秒（HTTP 429），并发调用时需退避重试；全部失败返回 null。
   NCBI 原生返回 ACAO: *（已实测），故走 fetchDirectText 直连。 */
async function fetchJsonWithRetry(url, parentSignal, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    // 指数退避 + 随机抖动，避免同一轮的多个并发调用步调一致地反复撞限流
    if (i) await new Promise(r => setTimeout(r, 400 * Math.pow(2, i - 1) + Math.random() * 400));
    if (parentSignal?.aborted) return null;
    try { return JSON.parse(await fetchDirectText(url, 15000, parentSignal)); }
    catch(e) { if (i === attempts - 1) return null; }
  }
  return null;
}

function parsePubMedResults(data, max) {
  const results = [];
  const result = data?.result || {};
  for (const uid of (result.uids || [])) {
    if (results.length >= max) break;
    const r = result[uid];
    if (!r) continue;
    const authors = (r.authors || []).map(a => a.name).filter(Boolean);
    const year = (r.pubdate || r.epubdate || '').slice(0, 4);
    const doi = (r.articleids || []).find(x => x.idtype === 'doi')?.value || '';
    const meta = [
      `${authors.slice(0, 3).join(', ')}${authors.length > 3 ? ' et al.' : ''}`,
      r.source ? `@ ${r.source}` : '',
      year ? `(${year})` : '',
      doi ? `DOI:${doi}` : '',
      `PMID:${uid}`,
    ].filter(Boolean);
    results.push({
      title: decodeHtmlSnippet(r.title) || '(无标题)',
      link: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      snippet: meta.join(' '),
      source: 'PubMed',
    });
  }
  return { error: null, results };
}

// ── Stack Exchange（免 key，默认 stackoverflow 站点）──
/* 该 API 响应是 gzip，浏览器直连会自动解压；个别 CORS 代理会把二进制透传回来。
   现已改直连（实测 ACAO: *），正常路径不再有这个问题，但 file:// 或直连失败时
   仍会回退代理，所以保留解析失败的可读提示。 */
async function doStackExchangeSearch(query, numResults = 10, parentSignal, site = 'stackoverflow') {
  const engine = site === 'stackoverflow' ? 'Stack Overflow' : `Stack Exchange (${site})`;
  const apiUrl = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=${encodeURIComponent(site)}&pagesize=${Math.min(numResults, 30)}&filter=default`;
  try {
    const text = await fetchDirectText(apiUrl, 15000, parentSignal);
    const data = parseLooseJson(text);
    if (!data) {
      return { error: `Stack Exchange 响应无法解析（可能是 gzip 未解压的代理响应），请改用其他搜索工具`, results: [], engine };
    }
    if (data.error_message) {
      return { error: `Stack Exchange 错误: ${data.error_message}`, results: [], engine };
    }
    const res = parseStackExchangeResults(data, numResults, engine);
    res.engine = engine;
    return res;
  } catch(e) {
    return { error: `Stack Exchange search failed: ${e.message}`, results: [], engine };
  }
}

// 容错 JSON 解析：部分代理会在 JSON 前后夹杂杂字符，退一步截取首尾花括号再试
function parseLooseJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch(e) { /* 继续尝试 */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch(e) { return null; }
}

function parseStackExchangeResults(data, max, engine) {
  const results = [];
  for (const item of (data.items || [])) {
    if (results.length >= max) break;
    const status = item.is_answered ? '✔ answered' : '✘ unanswered';
    const date = item.creation_date ? new Date(item.creation_date * 1000).toISOString().slice(0, 10) : '';
    const meta = [
      `score ${item.score ?? 0}`,
      status,
      `${item.answer_count ?? 0} answers`,
      item.view_count ? `${item.view_count} views` : '',
      date,
      (item.tags || []).length ? `tags: ${item.tags.join(', ')}` : '',
    ].filter(Boolean);
    results.push({
      title: decodeHtmlSnippet(item.title) || '(无标题)',
      link: item.link || '',
      snippet: meta.join(' | '),
      source: engine,
    });
  }
  return { error: null, results };
}

// ── 网页抓取 ──
// 已知反爬域名列表 — 直接 fetch 会被拦截，返回友好提示
const BLOCKED_DOMAINS = [
  { pattern: /scholar\.google\./i, name: 'Google Scholar', hint: '请改用 [SEARCH_SCHOLAR] 或 [SEARCH_ARXIV] 搜索学术论文，不要再尝试 FETCH 此域名' },
  { pattern: /google\.com\/search/i, name: 'Google Search', hint: '请改用 [SEARCH_GOOGLE] 搜索，不要再尝试 FETCH 此域名' },
  { pattern: /google\.com\.hk\/search/i, name: 'Google Search', hint: '请改用 [SEARCH_GOOGLE] 搜索，不要再尝试 FETCH 此域名' },
  { pattern: /google\.com\/citations/i, name: 'Google Scholar', hint: '请改用 [SEARCH_SCHOLAR] 搜索该作者的论文，不要再尝试 FETCH 此域名' },
  { pattern: /scholar\.google\.com\/citations/i, name: 'Google Scholar', hint: '请改用 [SEARCH_SCHOLAR] 搜索该作者的论文，不要再尝试 FETCH 此域名' },
];

async function fetchWebPage(url, parentSignal) {
  // 拦截已知反爬域名
  for (const { pattern, name, hint } of BLOCKED_DOMAINS) {
    if (pattern.test(url)) {
      return { error: `[BLOCKED] ${name} 有严格反爬保护，无法通过 FETCH 抓取。${hint}。请立即换用其他搜索工具，不要重复尝试 FETCH 同一个被封锁的 URL。`, content: '' };
    }
  }
  try {
    const arxivId = extractArxivId(url);
    if (arxivId) {
      return await fetchArxivPaper(arxivId, url, parentSignal);
    }
    // Wikipedia 走 API 取纯文本正文，比抓 HTML 干净
    const wiki = extractWikipediaTitle(url);
    if (wiki) {
      try {
        return await fetchWikipediaFullText(wiki.title, wiki.site, url, parentSignal);
      } catch(e) { /* API 失败则回落到通用 HTML 抓取 */ }
    }
    const html = await fetchViaProxy(url, 15000, parentSignal);
    return { error: null, content: extractPageContent(html, url) };
  } catch(e) {
    return { error: `Fetch failed: ${e.message}`, content: '' };
  }
}

function extractArxivId(url) {
  let m = url.match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  if (m) return m[1];
  m = url.match(/ar5iv\.labs\.arxiv\.org\/html\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  if (m) return m[1];
  m = url.match(/arxiv\.org\/(?:abs|pdf)\/([a-z-]+\/\d{7}(?:v\d+)?)/);
  if (m) return m[1];
  return null;
}

async function fetchArxivPaper(arxivId, originalUrl, parentSignal) {
  let result = `[arXiv Paper] ${originalUrl}\nID: ${arxivId}\n\n`;
  let gotMeta = false;

  const arxivCtrl = new AbortController();
  let onParentAbort;
  if (parentSignal) {
    if (parentSignal.aborted) { arxivCtrl.abort(); }
    else {
      onParentAbort = () => arxivCtrl.abort();
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  const arxivTimer = setTimeout(() => arxivCtrl.abort(), 30000);
  const sig = arxivCtrl.signal;

  try {
  // 1. arXiv API 元数据
  try {
    const apiUrl = `https://export.arxiv.org/api/query?id_list=${arxivId}`;
    const apiXml = await fetchViaProxy(apiUrl, 15000, sig);
    const parser = new DOMParser();
    const doc = parser.parseFromString(apiXml, 'text/xml');
    const entry = doc.querySelector('entry');
    if (entry) {
      const title = entry.querySelector('title')?.textContent?.trim();
      const summary = entry.querySelector('summary')?.textContent?.trim();
      const authors = [...entry.querySelectorAll('author name')].map(n => n.textContent.trim());
      const published = entry.querySelector('published')?.textContent?.slice(0, 10);
      if (title) { result += `Title: ${title}\n`; gotMeta = true; }
      if (authors.length) result += `Authors: ${authors.join(', ')}\n`;
      if (published) result += `Published: ${published}\n`;
      if (summary) result += `\nAbstract:\n${summary}\n`;
    }
  } catch(e) { result += `[API metadata fetch failed: ${e.message}]\n`; }

  // 2. ar5iv HTML 全文
  let gotFullText = false;
  try {
    const htmlUrl = `https://ar5iv.labs.arxiv.org/html/${arxivId}`;
    const html = await fetchViaProxy(htmlUrl, 25000, sig);
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('nav,header,footer,.ltx_page_header,.ltx_page_footer,.ltx_sidebar,.ltx_TOC').forEach(el => el.remove());
    const article = doc.querySelector('.ltx_document') || doc.querySelector('article') || doc.body;
    let text = article?.textContent || '';
    text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
    if (text.length > 500) {
      gotFullText = true;
      const MAX_CHARS = 50000;
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + `\n\n[...content truncated, full text ${text.length} chars]`;
      result += `\n--- Paper Full Text (ar5iv HTML) ---\n${text}`;
      result += `\n\n[Full HTML version: ${htmlUrl}]`;
    }
  } catch(e) { /* ar5iv failed */ }

  // 3. fallback: arxiv abs 页面
  if (!gotFullText) {
    try {
      const absUrl = `https://arxiv.org/abs/${arxivId}`;
      const html = await fetchViaProxy(absUrl, 15000, sig);
      const content = extractPageContent(html, absUrl);
      if (content.length > 200) {
        result += `\n--- arxiv page content ---\n${content}`;
      }
    } catch(e) {
      result += `\n[arxiv page fetch also failed: ${e.message}]`;
    }
    result += `\n\n[Note: ar5iv HTML full text fetch failed. You can manually visit https://ar5iv.labs.arxiv.org/html/${arxivId}]`;
  }

  if (!gotMeta && !gotFullText) {
    return { error: `arXiv paper ${arxivId} fetch failed (both API and HTML unavailable)`, content: result };
  }
  return { error: null, content: result };
  } finally {
    clearTimeout(arxivTimer);
    arxivCtrl.abort();
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

function extractPageContent(html, url) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  for (const sel of ['script','style','nav','footer','header','aside','iframe','noscript','.ad,.ads,.advertisement,.sidebar,.menu,.nav']) {
    doc.querySelectorAll(sel).forEach(el => el.remove());
  }
  const title = doc.querySelector('title')?.textContent?.trim() || '';
  const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  const mainEl = doc.querySelector('article') || doc.querySelector('main') || doc.querySelector('.content') || doc.querySelector('#content') || doc.body;
  let text = mainEl ? mainEl.innerText || mainEl.textContent : '';
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  const MAX_CHARS = 30000;
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n\n[...content truncated, total ' + text.length + ' chars]';
  let result = `[Web Page Content] ${url}\n`;
  if (title) result += `Title: ${title}\n`;
  if (metaDesc) result += `Description: ${metaDesc}\n`;
  result += `\n${text}`;
  return result;
}

function formatSearchResultsForLLM(results, query) {
  if (!results.length) return `[Search "${query}" returned no results]`;
  let text = `\n[Search Results - "${query}"]\n`;
  results.forEach((r, i) => {
    text += `\n${i + 1}. ${r.title}`;
    if (r.link) text += `\n   URL: ${r.link}`;
    if (r.snippet) text += `\n   Snippet: ${r.snippet}`;
    text += '\n';
  });
  return text;
}
