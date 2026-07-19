import {
  embeddingProvider,
  type EmbeddingProvider,
} from "../ai/EmbeddingProvider.js";
import {
  selectRelevantChunks,
  type SelectChunkOptions,
  type TextChunk,
} from "./TextChunker";

/**
 * Suchmodus der semantischen Suche.
 */
export type EmbeddingSearchMode = "embedding" | "keyword" | "disabled";

/**
 * Konfiguration für den EmbeddingSearchService.
 */
export interface EmbeddingSearchConfig {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

/**
 * Optionen für die Chunk-Auswahl bei der Embedding-Suche.
 */
export interface EmbeddingSearchOptions extends SelectChunkOptions {
  cacheKey?: string;
}

/**
 * Statusinformation der letzten Embedding-Suche.
 */
export interface EmbeddingSearchStatus {
  mode: EmbeddingSearchMode;
  message: string;
  error?: string;
}

/**
 * Erweiterte Optionen für einen Embedding-Debug-Bericht.
 */
export interface EmbeddingDebugOptions extends EmbeddingSearchOptions {
  query?: string;
}

/**
 * Debug-Datensatz für einen einzelnen Chunk inklusive Embedding und Ranking.
 */
export interface ChunkEmbeddingDebugRecord {
  chunk: TextChunk;
  input: string;
  embedding: number[];
  normalizedEmbedding: number[];
  rank?: number;
  score?: number;
  selected?: boolean;
}

/**
 * Ergebnis eines Embedding-Debug-Berichts mit Provider-Infos und Chunk-Datensätzen.
 */
export interface ChunkEmbeddingDebugResult {
  provider: ReturnType<EmbeddingProvider["getConfig"]>;
  query?: {
    text: string;
    embedding: number[];
    normalizedEmbedding: number[];
  };
  records: ChunkEmbeddingDebugRecord[];
}

type CachedChunkEmbeddings = {
  chunkSignature: string;
  embeddings: number[][];
};

const chunkEmbeddingCache = new Map<string, CachedChunkEmbeddings>();

let enabled = true;
let providerSignature = "";
let lastStatus: EmbeddingSearchStatus = {
  mode: "keyword",
  message: "Semantische Suche wurde noch nicht ausgeführt.",
};

/**
 * Koordiniert die semantische Suche über Embeddings.
 * Fällt bei deaktiviertem oder fehlerhaftem Embedding-Provider
 * auf Keyword-basierte Suche zurück.
 */
export class EmbeddingSearchService {
  /**
   * Konfiguriert den Embedding-Provider und leert den Cache bei Konfigurationsänderungen.
   *
   * @param config - Neue Konfiguration für Provider und Aktivierungsstatus.
   * @returns Aktuelle Provider-Konfiguration inklusive Cache-Größe.
   */
  static configure(config: EmbeddingSearchConfig = {}) {
    enabled = config.enabled !== false;

    const before = createProviderSignature(embeddingProvider);
    const providerConfig = embeddingProvider.configure({
      baseUrl: config.baseUrl,
      model: config.model,
      timeout: config.timeout,
    });
    const after = createProviderSignature(embeddingProvider);

    if (before !== after || providerSignature !== after) {
      chunkEmbeddingCache.clear();
      providerSignature = after;
    }

    if (!enabled) {
      lastStatus = {
        mode: "disabled",
        message: "Semantische Suche ist deaktiviert.",
      };
    }

    return {
      ...providerConfig,
      enabled,
      cachedDocuments: chunkEmbeddingCache.size,
    };
  }

  /**
   * Leert den internen Embedding-Cache.
   */
  static clearCache() {
    chunkEmbeddingCache.clear();
  }

  /**
   * Gibt den Status der letzten Embedding-Suchanfrage zurück.
   *
   * @returns Kopie des letzten Suchstatus.
   */
  static getLastStatus() {
    return { ...lastStatus };
  }

  /**
   * Gibt an, ob die Embedding-Suche aktuell aktiviert ist.
   *
   * @returns True, wenn Embedding-Suche aktiv ist.
   */
  static isEnabled() {
    return enabled;
  }

