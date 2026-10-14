const fs = require('fs');
const path = require('path');
const { sha256 } = require('./content-hash');
const { bodyText } = require('../retrieval-ranking');

// Version 2: fence-aware heading boundaries changed real chunk geometry (a
// fenced '#' comment no longer splits a section), so version-1 lexical caches
// must miss their sealed document hash and rebuild through the delta overlay.
const CHUNKER_VERSION = 2;
const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 120;
const EXCLUDED_DIRS = new Set(['.git', '_ai', '_backup', 'node_modules', 'dev-conversations']);
const DERIVED_INDEX_FILENAME = '00-index.md';

function normalizeRel(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isExcludedKnowledgePath(value) {
  return normalizeRel(value).split('/').some(segment => segment.startsWith('.') || EXCLUDED_DIRS.has(segment.toLowerCase()));
}

function stripFrontmatter(markdown) {
  return String(markdown || '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '');
}

function parseListValue(value) {
  const raw = String(value || '').trim();
  const body = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return body.split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function parseKnowledgeMetadata(markdown) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(String(markdown || ''));
  if (!match) return { tags: [], sourcePaths: [], routes: [], symbols: [], affectedModules: [] };
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (field) values[field[1].toLowerCase()] = field[2];
  }
  return {
    tags: parseListValue(values.tags),
    sourcePaths: parseListValue(values.sourcepaths || values.source_paths),
    routes: parseListValue(values.routes),
    symbols: parseListValue(values.symbols),
    affectedModules: parseListValue(values.affectedmodules || values.affected_modules),
  };
}

function splitLongText(text, maxChars, overlapChars, base = 0) {
  const raw = String(text || '');
  const clean = raw.trim();
  if (!clean) return [];
  const origin = base + (raw.length - raw.trimStart().length);
  if (clean.length <= maxChars) return [{ text: clean, start: origin, end: origin + clean.length }];
  const parts = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      const floor = start + Math.floor(maxChars * 0.6);
      const boundary = Math.max(clean.lastIndexOf('\n\n', end), clean.lastIndexOf('。', end), clean.lastIndexOf('. ', end));
      if (boundary >= floor) end = boundary + 1;
    }
    const piece = clean.slice(start, end);
    const trimmed = piece.trim();
    if (trimmed) {
      const lead = piece.length - piece.trimStart().length;
      parts.push({ text: trimmed, start: origin + start + lead, end: origin + start + lead + trimmed.length });
    }
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return parts;
}

// Heading and fence parsing must stay identical to the slice heading scan in
// retrieval.js so vector slices report the same heading paths as chunks.
function lineFenceState(line, fence) {
  const marker = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!marker) return fence;
  if (!fence) return marker[2];
  if (fence[0] === marker[2][0] && marker[2].length >= fence.length && !marker[3].trim()) return null;
  return fence;
}

function headingOf(line) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  return match ? { level: match[1].length, text: match[2].trim() } : null;
}

function chunkMarkdown(markdown, options = {}) {
  const maxChars = Number(options.maxChars || DEFAULT_MAX_CHARS);
  const overlapChars = Math.min(Number(options.overlapChars || DEFAULT_OVERLAP_CHARS), Math.floor(maxChars / 3));
  const body = bodyText(markdown);
  const lines = body.split('\n');
  const headings = [];
  const sections = [];
  let buffer = [];
  let bufferStart = 0;
  let sectionHeadings = [];
  let fence = null;

  const flush = () => {
    const text = buffer.join('\n');
    const trimmed = text.trim();
    if (trimmed) {
      const lead = text.length - text.trimStart().length;
      const trail = text.length - text.trimEnd().length;
      sections.push({ headingPath: [...sectionHeadings], text: trimmed, start: bufferStart + lead, end: bufferStart + text.length - trail });
    }
    buffer = [];
  };

  let offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    fence = lineFenceState(line, fence);
    // Only real headings outside code fences split sections; a fenced '#'
    // comment is plain content.
    const heading = fence ? null : headingOf(line);
    if (heading) {
      flush();
      headings.length = heading.level - 1;
      headings[heading.level - 1] = heading.text;
      sectionHeadings = headings.filter(Boolean);
    }
    if (!buffer.length) bufferStart = lineStart;
    buffer.push(line);
  }
  flush();

  const chunks = [];
  for (const section of sections) {
    for (const part of splitLongText(section.text, maxChars, overlapChars, section.start)) {
      chunks.push({
        chunkOrder: chunks.length,
        headingPath: section.headingPath,
        chunkText: part.text,
        startPos: part.start,
        endPos: part.end,
      });
    }
  }
  return chunks;
}

function isDerivedIndex(filePath) {
  return path.basename(String(filePath || '')).toLowerCase() === DERIVED_INDEX_FILENAME;
}

function listMarkdownFiles(root, options = {}) {
  const includeDerived = options.includeDerived === true;
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name.toLowerCase())) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && /\.md$/i.test(entry.name) && (includeDerived || !isDerivedIndex(entry.name))) files.push(abs);
    }
  };
  if (fs.existsSync(root)) walk(path.resolve(root));
  return files.sort();
}

