'use strict';
const crypto = require('node:crypto');

const VERSION = 'project-knowledge/ranking-v2';
const STOP = new Set(('当前 最近 项目 开发 功能 实现 修改 添加 需要 使用 这个 那个 什么 怎么 一个 可以 是否 请 帮我 进行 相关 信息 内容 问题 代码 hello hi the a an is are of to in for and with please implement current project feature').split(' '));
const ALIASES = [
  ['unsaved', '未保存'], ['dirty', '脏状态'], ['dialog', '弹窗'], ['popup', '弹窗'], ['export', '导出'],
  ['recipe', '配方'], ['plate', '配方'], ['alignment', '对齐'], ['report', '报表'], ['commit', '提交'],
  ['vector', '向量'], ['retrieval', '检索'], ['search', '检索'], ['knowledge', '知识'], ['timeout', '超时'],
  ['cancel', '取消'], ['connection', '连接'], ['save', '保存'],
  ['engine', '引擎'], ['promotion', '晋升'], ['writer', '写入'],
  ['one writer', '单写者'], ['single-writer', '单写者'],
];
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
const termCache = new Map();

function terms(text) {
  // Cache only tokenization by content hash, never selected facts or scope
  // permissions. Canonical file and membership checks still run on every query.
  const key = crypto.createHash('sha256').update(String(text || '')).digest('hex');
  const prior = termCache.get(key);
  if (prior) { termCache.delete(key); termCache.set(key, prior); return prior; }
  const source = String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const words = segmenter ? [...segmenter.segment(source)].filter(s => s.isWordLike).map(s => s.segment) : source.match(/[\p{L}\p{N}_-]+/gu) || [];
  for (const token of source.match(/[a-z][a-z0-9_.\/-]+/g) || []) words.push(token);
  const main = words.filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
  const grams = [];
  for (const part of source.match(/[\p{Script=Han}]+/gu) || []) for (let i = 0; i < part.length - 1; i++) {
    const gram = part.slice(i, i + 2); if (!STOP.has(gram)) grams.push(gram);
  }
  for (const [english, chinese] of ALIASES) {
    if (new RegExp(`\\b${english}\\b`, 'i').test(source)) main.push(chinese);
    if (source.includes(chinese)) main.push(english);
  }
  const result = Object.freeze({ main: Object.freeze(main), grams: Object.freeze(grams) });
  termCache.set(key, result);
  while (termCache.size > 4096) termCache.delete(termCache.keys().next().value);
  return result;
}

function bodyText(markdown) {
  return String(markdown || '').replace(/\r\n/g, '\n').replace(/^---[^\S\n]*\n[\s\S]*?\n---[^\S\n]*(?:\n|$)/, '').replace(/^\n+/, '');
}
const bodyHash = text => crypto.createHash('sha256').update(bodyText(text), 'utf8').digest('hex');

function intent(query) {
  const text = String(query || '').trim();
  if (/^(?:hello|hi|hey|你好|您好|早上好|晚上好|在吗)[\s!！。?？]*$/i.test(text)) return 'greeting';
  if (/^(?:为什么|怎么回事|这是什么意思|继续|然后呢|展开说说|why|continue|tell me more)[\s!！。?？]*$/i.test(text)) return 'followup';
  if (/(你|本轮|本次|刚才|上一条|这段).*(知识|记忆|上下文|context|memory).*(来源|哪里|什么地方|收到|读取|获取|from|received)/i.test(text)) return 'followup';
  if (/(最近|最新|上次|上一[次回]|recent|latest|last)/i.test(text) && /(进度|开发|提交|修改|更新|改动|progress|commit|develop|change|update)/i.test(text)) return 'recent';
  return 'search';
}

function lexical(candidates, query, ignoredTerms = []) {
  const q = terms(query), wanted = new Map();
  const ignored = new Set(ignoredTerms);
  for (const word of q.main) if (!ignored.has(word)) wanted.set(word, 1);
  for (const gram of q.grams) if (!wanted.has(gram)) wanted.set(gram, 0.2);
  const rows = candidates.map(c => {
    const body = terms(c.chunkText), title = terms(`${c.title} ${c.headingPath.join(' ')} ${c.entryId}`), freq = new Map();
    for (const word of body.main) freq.set(word, (freq.get(word) || 0) + 1);
    for (const word of body.grams) freq.set(word, (freq.get(word) || 0) + 0.2);
    for (const word of title.main) freq.set(word, (freq.get(word) || 0) + 2);
    for (const word of title.grams) freq.set(word, (freq.get(word) || 0) + 0.4);
    return { c, freq, length: Math.max(1, body.main.length + body.grams.length * 0.2 + title.main.length) };
  });
  const average = rows.reduce((sum, r) => sum + r.length, 0) / Math.max(1, rows.length), df = new Map();
  for (const r of rows) for (const word of wanted.keys()) if (r.freq.has(word)) df.set(word, (df.get(word) || 0) + 1);
  for (const r of rows) {
    let score = 0, anchors = 0;
    for (const [word, weight] of wanted) {
      const tf = r.freq.get(word) || 0; if (!tf) continue;
      const count = df.get(word) || 0, idf = Math.log(1 + (rows.length - count + 0.5) / (count + 0.5));
      score += weight * idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * r.length / Math.max(1, average)));
      if (weight === 1 || word.length >= 2 && weight === 0.2) anchors++;
    }
    r.c.lexicalScore = score; r.c.lexicalAnchors = anchors;
  }
}

