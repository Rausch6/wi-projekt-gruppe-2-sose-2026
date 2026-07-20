import {
  AIProviderConfigurationError,
  AIProviderResponseError,
} from "./AIProvider.js";
import {
  assertHttpOk,
  HttpResponseError,
  httpClient,
} from "../utils/httpClient.js";
import { ollamaLifecycleManager } from "./OllamaLifecycleManager";

export const EMBEDDING_PROVIDER_ID = "local-embeddings";
export const EMBEDDING_DEFAULT_BASE_URL = "http://localhost:11434";
export const REQUIRED_EMBEDDING_MODEL = "bge-m3:latest";
export const EMBEDDING_DEFAULT_MODEL = REQUIRED_EMBEDDING_MODEL;
export const EMBEDDING_DEFAULT_TIMEOUT = 120_000;

/**
 * Unified interface for local embedding services.
 *
 * The provider encapsulates the different HTTP formats used by Ollama,
 * OpenAI-compatible servers, and native `/embed` endpoints. Regardless of the
 * service used, callers always receive numeric vectors in input order.
 */
export class EmbeddingProvider {
  constructor(options = {}) {
    this.id = EMBEDDING_PROVIDER_ID;
    this.name = "Local Embeddings";
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? EMBEDDING_DEFAULT_BASE_URL,
    );
    this.model = requireText(
      options.model ?? EMBEDDING_DEFAULT_MODEL,
      "Embedding model",
    );
    this.timeout = options.timeout ?? EMBEDDING_DEFAULT_TIMEOUT;
  }

  configure(options = {}) {
    if (options.baseUrl !== undefined) {
      this.baseUrl = normalizeBaseUrl(options.baseUrl);
    }
    if (options.model !== undefined) {
      this.model = requireText(options.model, "Embedding model");
    }
    if (options.timeout !== undefined) {
      this.timeout = options.timeout;
    }

    return this.getConfig();
  }

  getConfig() {
    return {
      id: this.id,
      name: this.name,
      baseUrl: this.baseUrl,
      model: this.model,
      timeout: this.timeout,
    };
  }

  async isAvailable() {
    try {
      await this.embedTexts(["ping"], { inputType: "query", timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Converts one or more texts into embedding vectors.
   * `inputType` distinguishes queries from document passages because some
   * model families expect different prefixes for them.
   */
  async embedTexts(texts, options = {}) {
    const baseUrl = options.baseUrl ?? this.baseUrl;
    const model = options.model ?? this.model;
    const timeout = options.timeout ?? this.timeout;
    const inputTexts = normalizeTexts(texts).map((text) =>
      applyEmbeddingPrefix(text, options.inputType, model),
    );

    // Local default models use Ollama's batch endpoint directly; other servers
    // are initially addressed through the OpenAI-compatible protocol.
    if (shouldUseOllamaEndpoint(baseUrl, model)) {
      try {
        return await requestOllamaEmbeddings(baseUrl, inputTexts, {
          model,
          timeout,
          signal: options.signal,
        });
      } catch (cause) {
        throw normalizeEmbeddingError(cause, this.id);
      }
    }

    try {
      return await requestOpenAIEmbeddings(baseUrl, inputTexts, {
        model,
        timeout,
        signal: options.signal,
      });
    } catch (cause) {
      // Some local servers expose `/embed` instead of `/embeddings`. Only
      // protocol-related client errors trigger this fallback; network and
      // server errors are passed to the caller unchanged.
      if (shouldTryNativeEmbed(cause)) {
        try {
          return await requestNativeEmbeddings(baseUrl, inputTexts, {
            timeout,
            signal: options.signal,
          });
        } catch (fallbackCause) {
          throw normalizeEmbeddingError(fallbackCause, this.id);
        }
      }
      throw normalizeEmbeddingError(cause, this.id);
    }
  }
}

async function requestOpenAIEmbeddings(baseUrl, inputTexts, options) {
  const url = createEmbeddingsUrl(baseUrl);
  const response = await httpClient.post(
    url,
    {
      model: options.model,
      input: inputTexts,
      encoding_format: "float",
    },
    {
      timeout: options.timeout,
      mode: "local",
      signal: options.signal,
    },
  );
  await assertHttpOk(url, response);

  const payload = await response.json();
  return parseEmbeddings(payload, inputTexts.length);
}

async function requestNativeEmbeddings(baseUrl, inputTexts, options) {
  const url = createNativeEmbedUrl(baseUrl);
  const response = await httpClient.post(
    url,
    { inputs: inputTexts },
    {
      timeout: options.timeout,
      mode: "local",
      signal: options.signal,
    },
  );
  await assertHttpOk(url, response);

  const payload = await response.json();
  return parseEmbeddings(payload, inputTexts.length);
}

async function requestOllamaEmbeddings(baseUrl, inputTexts, options) {
  await ollamaLifecycleManager.ensureReady(baseUrl);
  const url = createOllamaEmbedUrl(baseUrl);
  const response = await httpClient.post(
    url,
    {
      model: options.model,
      input: inputTexts,
    },
    {
      timeout: options.timeout,
      mode: "local",
      signal: options.signal,
    },
  );
  await assertHttpOk(url, response);

  const payload = await response.json();
  return parseEmbeddings(payload, inputTexts.length);
}

function shouldTryNativeEmbed(cause) {
  return (
    cause instanceof HttpResponseError &&
    [400, 404, 405, 422].includes(cause.status)
  );
}

function normalizeEmbeddingError(cause, providerId) {
  if (cause instanceof AIProviderResponseError) return cause;
  if (cause instanceof HttpResponseError) {
    return new AIProviderResponseError(providerId, cause.message, {
      status: cause.status,
      details: cause.details,
      cause,
    });
  }
  return cause;
}

function normalizeTexts(texts) {
  const normalized = Array.isArray(texts) ? texts : [texts];
  if (!normalized.length) {
    throw new AIProviderConfigurationError(
      EMBEDDING_PROVIDER_ID,
      "At least one text is required for embeddings",
    );
  }

  return normalized.map((text, index) =>
    requireText(text, `Embedding input ${index}`),
  );
}

function applyEmbeddingPrefix(text, inputType, model) {
  // E5 models were trained with explicit role prefixes. Already prefixed text
  // remains unchanged to prevent duplicate prefixes.
  if (!usesE5PromptFormat(model)) return text;
  if (/^(query|passage):\s/i.test(text)) return text;
  if (inputType === "passage") return `passage: ${text}`;
  return `query: ${text}`;
}

function usesE5PromptFormat(model) {
  return /(^|[/_-])e5([_-]|$)/i.test(model);
}

function parseEmbeddings(payload, expectedCount) {
  // Supported servers wrap the same vectors in different response structures.
  // Subsequent validation ensures the correct count and numeric format.
  const vectors =
    parseOpenAIEmbeddings(payload) ??
    parseEmbeddingProperty(payload, expectedCount) ??
    parseEmbeddingArray(payload, expectedCount);

  if (!vectors || vectors.length !== expectedCount) {
    throw new AIProviderResponseError(
      EMBEDDING_PROVIDER_ID,
      "Embedding service returned an invalid embedding response",
      { details: payload },
    );
  }

  return vectors.map((vector, index) =>
    normalizeVector(vector, `Embedding ${index}`),
  );
}

function parseOpenAIEmbeddings(payload) {
  if (!Array.isArray(payload?.data)) return null;

  // OpenAI-compatible responses may contain entries in any order. The index
  // field restores the original input order.
  return payload.data
    .slice()
    .sort((a, b) => {
      const aIndex = typeof a?.index === "number" ? a.index : 0;
      const bIndex = typeof b?.index === "number" ? b.index : 0;
      return aIndex - bIndex;
    })
    .map((entry) => entry?.embedding);
}

function parseEmbeddingProperty(payload, expectedCount) {
  if (Array.isArray(payload?.embeddings)) {
    return parseEmbeddingArray(payload.embeddings, expectedCount);
  }
  if (Array.isArray(payload?.embedding)) {
    return expectedCount === 1 ? [payload.embedding] : null;
  }
  return null;
}

function parseEmbeddingArray(payload, expectedCount) {
  if (!Array.isArray(payload)) return null;
  if (isNumberArray(payload)) {
    return expectedCount === 1 ? [payload] : null;
  }
  if (payload.every(isNumberArray)) return payload;
  return null;
}

function normalizeVector(vector, label) {
  if (!isNumberArray(vector)) {
    throw new AIProviderResponseError(
      EMBEDDING_PROVIDER_ID,
      `${label} is not a numeric vector`,
      { details: vector },
    );
  }

  return vector.map((value) => Number(value));
}

function isNumberArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function createEmbeddingsUrl(baseUrl) {
  return baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;
}

function createNativeEmbedUrl(baseUrl) {
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, "");

  if (pathname.endsWith("/v1/embeddings")) {
    pathname = pathname.slice(0, -"/v1/embeddings".length);
  } else if (pathname.endsWith("/embeddings")) {
    pathname = pathname.slice(0, -"/embeddings".length);
  } else if (pathname.endsWith("/v1")) {
    pathname = pathname.slice(0, -"/v1".length);
  }

  url.pathname = `${pathname}/embed`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function createOllamaEmbedUrl(baseUrl) {
  if (baseUrl.endsWith("/api/embed")) return baseUrl;
  if (baseUrl.endsWith("/api")) return `${baseUrl}/embed`;
  return `${baseUrl}/api/embed`;
}

function shouldUseOllamaEndpoint(baseUrl, model) {
  // Port 11434 is Ollama's default. Known model names also detect Ollama when
  // it is exposed through a different local URL.
  return (
    /(^|\/)(?:bge-m3|nomic-embed-text|embeddinggemma)(?::|$)/i.test(model) ||
    /:11434(?:\/|$)/.test(baseUrl)
  );
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeBaseUrl(baseUrl) {
  return requireText(baseUrl, "Embedding base URL").replace(/\/+$/, "");
}

export const embeddingProvider = new EmbeddingProvider();

export default EmbeddingProvider;
