import { AIProvider, AIProviderResponseError } from "../AIProvider.js";
import {
  assertHttpOk,
  HttpResponseError,
  httpClient,
} from "../../utils/httpClient.js";

export const KISSKI_DEFAULT_BASE_URL = "https://chat-ai.academiccloud.de/v1";
export const KISSKI_DEFAULT_MODEL = "deepseek-r1-distill-llama-70b";

export class KisskiProvider extends AIProvider {
  constructor(options = {}) {
    super({
      id: "kisski",
      name: "KISSKI DeepSeek",
      baseUrl: options.baseUrl ?? KISSKI_DEFAULT_BASE_URL,
      model: options.model ?? KISSKI_DEFAULT_MODEL,
      apiKey: options.apiKey ?? "",
    });
    this.timeout = options.timeout ?? 120_000;
  }

  getAuthHeaders() {
    this.requireApiKey();
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async isAvailable() {
    if (!this.apiKey) return false;

    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  async listModels() {
    const url = `${this.baseUrl}/models`;
    const requestOptions = {
      headers: this.getAuthHeaders(),
      timeout: Math.min(this.timeout, 30_000),
      mode: "cloud",
    };

    let response = await httpClient.get(url, requestOptions);

    // KISSKI documents POST for /models, while OpenAI-compatible clients
    // normally use GET. Support both variants.
    if (response.status === 404 || response.status === 405) {
      response = await httpClient.post(url, undefined, requestOptions);
    }
    await assertHttpOk(url, response);

    const payload = await response.json();
    if (!Array.isArray(payload?.data)) {
      throw new AIProviderResponseError(
        this.id,
        "KISSKI returned an invalid model list",
        { details: payload },
      );
    }

    return payload.data
      .filter((model) => typeof model?.id === "string")
      .map((model) => ({
        id: model.id,
        name: model.id,
        ownedBy: model.owned_by ?? "kisski",
      }));
  }

  async chat(messages, options = {}) {
    const url = `${this.baseUrl}/chat/completions`;
    const model = options.model ?? this.model;
    const body = removeUndefined({
      model,
      messages: this.normalizeMessages(messages),
      stream: false,
      temperature: options.temperature,
      top_p: options.topP,
      max_tokens: options.maxTokens,
      stop: options.stop,
      response_format: options.responseFormat,
      tools: options.tools,
      tool_choice: options.toolChoice,
    });

    try {
      const response = await httpClient.post(url, body, {
        headers: this.getAuthHeaders(),
        timeout: options.timeout ?? this.timeout,
        mode: "cloud",
      });
      await assertHttpOk(url, response);

      const payload = await response.json();
      const choice = payload?.choices?.[0];
      const message = choice?.message;

      if (!message || typeof message.content !== "string") {
        throw new AIProviderResponseError(
          this.id,
          "KISSKI returned no assistant message",
          { details: payload },
        );
      }

      return {
        provider: this.id,
        model: payload.model ?? model,
        content: message.content,
        reasoning: message.reasoning_content ?? null,
        finishReason: choice.finish_reason ?? null,
        usage: normalizeUsage(payload.usage),
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
}

function removeUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}

function normalizeUsage(usage) {
  if (!usage) return null;

  return {
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
  };
}

export default KisskiProvider;
