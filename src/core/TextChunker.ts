import { words as naturalStopWords } from "natural/lib/natural/util/stopwords.js";
import stopwordsIso from "stopwords-iso/stopwords-iso.json";
import type { PageTextChunk } from "./PdfExtractor";

declare const Zotero: any;
import { config } from "../../package.json";

const getAddon = () => (globalThis as any).Zotero?.[config.addonInstance] || (globalThis as any).addon;

/**
 * Ein einzelner Text-Chunk mit Metadaten zur Seitenposition und Token-Schätzung.
 */
export interface TextChunk {
  id: string;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  estimatedTokens: number;
}

/**
 * Optionen für die Chunking-Konfiguration.
 */
export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

/**
 * Optionen für die Auswahl relevanter Chunks bei einer Suchanfrage.
 */
export interface SelectChunkOptions {
  maxChunks?: number;
  maxTokens?: number;
}

type TextUnit = {
  text: string;
  page: number | null;
  tokens: number;
};

const DEFAULT_OVERLAP_TOKENS = 100;
const WORDS_PER_TOKEN = 0.75;
const REFERENCE_SECTION_HEADING =
  /(^|\n)\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:references|bibliography|works cited|literatur|literaturverzeichnis|quellen|quellenverzeichnis)\b/iu;
const NEGATION_WORDS = new Set([
  "no",
  "not",
  "nor",
  "never",
  "neither",
  "none",
  "nobody",
  "nothing",
  "nowhere",
  "cannot",
  "nicht",
  "nichts",
  "nie",
  "niemals",
  "niemand",
  "niemandem",
  "niemanden",
  "nirgendwo",
  "kein",
  "keine",
  "keinem",
  "keinen",
  "keiner",
  "keines",
  "weder",
  "ohne",
]);
const STOP_WORDS = new Set(
  [...naturalStopWords, ...stopwordsIso.de]
    .map(normalizeTerm)
    .filter((term) => isStopWordCandidate(term) && !NEGATION_WORDS.has(term)),
);

/**
 * Bereinigt und normalisiert Seitentext aus einem extrahierten PDF.
 * Entfernt wiederholte Seitenränder (Kopf- und Fußzeilen).
 *
 * @param pages - Rohe Seiten-Chunks aus dem PDF-Extraktor.
 * @returns Bereinigte Seiten-Chunks.
 */
export function cleanPaperPages(pages: PageTextChunk[]) {
  const normalizedPages = pages
    .map((page) => ({
      ...page,
      text: normalizeExtractedText(page.text),
    }))
    .filter((page) => page.text);

  return removeRepeatedPageMargins(normalizedPages);
}

/**
 * Zerlegt den Volltext eines Papers in überlappende Text-Chunks.
 * Liest Chunk-Größen aus den Addon-Einstellungen oder den übergebenen Optionen.
 * Entfernt vor dem Chunking Stoppwörter und Referenzabschnitte.
 *
 * @param pages - Seitentext-Chunks des Papers.
 * @param options - Optionale Chunking-Parameter (targetTokens, overlapTokens).
 * @returns Liste von Text-Chunks mit Metadaten.
 */
