/* ============================================================
   ETA (Edge Thin Agent) — Search Engines (CORS, Brave, SerpAPI, arXiv, Scholar, GitHub, Web Fetch)
   ============================================================ */

// ── CORS 代理 ──
const CORS_PROXIES = [
  url => `https://cors-get-proxy.sirjosh.workers.dev/?url=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

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
  const serpKey = $('cfgSerpApiKey').value.trim();
  if (serpKey) return doGoogleSearch(query, numResults, parentSignal);
  const braveKey = $('cfgBraveKey').value.trim();
  if (braveKey) return doBraveSearch(query, numResults, parentSignal);
  return { error: '搜索不可用，请配置 SerpAPI Key 或 Brave Search Key', results: [], engine: 'none' };
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

// ── 学术搜索 ──
async function doScholarSearch(query, numResults = 10, parentSignal) {
  // 策略: SerpAPI Google Scholar → Semantic Scholar → OpenAlex → CrossRef
  const serpKey = $('cfgSerpApiKey').value.trim();

  // 1. SerpAPI Google Scholar
  if (serpKey) {
    try {
      const apiUrl = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(query)}&num=${Math.min(numResults, 20)}&api_key=${encodeURIComponent(serpKey)}`;
      const text = await fetchViaProxy(apiUrl, 20000, parentSignal);
      const data = JSON.parse(text);
      if (data.error) throw new Error(data.error);
      const results = [];
      for (const item of (data.organic_results || [])) {
        if (results.length >= numResults) break;
        const authors = item.publication_info?.authors?.map(a => a.name).join(', ') || '';
        results.push({
          title: item.title || '',
          link: item.link || '',
          snippet: `${authors}${authors ? ' — ' : ''}${item.snippet || ''}`,
          source: 'Google Scholar (SerpAPI)',
        });
      }
      if (results.length > 0) return { error: null, results, engine: 'Google Scholar (SerpAPI)' };
      throw new Error('SerpAPI 返回 0 条结果');
    } catch(e) {
      console.warn('SerpAPI Scholar 异常，尝试 fallback:', e.message);
    }
  }

  // 2. Semantic Scholar（免费，无需 key，覆盖面广）
  try {
    const ssResult = await doSemanticScholarSearch(query, numResults, parentSignal);
    if (!ssResult.error && ssResult.results.length > 0) return ssResult;
    console.warn('Semantic Scholar 无结果，尝试 OpenAlex');
  } catch(e) {
    console.warn('Semantic Scholar 异常:', e.message);
  }

  // 3. OpenAlex（完全免费，无反爬，覆盖 2.5 亿+ 论文）
  try {
    const oaResult = await doOpenAlexSearch(query, numResults, parentSignal);
    if (!oaResult.error && oaResult.results.length > 0) return oaResult;
    console.warn('OpenAlex 无结果，尝试 CrossRef');
  } catch(e) {
    console.warn('OpenAlex 异常:', e.message);
  }

  // 4. CrossRef（完全免费，覆盖 DOI 文献）
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
    const text = await fetchViaProxy(apiUrl, 15000, parentSignal);
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
    const text = await fetchViaProxy(apiUrl, 15000, parentSignal);
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
    const text = await fetchViaProxy(apiUrl, 15000, parentSignal);
    const data = JSON.parse(text);
    const res = parseGithubResults(data, numResults);
    res.engine = 'GitHub API';
    return res;
  } catch(e) {
    return { error: `GitHub search failed: ${e.message}`, results: [], engine: 'GitHub API' };
  }
}

// ── SerpAPI Google 搜索 ──
async function doGoogleSearch(query, numResults = 8, parentSignal) {
  const serpKey = $('cfgSerpApiKey').value.trim();
  if (!serpKey) {
    return doBraveSearch(query, numResults, parentSignal);
  }
  const apiUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${Math.min(numResults, 10)}&api_key=${encodeURIComponent(serpKey)}`;
  try {
    const text = await fetchViaProxy(apiUrl, 20000, parentSignal);
    const data = JSON.parse(text);
    const results = [];
    for (const item of (data.organic_results || [])) {
      if (results.length >= numResults) break;
      results.push({
        title: item.title || '',
        link: item.link || '',
        snippet: item.snippet || '',
        source: 'Google (SerpAPI)',
      });
    }
    return { error: null, results, engine: 'Google (SerpAPI)' };
  } catch(e) {
    console.warn('SerpAPI Google 异常, fallback Brave:', e.message);
    return doBraveSearch(query, numResults, parentSignal);
  }
}

function parseGoogleResults(data, max) {
  const results = [];
  const items = data?.items || [];
  for (const item of items) {
    if (results.length >= max) break;
    results.push({ title: item.title || '', link: item.link || '', snippet: item.snippet || '', source: 'Google' });
  }
  return { error: null, results };
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
