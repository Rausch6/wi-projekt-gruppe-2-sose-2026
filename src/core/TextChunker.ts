import { words as naturalStopWords } from "natural/lib/natural/util/stopwords.js";
import stopwordsIso from "stopwords-iso/stopwords-iso.json";
import type { PageTextChunk } from "./PdfExtractor";

declare const Zotero: any;
import { config } from "../../package.json";
// Fallback auf globales Zotero.Addontemplate (falls addon nicht exportiert wird)
const getAddon = () => (globalThis as any).Zotero?.[config.addonInstance] || (globalThis as any).addon;

export interface TextChunk {
  id: string;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  estimatedTokens: number;
}

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

export interface SelectChunkOptions {
  maxChunks?: number;
  maxTokens?: number;
}

type TextUnit = {
  text: string;
  page: number | null;
  tokens: number;
};

const DEFAULT_TARGET_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 100;
const WORDS_PER_TOKEN = 0.75;
const REFERENCE_SECTION_HEADING =
  /(^|\n)\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:references|bibliography|works cited|literatur|literaturverzeichnis|quellen|quellenverzeichnis)\b/iu;
const NEGATION_WORDS = new Set([
  "no", "not", "nor", "never", "neither", "none", "nobody",
  "nothing", "nowhere", "cannot",
  "nicht", "nichts", "nie", "niemals", "niemand",
  "niemandem", "niemanden", "nirgendwo", "kein",
  "keine", "keinem", "keinen", "keiner", "keines",
  "weder", "ohne",
]);
const STOP_WORDS = new Set(
  [...naturalStopWords, ...stopwordsIso.de]
    .map(normalizeTerm)
    .filter((term) => isStopWordCandidate(term) && !NEGATION_WORDS.has(term)),
);

export function cleanPaperPages(pages: PageTextChunk[]) {
  const normalizedPages = pages
    .map((page) => ({
      ...page,
      text: normalizeExtractedText(page.text),
    }))
    .filter((page) => page.text);

  return removeRepeatedPageMargins(normalizedPages);
}

export function chunkPaperText(
  pages: PageTextChunk[],
  options: ChunkOptions = {},
): TextChunk[] {
  let defaultTarget = 512;
  let defaultOverlap = 100;

  try {
    const addonSettings = getAddon()?.data?.settings;
    const targetSetting = addonSettings?.chunkTargetTokens;
    const overlapSetting = addonSettings?.chunkOverlapTokens;

    if (typeof targetSetting === "number" && targetSetting > 0) defaultTarget = targetSetting;
    if (typeof overlapSetting === "number" && overlapSetting >= 0) defaultOverlap = overlapSetting;
  } catch (_e) {
    // Fallback auf Konstanten
  }

  const targetTokens = options.targetTokens ?? defaultTarget;
  const overlapTokens = Math.min(
    options.overlapTokens ?? defaultOverlap,
    Math.floor(targetTokens / 2),
  );

  try {
    Zotero.debug(`[TextChunker] Chunking paper text... targetTokens=${targetTokens}, overlapTokens=${overlapTokens}`);
  } catch (_e) {
    // ignore if Zotero is not defined in tests
  }
  const cleanedPages = removeReferenceSections(cleanPaperPages(pages));
  const units = createTextUnits(
    removeStopWordsFromPages(cleanedPages),
    targetTokens,
  );
  const chunks: TextChunk[] = [];
  let current: TextUnit[] = [];
  let currentTokens = 0;

  for (const unit of units) {
    if (current.length && currentTokens + unit.tokens > targetTokens) {
      chunks.push(createChunk(chunks.length, current));
      current = takeOverlapUnits(current, overlapTokens);
      currentTokens = sumTokens(current);
    }

    current.push(unit);
    currentTokens += unit.tokens;
  }

  if (current.length) {
    chunks.push(createChunk(chunks.length, current));
  }

  return chunks;
}

export function selectRelevantChunks(
  chunks: TextChunk[],
  query: string,
  options: SelectChunkOptions = {},
) {
  const maxChunks = options.maxChunks ?? 6;
  const maxTokens = options.maxTokens ?? 4_500;
  const queryTerms = extractTerms(query);

  const ranked = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: scoreChunk(chunk, queryTerms, index),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const selected: Array<{ chunk: TextChunk; index: number }> = [];
  let usedTokens = 0;

  for (const candidate of ranked) {
    if (selected.length >= maxChunks) break;
    if (
      selected.length &&
      usedTokens + candidate.chunk.estimatedTokens > maxTokens
    ) {
      continue;
    }

    selected.push(candidate);
    usedTokens += candidate.chunk.estimatedTokens;
  }

  return selected.sort((a, b) => a.index - b.index).map(({ chunk }) => chunk);
}

export function estimateTokens(text: string) {
  const words = text.trim().match(/\S+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(words / WORDS_PER_TOKEN));
}

function normalizeExtractedText(text: string) {
  return text
    .replace(/\u00ad/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, "$1$2")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(?<![.!?:;\n])\n(?=\S)/g, " ")
    .trim();
}

