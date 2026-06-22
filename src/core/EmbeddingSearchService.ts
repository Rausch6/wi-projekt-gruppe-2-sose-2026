import {
  embeddingProvider,
  type EmbeddingProvider,
} from "../ai/EmbeddingProvider.js";
import {
  selectRelevantChunks,
  type SelectChunkOptions,
  type TextChunk,
} from "./TextChunker";

export type EmbeddingSearchMode = "embedding" | "keyword" | "disabled";

export interface EmbeddingSearchConfig {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

export interface EmbeddingSearchOptions extends SelectChunkOptions {
  cacheKey?: string;
}

export interface EmbeddingSearchStatus {
  mode: EmbeddingSearchMode;
  message: string;
  error?: string;
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
  message: "Embedding search has not run yet.",
};

export class EmbeddingSearchService {
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
        message: "Embedding search is disabled.",
      };
    }

    return {
      ...providerConfig,
      enabled,
      cachedDocuments: chunkEmbeddingCache.size,
    };
  }

  static clearCache() {
    chunkEmbeddingCache.clear();
  }

  static getLastStatus() {
    return { ...lastStatus };
  }

  static async selectRelevantChunks(
    chunks: TextChunk[],
    query: string,
    options: EmbeddingSearchOptions = {},
  ) {
    if (!enabled) {
      lastStatus = {
        mode: "disabled",
        message: "Embedding search is disabled.",
      };
      return selectRelevantChunks(chunks, query, options);
    }

    if (!chunks.length || !query.trim()) {
      lastStatus = {
        mode: "keyword",
        message: "No query or chunks available for embedding search.",
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
        message: `Embedding search selected ${selected.length} of ${chunks.length} chunks.`,
      };
      return selected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastStatus = {
        mode: "keyword",
        message: "Embedding search failed; using keyword fallback.",
        error: message,
      };
      Zotero.logError(error instanceof Error ? error : new Error(message));
      return selectRelevantChunks(chunks, query, options);
    }
  }
}

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

  chunkEmbeddingCache.set(cacheKey, {
    chunkSignature,
    embeddings,
  });

  return embeddings;
}

function selectByEmbeddingSimilarity(
  chunks: TextChunk[],
  queryEmbedding: number[],
  chunkEmbeddings: number[][],
  options: SelectChunkOptions,
) {
  const maxChunks = options.maxChunks ?? 6;
  const maxTokens = options.maxTokens ?? 4_500;
  const ranked = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: cosineSimilarity(queryEmbedding, chunkEmbeddings[index]),
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

function normalize(vector: number[]) {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value ** 2, 0),
  );
  if (!magnitude) return vector.slice();
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(a: number[], b: number[] | undefined) {
  if (!b || a.length !== b.length) return Number.NEGATIVE_INFINITY;
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function createPassageEmbeddingText(text: string) {
  return trimToApproximateWords(text, 360);
}

function trimToApproximateWords(text: string, maxWords: number) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ");
}

function createChunkSignature(chunks: TextChunk[]) {
  return chunks
    .map(
      (chunk) =>
        `${chunk.id}:${chunk.pageStart ?? ""}:${chunk.pageEnd ?? ""}:${chunk.text.length}`,
    )
    .join("|");
}

function createProviderSignature(provider: EmbeddingProvider) {
  const config = provider.getConfig();
  return `${config.baseUrl}|${config.model}|${config.timeout}`;
}
