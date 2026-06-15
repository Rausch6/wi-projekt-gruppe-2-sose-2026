import { AIProvider, AIProviderResponseError } from "../AIProvider.js";
import {
  assertHttpOk,
  HttpResponseError,
  httpClient,
} from "../../utils/httpClient.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "qwen2.5:3b";

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
      stream: false,
    };

    try {
      const response = await httpClient.post(url, body, {
        timeout: options.timeout ?? 600_000,
        mode: "local",
      });
      await assertHttpOk(url, response);

      const payload = await response.json();
      if (payload?.status && payload.status !== "success") {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model pull failed",
          { details: payload },
        );
      }

      return payload;
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