function rank(candidates, query, scoreIdentity, options = {}) {
  // A resolved commit already constrains provenance. Repeated SHA text in a
  // heading is not evidence for the topic asked about within that commit.
  lexical(candidates, query, options.commitPrefixes || []);
  const eligible = [];
  for (const c of candidates) {
    const identified = scoreIdentity(c);
    const exact = identified.selectionSignals.filter(s => /^(exact-|source-basename:|structured:)/.test(s));
    if (identified.excluded) continue;
    // Raw vector rank is not confidence. Uncalibrated and legacy results need
    // independent current-text support; only verified calibrated cosine may stand alone.
    const semantic = c.vectorVerified === true && c.vectorCalibrated === true && c.indexScore >= c.vectorMinScore;
    if (!exact.length && !c.lexicalAnchors && !semantic) continue;
    c.selectionSignals = [...exact, ...(c.lexicalScore > 0 ? ['lexical:bm25'] : []), ...(c.vectorVerified ? ['index:vector-hub'] : []),
      `scope:${c.scopeReason}`, ...(c.fromOverlay ? ['markdown-delta-overlay'] : [])];
    c.identityMatch = exact.length > 0;
    c.commitMatch = exact.includes('exact-commit');
    eligible.push(c);
  }
  const order = (a, b) => a.recordId.localeCompare(b.recordId);
  const lexicalRows = eligible.filter(c => c.lexicalScore > 0).sort((a, b) => b.lexicalScore - a.lexicalScore || order(a, b));
  const vectorRows = eligible.filter(c => c.vectorVerified && c.indexScore > 0).sort((a, b) => b.indexScore - a.indexScore || order(a, b));
  const scores = new Map();
  for (const list of [lexicalRows, vectorRows]) list.forEach((c, i) => scores.set(c.recordId, (scores.get(c.recordId) || 0) + 1 / (60 + i + 1)));
  // For a resolved commit, order its snippets by the remaining topic, not by
  // having two recall channels. Normal semantic queries keep RRF unchanged.
  for (const c of eligible) c.relevanceScore = c.commitMatch ? 1 + c.lexicalScore / (1 + c.lexicalScore)
    : (scores.get(c.recordId) || 0) + (c.identityMatch ? 1 : 0);
  eligible.sort((a, b) => b.relevanceScore - a.relevanceScore
    || Number(b.scopeReason === 'primary') - Number(a.scopeReason === 'primary') || order(a, b));
  const selected = [], byDocument = new Map();
  for (const c of eligible) {
    const key = `${c.spaceId}:${c.entryId}`, prior = byDocument.get(key) || [];
    const words = new Set(terms(c.chunkText.replace(/^#+.*$/gm, '')).main);
    if (prior.length >= 2 || prior.some(row => {
      if (row.contentHash === c.contentHash) return true;
      // Both offsets were verified against the same current body. A vector
      // substring and its containing Markdown chunk are one fact, even when
      // the small substring has low token-set similarity to the full section.
      const positioned = row.bodyHash && row.bodyHash === c.bodyHash
        && Number.isInteger(row.startPos) && Number.isInteger(row.endPos) && row.startPos >= 0 && row.endPos > row.startPos
        && Number.isInteger(c.startPos) && Number.isInteger(c.endPos) && c.startPos >= 0 && c.endPos > c.startPos;
      const smallSlice = Math.min(row.endPos - row.startPos, c.endPos - c.startPos) * 2 < Math.max(row.endPos - row.startPos, c.endPos - c.startPos);
      if (positioned && smallSlice && (row.startPos <= c.startPos && row.endPos >= c.endPos || c.startPos <= row.startPos && c.endPos >= row.endPos)) return true;
      const others = new Set(terms(row.chunkText.replace(/^#+.*$/gm, '')).main);
      const common = [...words].filter(w => others.has(w)).length;
      return common / Math.max(1, new Set([...words, ...others]).size) >= 0.9;
    })) continue;
    prior.push(c); byDocument.set(key, prior); selected.push(c);
  }
  return selected;
}

module.exports = { VERSION, terms, lexical, rank, intent, bodyText, bodyHash };