export function chunkPaperText(
  pages: PageTextChunk[],
  options: ChunkOptions = {},
): TextChunk[] {
  let defaultTarget = 1024;
  let defaultOverlap = DEFAULT_OVERLAP_TOKENS;

  try {
    const addonSettings = getAddon()?.data?.settings;
    const targetSetting = addonSettings?.chunkTargetTokens;
    const overlapSetting = addonSettings?.chunkOverlapTokens;

    if (typeof targetSetting === "number" && targetSetting > 0)
      defaultTarget = targetSetting;
    if (typeof overlapSetting === "number" && overlapSetting >= 0)
      defaultOverlap = overlapSetting;
  } catch (_e) {

  }

  const targetTokens = Math.min(8192, options.targetTokens ?? defaultTarget);
  const overlapTokens = Math.min(
    options.overlapTokens ?? defaultOverlap,
    Math.floor(targetTokens / 2),
  );

  try {
    Zotero.debug(
      `[TextChunker] Chunking paper text... targetTokens=${targetTokens}, overlapTokens=${overlapTokens}`,
    );
  } catch (_e) {
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

/**
 * Wählt aus einer Liste von Chunks die für eine Suchanfrage relevantesten aus.
 * Bewertet Chunks anhand der Häufigkeit der Suchbegriffe im Text.
 *
 * @param chunks - Alle verfügbaren Text-Chunks eines Papers.
 * @param query - Die Nutzersuchanfrage.
 * @param options - Optionale Grenzen für Chunk-Anzahl und Token-Gesamtzahl.
 * @returns Sortierte Liste der relevantesten Chunks.
 */
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

/**
 * Schätzt die Anzahl der Tokens in einem Text anhand der Wortanzahl.
 *
 * @param text - Der zu schätzende Text.
 * @returns Geschätzte Token-Anzahl (mindestens 1).
 */
export function estimateTokens(text: string) {
  const words = text.trim().match(/\S+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(words / WORDS_PER_TOKEN));
}

/**
 * Normalisiert den aus einem PDF extrahierten Rohtext.
 * Entfernt Soft-Hyphens, normalisiert Zeilenumbrüche und
 * rekonstruiert durch Silbentrennung unterbrochene Wörter.
 *
 * @param text - Der zu normalisierende Rohtext.
 * @returns Bereinigter Text.
 */
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

/**
 * Entfernt wiederholt auftretende Kopf- und Fußzeilen aus dem Seitentext.
 * Zeilen, die auf mindestens 60 % der Seiten identisch sind, werden gelöscht.
 *
 * @param pages - Normalisierte Seiten-Chunks.
 * @returns Seiten-Chunks ohne wiederkehrende Randzeilen.
 */
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

/**
 * Normalisiert eine Randzeile für den Vergleich: Kleinschreibung,
 * Ziffern zu `#`, mehrfache Leerzeichen zu einem.
 *
 * @param line - Die zu normalisierende Zeile.
 * @returns Normalisierte Randzeile.
 */
function normalizeMarginLine(line: string) {
  return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/**
 * Entfernt Literaturverzeichnis-Abschnitte ab dem späteren Drittel des Dokuments.
 *
 * @param pages - Bereinigte Seiten-Chunks.
 * @returns Seiten-Chunks bis einschließlich des letzten Inhalts vor dem Literaturverzeichnis.
 */
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

/**
 * Prüft anhand typischer Referenz-Muster, ob ein Textabschnitt
 * tatsächlich ein Literaturverzeichnis ist.
 *
 * @param text - Der zu prüfende Textabschnitt.
 * @returns True, wenn typische Referenz-Muster gefunden wurden.
 */
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

/**
 * Entfernt Stoppwörter aus allen Seiten eines Papers.
 *
 * @param pages - Seiten-Chunks mit normalem Text.
 * @returns Seiten-Chunks ohne Stoppwörter.
 */
function removeStopWordsFromPages(pages: PageTextChunk[]) {
  return pages
    .map((page) => ({
      ...page,
      text: removeStopWords(page.text),
    }))
    .filter((page) => page.text);
}

/**
 * Entfernt Stoppwörter aus einem Text und bereinigt daraus entstandene Lücken.
 *
 * @param text - Der zu bereinigende Text.
 * @returns Text ohne Stoppwörter.
 */
function removeStopWords(text: string) {
  return text
    .replace(/[\p{L}\p{N}]+(?:[-''][\p{L}\p{N}]+)*/gu, (term) =>
      STOP_WORDS.has(normalizeTerm(term)) ? "" : term,
    )
    .split("\n")
    .map(cleanStopWordLine)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Bereinigt eine Zeile nach der Stoppwort-Entfernung (z. B. Leerzeichen vor Satzzeichen).
 *
 * @param line - Die zu bereinigende Zeile.
 * @returns Bereinigte Zeile.
 */
function cleanStopWordLine(line: string) {
  return line
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/^[,.;:!?]+(?:\s+|$)/g, "")
    .replace(/([([{][ \t]*[)\]}])/g, "")
    .replace(/-{2,}/g, "-")
    .trim();
}

/**
 * Erzeugt aus Seiten-Chunks eine flache Liste von Text-Einheiten (Paragraphen/Sätze).
 * Zu große Einheiten werden weiter in Sätze aufgeteilt.
 *
 * @param pages - Seiten-Chunks ohne Stoppwörter.
 * @param targetTokens - Maximale Token-Anzahl pro Einheit.
 * @returns Flache Liste von Text-Einheiten.
 */
function createTextUnits(pages: PageTextChunk[], targetTokens: number) {
  return pages.flatMap((page) => {
    const paragraphs = page.text.split(/\n{2,}/).filter(Boolean);
    return paragraphs.flatMap((paragraph) =>
      splitOversizedUnit(paragraph, page.page, targetTokens),
    );
  });
}

/**
 * Teilt eine zu große Text-Einheit an Satzgrenzen in kleinere Einheiten auf.
 *
 * @param text - Der aufzuteilende Text.
 * @param page - Die Seitennummer der Einheit.
 * @param targetTokens - Maximale Token-Anzahl pro Einheit.
 * @returns Liste von Text-Einheiten, die das Token-Limit einhalten.
 */
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

/**
 * Erstellt einen TextChunk aus einer Liste von Text-Einheiten.
 *
 * @param index - Index des Chunks in der Gesamtliste (für die ID-Vergabe).
 * @param units - Text-Einheiten, die zu einem Chunk zusammengeführt werden.
 * @returns Fertiger TextChunk mit Metadaten.
 */
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

/**
 * Wählt die letzten Text-Einheiten eines Chunks als Überlappung für den nächsten Chunk aus.
 *
 * @param units - Aktuelle Text-Einheiten des vorigen Chunks.
 * @param overlapTokens - Gewünschte Token-Anzahl für die Überlappung.
 * @returns Letzte Einheiten, die zusammen mindestens `overlapTokens` Token umfassen.
 */
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

/**
 * Summiert die Token-Anzahl einer Liste von Text-Einheiten.
 *
 * @param units - Liste von Text-Einheiten.
 * @returns Gesamtanzahl der Tokens.
 */
function sumTokens(units: TextUnit[]) {
  return units.reduce((sum, unit) => sum + unit.tokens, 0);
}

/**
 * Extrahiert normalisierte, eindeutige Suchbegriffe aus einer Suchanfrage.
 * Filtert Stoppwörter und Begriffe mit weniger als 3 Zeichen heraus.
 *
 * @param query - Die Nutzersuchanfrage.
 * @returns Liste eindeutiger, normalisierter Suchbegriffe.
 */
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

/**
 * Berechnet einen Relevanz-Score für einen Chunk anhand der Suchbegriffe.
 * Berücksichtigt Häufigkeit der Begriffe und normalisiert nach Chunk-Länge.
 *
 * @param chunk - Der zu bewertende Text-Chunk.
 * @param queryTerms - Normalisierte Suchbegriffe aus der Suchanfrage.
 * @param index - Position des Chunks in der Gesamtliste (für Positions-Bonus).
 * @returns Relevanz-Score des Chunks.
 */
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

/**
 * Normalisiert einen Begriff: Kleinschreibung, NFKD-Normalisierung,
 * Diakritika-Entfernung und ß → ss.
 *
 * @param term - Der zu normalisierende Begriff.
 * @returns Normalisierter Begriff.
 */
function normalizeTerm(term: string) {
  return term
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss");
}

/**
 * Prüft, ob ein Begriff als Stoppwort-Kandidat geeignet ist.
 * Muss ausschließlich aus Buchstaben bestehen und mehr als 1 Zeichen haben
 * (Ausnahmen: "a" und "i").
 *
 * @param term - Der zu prüfende Begriff.
 * @returns True, wenn der Begriff ein Stoppwort-Kandidat ist.
 */
function isStopWordCandidate(term: string) {
  return (
    /^[\p{L}]+$/u.test(term) &&
    (term.length > 1 || term === "a" || term === "i")
  );
}