  /**
   * Wählt die relevantesten Chunks für eine Suchanfrage aus.
   * Nutzt Embeddings, wenn aktiviert, sonst Keyword-basierte Auswahl.
   *
   * @param chunks - Alle verfügbaren Text-Chunks.
   * @param query - Die Nutzersuchanfrage.
   * @param options - Optionale Einschränkungen für Anzahl und Token-Limit.
   * @returns Relevanteste Chunks in Dokumentreihenfolge.
   */
  static async selectRelevantChunks(
    chunks: TextChunk[],
    query: string,
    options: EmbeddingSearchOptions = {},
  ) {
    if (!enabled) {
      lastStatus = {
        mode: "disabled",
        message: "Semantische Suche ist deaktiviert.",
      };
      return selectRelevantChunks(chunks, query, options);
    }

    if (!chunks.length || !query.trim()) {
      lastStatus = {
        mode: "keyword",
        message: "Keine Anfrage oder Chunks für die Embedding-Suche vorhanden.",
      };
      return selectRelevantChunks(chunks, query, options);
    }

    try {
      const [queryEmbedding] = await embeddingProvider.embedTexts([query], {
        inputType: "query",
      });
      const chunkEmbeddings = await getChunkEmbeddings(chunks, options);
      const selected = selectByEmbeddingSimilarity(
        chunks,
        normalize(queryEmbedding),
        chunkEmbeddings,
        options,
      );

      lastStatus = {
        mode: "embedding",
        message: `Embedding-Suche hat ${selected.length} von ${chunks.length} Chunks ausgewählt.`,
      };
      return selected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastStatus = {
        mode: "keyword",
        message: "Embedding-Suche fehlgeschlagen; Keyword-Fallback aktiv.",
        error: message,
      };
      Zotero.logError(error instanceof Error ? error : new Error(message));
      return selectRelevantChunks(chunks, query, options);
    }
  }

