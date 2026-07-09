import { AIProvider, AIProviderResponseError } from "../AIProvider.js";
import {
  assertHttpOk,
  HttpNetworkError,
  HttpParseError,
  HttpResponseError,
  HttpTimeoutError,
  httpClient,
} from "../../utils/httpClient.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "qwen2.5:3b";
export const OLLAMA_INSTALL_COMMANDS = {
  windows: "winget install -e --id Ollama.Ollama",
  unix: "curl -fsSL https://ollama.com/install.sh | sh",
};

export class OllamaProvider extends AIProvider {
  constructor(options = {}) {
    super({
      id: "ollama",
      name: "Ollama",
      baseUrl: options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
      model: options.model ?? OLLAMA_DEFAULT_MODEL,
      apiKey: "",
    });
    this.timeout = options.timeout ?? 120_000;
  }

  async isAvailable() {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  async listModels() {
    const url = `${this.baseUrl}/api/tags`;
    const response = await httpClient.get(url, {
      timeout: Math.min(this.timeout, 30_000),
      mode: "local",
    });
    await assertHttpOk(url, response);

    const payload = await response.json();
    if (!Array.isArray(payload?.models)) {
      throw new AIProviderResponseError(
        this.id,
        "Ollama returned an invalid model list",
        { details: payload },
      );
    }

    return payload.models
      .map((model) => model?.name ?? model?.model)
      .filter((model) => typeof model === "string" && model.trim())
      .map((model) => ({
        id: model,
        name: model,
        ownedBy: "ollama",
      }));
  }

  async pullModel(model = this.model, options = {}) {
    const url = `${this.baseUrl}/api/pull`;
    const body = {
      model,
      stream: true,
    };

    try {
      const response = await httpClient.streamPost(url, body, {
        timeout: options.inactivityTimeout ?? options.timeout ?? 120_000,
        signal: options.signal,
        mode: "local",
      });
      await assertHttpOk(url, response);

      if (typeof response.streamText !== "function") {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model pull streaming is not available",
        );
      }

      let finalPayload = null;
      for await (const payload of parseOllamaJsonLineStream(
        response.streamText(),
        this.id,
      )) {
        if (options.signal?.aborted) throw createAbortError();

        finalPayload = payload;
        if (payload?.error) {
          throw new AIProviderResponseError(this.id, String(payload.error), {
            details: payload,
          });
        }
        options.onProgress?.(normalizePullProgress(payload));
      }

      if (options.signal?.aborted) throw createAbortError();

      if (!finalPayload) {
        throw new AIProviderResponseError(
          this.id,
          "Ollama returned no pull progress",
        );
      }

      if (finalPayload.status && finalPayload.status !== "success") {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model pull did not finish successfully",
          { details: finalPayload },
        );
      }

      return finalPayload;
    } catch (cause) {
      if (cause instanceof AIProviderResponseError) throw cause;
      if (cause?.name === "AbortError") throw cause;
      if (cause instanceof HttpResponseError) {
        throw new AIProviderResponseError(this.id, cause.message, {
          status: cause.status,
          details: cause.details,
          cause,
        });
      }
      if (cause instanceof HttpTimeoutError) {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model pull timed out because no progress was received.",
          {
            details: { issue: "timeout", timeoutMs: cause.timeoutMs },
            cause,
          },
        );
      }
      if (cause instanceof HttpNetworkError) {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model pull was interrupted.",
          {
            details: { issue: "network" },
            cause,
          },
        );
      }
      throw cause;
    }
  }

  async deleteModel(model = this.model, options = {}) {
    const url = `${this.baseUrl}/api/delete`;

    try {
      const response = await httpClient.request("DELETE", url, {
        body: { model },
        mode: "local",
        signal: options.signal,
        timeout: options.timeout ?? 30_000,
      });
      await assertHttpOk(url, response);
      return { model };
    } catch (cause) {
      if (cause instanceof AIProviderResponseError) throw cause;
      if (cause?.name === "AbortError") throw cause;
      if (cause instanceof HttpResponseError) {
        throw new AIProviderResponseError(this.id, cause.message, {
          status: cause.status,
          details: cause.details,
          cause,
        });
      }
      if (cause instanceof HttpTimeoutError) {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model delete timed out.",
          {
            details: { issue: "timeout", timeoutMs: cause.timeoutMs },
            cause,
          },
        );
      }
      if (cause instanceof HttpNetworkError) {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model delete was interrupted.",
          {
            details: { issue: "network" },
            cause,
          },
        );
      }
      throw cause;
    }
  }

  async chat(messages, options = {}) {
    const url = `${this.baseUrl}/api/chat`;
    const model = options.model ?? this.model;
    const body = this.createChatBody(messages, options);

    try {
      const response = await httpClient.post(url, body, {
        timeout: options.timeout ?? this.timeout,
        mode: "local",
      });
      await assertHttpOk(url, response);

      const payload = await response.json();
      const content = payload?.message?.content;

      if (typeof content !== "string") {
        throw new AIProviderResponseError(
          this.id,
          "Ollama returned no assistant message",
          { details: payload },
        );
      }

      return {
        provider: this.id,
        model: payload.model ?? model,
        content,
        finishReason: payload.done_reason ?? null,
        usage: normalizeUsage(payload),
        raw: payload,
      };
    } catch (cause) {
      if (cause instanceof AIProviderResponseError) throw cause;
      if (cause instanceof HttpResponseError) {
        throw new AIProviderResponseError(this.id, cause.message, {
          status: cause.status,
          details: cause.details,
          cause,
        });
      }
      throw cause;
    }
  }

  createChatBody(messages, options) {
    return removeUndefined({
      model: options.model ?? this.model,
      messages: this.normalizeMessages(messages),
      stream: false,
      options: removeUndefined({
        temperature: options.temperature,
        top_p: options.topP,
        num_predict: options.maxTokens,
        stop: options.stop,
      }),
    });
  }
}

function removeUndefined(object) {
  const cleaned = Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
  return Object.keys(cleaned).length ? cleaned : undefined;
}

async function* parseOllamaJsonLineStream(chunks, providerId) {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const payload = parseOllamaJsonLine(line, providerId);
      if (payload) yield payload;
    }
  }

  const payload = parseOllamaJsonLine(buffer, providerId);
  if (payload) yield payload;
}

function parseOllamaJsonLine(line, providerId) {
  const text = line.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AIProviderResponseError(
      providerId,
      "Ollama returned invalid pull progress",
      {
        details: { line: text.slice(0, 300) },
        cause: new HttpParseError(200, text, cause),
      },
    );
  }
}

function normalizePullProgress(payload) {
  const completed =
    typeof payload?.completed === "number" ? payload.completed : null;
  const total = typeof payload?.total === "number" ? payload.total : null;
  const percent =
    total && total > 0 && completed !== null
      ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
      : null;

  return {
    status: typeof payload?.status === "string" ? payload.status : "",
    digest: typeof payload?.digest === "string" ? payload.digest : "",
    completed,
    total,
    percent,
    done: payload?.status === "success",
    raw: payload,
  };
}

function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Aborted", "AbortError");
  }

  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function normalizeUsage(payload) {
  return {
    promptTokens: payload.prompt_eval_count ?? null,
    completionTokens: payload.eval_count ?? null,
    totalTokens:
      typeof payload.prompt_eval_count === "number" &&
      typeof payload.eval_count === "number"
        ? payload.prompt_eval_count + payload.eval_count
        : null,
  };
}

export default OllamaProvider;