function removeRepeatedPageMargins(pages: PageTextChunk[]) {
  if (pages.length < 3) return pages;

  const candidates = pages.flatMap((page) => {
    const lines = page.text.split("\n").filter(Boolean);
    const edgeLines = [lines[0], lines.at(-1)].filter((line): line is string =>
      Boolean(line && line.length <= 160),
    );
    return [...new Set(edgeLines)];
  });
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = normalizeMarginLine(candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.ceil(pages.length * 0.6);
  const repeated = new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([line]) => line),
  );

  if (!repeated.size) return pages;

  return pages.map((page) => ({
    ...page,
    text: page.text
      .split("\n")
      .filter((line) => !repeated.has(normalizeMarginLine(line)))
      .join("\n")
      .trim(),
  }));
}

function normalizeMarginLine(line: string) {
  return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

function removeReferenceSections(pages: PageTextChunk[]) {
  if (!pages.length) return pages;

  const minimumReferencePageIndex = Math.max(
    0,
    Math.floor(pages.length * 0.45),
  );

  for (
    let index = minimumReferencePageIndex;
    index < pages.length;
    index += 1
  ) {
    const page = pages[index];
    const match = REFERENCE_SECTION_HEADING.exec(page.text);
    if (!match || !looksLikeReferenceSection(page.text.slice(match.index))) {
      continue;
    }

    const textBeforeReferences = page.text.slice(0, match.index).trim();
    return [
      ...pages.slice(0, index),
      ...(textBeforeReferences
        ? [{ ...page, text: textBeforeReferences }]
        : []),
    ];
  }

  return pages;
}

function looksLikeReferenceSection(text: string) {
  const sample = text.slice(0, 2_000);
  const referenceMarkers = [
    /\[[0-9]{1,3}\]/u,
    /^\s*[0-9]{1,3}\.\s+\p{Lu}/mu,
    /\(\d{4}[a-z]?\)/iu,
    /\bdoi\s*:/iu,
    /\bhttps?:\/\//iu,
    /\bet\s+al\./iu,
    /\bvol\.\s*\d+/iu,
  ];

  return referenceMarkers.some((marker) => marker.test(sample));
}

function removeStopWordsFromPages(pages: PageTextChunk[]) {
  return pages
    .map((page) => ({
      ...page,
      text: removeStopWords(page.text),
    }))
    .filter((page) => page.text);
}

function removeStopWords(text: string) {
  return text
    .replace(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu, (term) =>
      STOP_WORDS.has(normalizeTerm(term)) ? "" : term,
    )
    .split("\n")
    .map(cleanStopWordLine)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanStopWordLine(line: string) {
  return line
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/^[,.;:!?]+(?:\s+|$)/g, "")
    .replace(/[([{][ \t]*[)\]}]/g, "")
    .replace(/-{2,}/g, "-")
    .trim();
}

function createTextUnits(pages: PageTextChunk[], targetTokens: number) {
  return pages.flatMap((page) => {
    const paragraphs = page.text.split(/\n{2,}/).filter(Boolean);
    return paragraphs.flatMap((paragraph) =>
      splitOversizedUnit(paragraph, page.page, targetTokens),
    );
  });
}

function splitOversizedUnit(
  text: string,
  page: number | null,
  targetTokens: number,
) {
  if (estimateTokens(text) <= targetTokens) {
    return [{ text, page, tokens: estimateTokens(text) }];
  }

  const sentences = text.split(/(?<=[.!?])\s+(?=\p{Lu}|\d)/u);
  const units: TextUnit[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (current && estimateTokens(candidate) > targetTokens) {
      units.push({ text: current, page, tokens: estimateTokens(current) });
      current = sentence;
    } else {
      current = candidate;
    }
  }

  if (current) {
    units.push({ text: current, page, tokens: estimateTokens(current) });
  }

  return units;
}

function createChunk(index: number, units: TextUnit[]): TextChunk {
  const pages = units
    .map((unit) => unit.page)
    .filter((page): page is number => page !== null);
  const text = units.map((unit) => unit.text).join("\n\n");

  return {
    id: `C${index + 1}`,
    text,
    pageStart: pages.length ? Math.min(...pages) : null,
    pageEnd: pages.length ? Math.max(...pages) : null,
    estimatedTokens: estimateTokens(text),
  };
}

function takeOverlapUnits(units: TextUnit[], overlapTokens: number) {
  const overlap: TextUnit[] = [];
  let tokens = 0;

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (!unit) continue;
    overlap.unshift(unit);
    tokens += unit.tokens;
    if (tokens >= overlapTokens) break;
  }

  return overlap;
}

function sumTokens(units: TextUnit[]) {
  return units.reduce((sum, unit) => sum + unit.tokens, 0);
}

function extractTerms(query: string) {
  return [
    ...new Set(
      query
        .match(/[\p{L}\p{N}]{3,}/gu)
        ?.map(normalizeTerm)
        .filter((term) => !STOP_WORDS.has(term)) ?? [],
    ),
  ];
}

function scoreChunk(chunk: TextChunk, queryTerms: string[], index: number) {
  if (!queryTerms.length) return index === 0 ? 1 : 0;

  const normalizedText = chunk.text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss");
  let score = index === 0 ? 0.1 : 0;

  for (const term of queryTerms) {
    const matches = normalizedText.split(term).length - 1;
    if (matches) score += 1 + Math.log2(matches + 1);
  }

  return score / Math.sqrt(Math.max(1, chunk.estimatedTokens / 100));
}

function normalizeTerm(term: string) {
  return term
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss");
}

function isStopWordCandidate(term: string) {
  return (
    /^[\p{L}]+$/u.test(term) &&
    (term.length > 1 || term === "a" || term === "i")
  );
}