function inferEntryType(relativePath) {
  const rel = normalizeRel(relativePath).toLowerCase();
  if (rel === 'goal.md') return 'goal';
  if (rel === 'architecture.md') return 'architecture';
  if (rel.startsWith('modules/')) return 'module';
  if (rel.startsWith('changes/')) return 'change';
  return 'document';
}

function inferTitle(markdown, relativePath) {
  const heading = /^#\s+(.+)$/m.exec(stripFrontmatter(markdown));
  return heading ? heading[1].trim() : path.basename(relativePath, path.extname(relativePath));
}

class MarkdownKnowledgeIndexer {
  constructor(options = {}) {
    if (!options.database) throw new Error('database is required');
    if (!options.embedder) throw new Error('embedder is required');
    this.database = options.database;
    this.embedder = options.embedder;
    this.maxChars = options.maxChars || DEFAULT_MAX_CHARS;
    this.overlapChars = options.overlapChars || DEFAULT_OVERLAP_CHARS;
  }

  async indexFile(input) {
    const filePath = path.resolve(input.filePath);
    const relativePath = normalizeRel(input.relativePath || path.basename(filePath));
    const markdown = fs.readFileSync(filePath, 'utf8');
    const documentHash = sha256(`chunker:${CHUNKER_VERSION}\n${markdown}`);
    const existing = await this.database.rowsForEntry(input.spaceId, relativePath);
    if (existing.length && existing.every(row => row.document_hash === documentHash)) {
      return { ok: true, action: 'unchanged', entryId: relativePath, chunks: existing.length, documentHash };
    }
    const title = inferTitle(markdown, relativePath);
    const metadata = parseKnowledgeMetadata(markdown);
    const rawChunks = chunkMarkdown(markdown, { maxChars: this.maxChars, overlapChars: this.overlapChars });
    const chunks = [];
    for (const chunk of rawChunks) {
      const embeddingText = [title, chunk.headingPath.join(' > '), chunk.chunkText].filter(Boolean).join('\n');
      chunks.push({
        ...chunk,
        title,
        entryType: inferEntryType(relativePath),
        // Keyword search now indexes chunk_text directly. Keep only compact
        // title/heading metadata in the legacy search_text column so new rows
        // do not duplicate the entire document body.
        searchText: [title, chunk.headingPath.join(' > ')].filter(Boolean).join('\n'),
        vector: await this.embedder.embedPassage(embeddingText),
        tags: [...new Set([...metadata.tags, ...metadata.affectedModules])],
        sourcePaths: metadata.sourcePaths.length ? metadata.sourcePaths : input.sourcePaths || [],
        routes: metadata.routes,
        symbols: metadata.symbols,
        sourceProjectId: input.sourceProjectId || '',
        sourceCommit: input.sourceCommit || '',
        documentHash,
      });
    }
    const result = await this.database.replaceEntry(input.spaceId, relativePath, chunks);
    return { ...result, entryId: relativePath, chunks: chunks.length, documentHash };
  }

  async indexDirectory(input) {
    const root = path.resolve(input.kbPath);
    const files = listMarkdownFiles(root);
    const present = new Set();
    const results = [];
    for (const filePath of files) {
      const relativePath = normalizeRel(path.relative(root, filePath));
      present.add(relativePath);
      results.push(await this.indexFile({ ...input, filePath, relativePath }));
    }
    const stale = (await this.database.entryIds(input.spaceId)).filter(entryId => !present.has(entryId));
    let deletedChunks = 0;
    for (const entryId of stale) deletedChunks += (await this.database.deleteEntry(input.spaceId, entryId)).deleted;
    const changed = results.filter(item => item.action !== 'unchanged');
    const operations = changed.length + stale.length;
    const rows = changed.reduce((sum, item) => sum + Number(item.upserted || 0) + Number(item.deleted || 0), 0) + deletedChunks;
    const mutationState = this.database.noteMutations({ operations, rows });
    let maintenance = { ok: true, optimized: false, deferred: input.deferMaintenance === true, state: mutationState };
    if (await this.database.count([input.spaceId])) {
      await this.database.ensureSearchIndexes();
      if (input.deferMaintenance !== true) maintenance = await this.database.maybeOptimize();
    }
    return {
      ok: true,
      spaceId: input.spaceId,
      files: files.length,
      indexed: changed.length,
      unchanged: results.filter(item => item.action === 'unchanged').length,
      deletedEntries: stale.length,
      deletedChunks,
      maintenance,
      results,
    };
  }
}

module.exports = {
  MarkdownKnowledgeIndexer,
  CHUNKER_VERSION,
  chunkMarkdown,
  lineFenceState,
  headingOf,
  listMarkdownFiles,
  isExcludedKnowledgePath,
  isDerivedIndex,
  inferEntryType,
  parseKnowledgeMetadata,
};