  /**
   * Erstellt einen detaillierten Debug-Bericht über Embeddings und Ranking aller Chunks.
   *
   * @param chunks - Alle Text-Chunks des Papers.
   * @param options - Optionale Suchanfrage und Chunk-Auswahl-Parameter.
   * @returns Debug-Bericht mit Embeddings, Scores und Auswahlstatus pro Chunk.
   */
  static async createEmbeddingDebugReport(
    chunks: TextChunk[],
    options: EmbeddingDebugOptions = {},
  ): Promise<ChunkEmbeddingDebugResult> {
    if (!enabled) {
      throw new Error("Semantische Suche ist deaktiviert.");
    }
    if (!chunks.length) {
      return {
        provider: embeddingProvider.getConfig(),
        records: [],
      };
    }

    const inputs = chunks.map((chunk) =>
      createPassageEmbeddingText(chunk.text),
    );
    const embeddings = await embeddingProvider.embedTexts(inputs, {
      inputType: "passage",
    });
    const normalizedEmbeddings = embeddings.map(normalize);
    cacheChunkEmbeddings(chunks, normalizedEmbeddings, options);

    const records: ChunkEmbeddingDebugRecord[] = chunks.map((chunk, index) => ({
      chunk,
      input: inputs[index],
      embedding: embeddings[index],
      normalizedEmbedding: normalizedEmbeddings[index],
    }));
    const query = options.query?.trim();

    if (!query) {
      return {
        provider: embeddingProvider.getConfig(),
        records,
      };
    }

    const [queryEmbedding] = await embeddingProvider.embedTexts([query], {
      inputType: "query",
    });
    const normalizedQueryEmbedding = normalize(queryEmbedding);
    const ranked = rankByEmbeddingSimilarity(
      chunks,
      normalizedQueryEmbedding,
      normalizedEmbeddings,
    );
    const selectedChunkIDs = new Set(
      selectByEmbeddingSimilarity(
        chunks,
        normalizedQueryEmbedding,
        normalizedEmbeddings,
        options,
      ).map((chunk) => chunk.id),
    );

    for (const [rankIndex, entry] of ranked.entries()) {
      const record = records[entry.index];
      record.rank = rankIndex + 1;
      record.score = entry.score;
      record.selected = selectedChunkIDs.has(record.chunk.id);
    }

    return {
      provider: embeddingProvider.getConfig(),
      query: {
        text: query,
        embedding: queryEmbedding,
        normalizedEmbedding: normalizedQueryEmbedding,
      },
      records,
    };
  }
}

/**
 * Lädt oder berechnet die Embeddings für eine Liste von Chunks.
 * Nutzt einen In-Memory-Cache zur Wiederverwendung.
 *
 * @param chunks - Die zu embeddenden Text-Chunks.
 * @param options - Cache-Schlüssel und Auswahl-Parameter.
 * @returns Normalisierte Embedding-Vektoren in Chunk-Reihenfolge.
 */
async function getChunkEmbeddings(
  chunks: TextChunk[],
  options: EmbeddingSearchOptions,
) {
  const cacheKey = options.cacheKey ?? createChunkSignature(chunks);
  const chunkSignature = createChunkSignature(chunks);
  const cached = chunkEmbeddingCache.get(cacheKey);

  if (cached?.chunkSignature === chunkSignature) {
    return cached.embeddings;
  }

  const embeddings = (
    await embeddingProvider.embedTexts(
      chunks.map((chunk) => createPassageEmbeddingText(chunk.text)),
      { inputType: "passage" },
    )
  ).map(normalize);

  cacheChunkEmbeddings(chunks, embeddings, options);

  return embeddings;
}

/**
 * Speichert berechnete Chunk-Embeddings im In-Memory-Cache.
 *
 * @param chunks - Die gecachten Text-Chunks.
 * @param embeddings - Zugehörige normalisierte Embedding-Vektoren.
 * @param options - Cache-Schlüssel für die Zuordnung.
 */
function cacheChunkEmbeddings(
  chunks: TextChunk[],
  embeddings: number[][],
  options: EmbeddingSearchOptions,
) {
  const cacheKey = options.cacheKey ?? createChunkSignature(chunks);
  const chunkSignature = createChunkSignature(chunks);

  chunkEmbeddingCache.set(cacheKey, {
    chunkSignature,
    embeddings,
  });
}

/**
 * Wählt Chunks anhand von Cosinus-Ähnlichkeit zum Query-Embedding aus.
 * Begrenzt die Auswahl auf `maxChunks` und `maxTokens`.
 *
 * @param chunks - Alle verfügbaren Chunks.
 * @param queryEmbedding - Normalisierter Query-Vektor.
 * @param chunkEmbeddings - Normalisierte Chunk-Vektoren in gleicher Reihenfolge.
 * @param options - Grenzen für Chunk-Anzahl und Token-Gesamtzahl.
 * @returns Ausgewählte Chunks in Dokumentreihenfolge.
 */
function selectByEmbeddingSimilarity(
  chunks: TextChunk[],
  queryEmbedding: number[],
  chunkEmbeddings: number[][],
  options: SelectChunkOptions,
) {
  const maxChunks = options.maxChunks ?? 6;
  const maxTokens = options.maxTokens ?? 4_500;
  const ranked = rankByEmbeddingSimilarity(
    chunks,
    queryEmbedding,
    chunkEmbeddings,
  );

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
 * Sortiert Chunks absteigend nach Cosinus-Ähnlichkeit zum Query-Embedding.
 *
 * @param chunks - Alle verfügbaren Chunks.
 * @param queryEmbedding - Normalisierter Query-Vektor.
 * @param chunkEmbeddings - Normalisierte Chunk-Vektoren in gleicher Reihenfolge.
 * @returns Sortierte Liste mit Chunk, Originalindex und Score.
 */
function rankByEmbeddingSimilarity(
  chunks: TextChunk[],
  queryEmbedding: number[],
  chunkEmbeddings: number[][],
) {
  return chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: cosineSimilarity(queryEmbedding, chunkEmbeddings[index]),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * Normalisiert einen Vektor auf die Einheitslänge (L2-Normalisierung).
 *
 * @param vector - Der zu normalisierende Vektor.
 * @returns Normalisierter Vektor (Kopie des Originals bei Nullvektor).
 */
function normalize(vector: number[]) {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value ** 2, 0),
  );
  if (!magnitude) return vector.slice();
  return vector.map((value) => value / magnitude);
}

/**
 * Berechnet die Cosinus-Ähnlichkeit zweier Vektoren.
 *
 * @param a - Erster Vektor.
 * @param b - Zweiter Vektor (oder undefined bei fehlenden Embeddings).
 * @returns Cosinus-Ähnlichkeit oder -Infinity bei inkompatiblen Vektoren.
 */
function cosineSimilarity(a: number[], b: number[] | undefined) {
  if (!b || a.length !== b.length) return Number.NEGATIVE_INFINITY;
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

/**
 * Kürzt den Text eines Chunks auf maximal 360 Wörter für die Passage-Einbettung.
 *
 * @param text - Der einzubettende Chunk-Text.
 * @returns Gekürzter Text für das Embedding.
 */
function createPassageEmbeddingText(text: string) {
  return trimToApproximateWords(text, 360);
}

/**
 * Kürzt einen Text auf eine maximale Wortanzahl.
 *
 * @param text - Der zu kürzende Text.
 * @param maxWords - Maximale Wortanzahl.
 * @returns Gekürzter Text.
 */
function trimToApproximateWords(text: string, maxWords: number) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ");
}

/**
 * Erstellt eine Signatur für eine Liste von Chunks zur Cache-Validierung.
 *
 * @param chunks - Die zu signierenden Chunks.
 * @returns Kompakter Signatur-String.
 */
function createChunkSignature(chunks: TextChunk[]) {
  return chunks
    .map(
      (chunk) =>
        `${chunk.id}:${chunk.pageStart ?? ""}:${chunk.pageEnd ?? ""}:${chunk.text.length}`,
    )
    .join("|");
}

/**
 * Erstellt eine Signatur für die aktuelle Provider-Konfiguration zur Cache-Invalidierung.
 *
 * @param provider - Der Embedding-Provider.
 * @returns Signatur-String aus URL, Modell und Timeout.
 */
function createProviderSignature(provider: EmbeddingProvider) {
  const config = provider.getConfig();
  return `${config.baseUrl}|${config.model}|${config.timeout}`;
}
