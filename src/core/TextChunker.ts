import type { PageTextChunk } from "./PdfExtractor";

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

const DEFAULT_TARGET_TOKENS = 700;
const DEFAULT_OVERLAP_TOKENS = 100;
const WORDS_PER_TOKEN = 0.75;
const STOP_WORDS = new Set([
  "aber",
  "als",
  "auch",
  "auf",
  "aus",
  "bei",
  "das",
  "dem",
  "den",
  "der",
  "des",
  "die",
  "ein",
  "eine",
  "einer",
  "eines",
  "für",
  "ist",
  "mit",
  "nach",
  "oder",
  "sich",
  "sind",
  "und",
  "von",
  "was",
  "wie",
  "wird",
  "zu",
  "the",
  "and",
  "for",
  "from",
  "that",
  "this",
  "with",
  "what",
  "when",
  "where",
  "which",
  "why",
]);

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
) {
  const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapTokens = Math.min(
    options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
    Math.floor(targetTokens / 2),
  );
  const units = createTextUnits(cleanPaperPages(pages), targetTokens);
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
    return [lines[0], lines.at(-1)].filter((line): line is string =>
      Boolean(line && line.length <= 160),
    );
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
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .match(/[\p{L}\p{N}]{3,}/gu)
        ?.filter((term) => !STOP_WORDS.has(term)) ?? [],
    ),
  ];
}

function scoreChunk(chunk: TextChunk, queryTerms: string[], index: number) {
  if (!queryTerms.length) return index === 0 ? 1 : 0;

  const normalizedText = chunk.text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  let score = index === 0 ? 0.1 : 0;

  for (const term of queryTerms) {
    const matches = normalizedText.split(term).length - 1;
    if (matches) score += 1 + Math.log2(matches + 1);
  }

  return score / Math.sqrt(Math.max(1, chunk.estimatedTokens / 100));
}
