import { AIProvider, AIProviderResponseError } from "../AIProvider.js";
import {
  assertHttpOk,
  HttpResponseError,
  HttpStreamingUnsupportedError,
  httpClient,
} from "../../utils/httpClient.js";

export const KISSKI_DEFAULT_BASE_URL = "https://chat-ai.academiccloud.de/v1";
export const KISSKI_DEFAULT_MODEL = "deepseek-r1-distill-llama-70b";
export const KISSKI_MODEL_OPTIONS = [
  {
    id: "deepseek-r1-distill-llama-70b",
    name: "DeepSeek R1 Distill Llama 70B",
    ownedBy: "kisski",
  },
  {
    id: "deepseek-r1-distill-qwen-32b",
    name: "DeepSeek R1 Distill Qwen 32B",
    ownedBy: "kisski",
  },
  {
    id: "deepseek-r1-distill-qwen-14b",
    name: "DeepSeek R1 Distill Qwen 14B",
    ownedBy: "kisski",
  },
  {
    id: "deepseek-r1-distill-llama-8b",
    name: "DeepSeek R1 Distill Llama 8B",
    ownedBy: "kisski",
  },
  {
    id: "deepseek-r1-distill-qwen-7b",
    name: "DeepSeek R1 Distill Qwen 7B",
    ownedBy: "kisski",
  },
  {
    id: "deepseek-r1-distill-qwen-1.5b",
    name: "DeepSeek R1 Distill Qwen 1.5B",
    ownedBy: "kisski",
  },
];

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
    const models = normalizeModelList(payload);
    if (!models.length) {
      throw new AIProviderResponseError(
        this.id,
        "KISSKI returned an invalid model list",
        { details: payload },
      );
    }

    return models;
  }

  async chat(messages, options = {}) {
    const url = `${this.baseUrl}/chat/completions`;
    const model = options.model ?? this.model;
    const body = this.createChatCompletionBody(messages, options, false);

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
        finishReason: choice.finish_reason ?? null,
        usage: normalizeUsage(payload.usage),
        raw: removeReasoningContent(payload),
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

  async *chatStream(messages, options = {}) {
    const url = `${this.baseUrl}/chat/completions`;
    const model = options.model ?? this.model;
    const body = this.createChatCompletionBody(messages, options, true);
    let emittedContent = false;

    try {
      const response = await httpClient.streamPost(url, body, {
        headers: this.getAuthHeaders(),
        timeout: options.timeout ?? this.timeout,
        mode: "cloud",
      });
      await assertHttpOk(url, response);

      if (typeof response.streamText !== "function") {
        throw new HttpStreamingUnsupportedError(
          url,
          "response does not expose a text stream",
        );
      }

      let responseModel = model;
      let finishReason = null;
      let usage = null;

      yield {
        type: "start",
        provider: this.id,
        model: responseModel,
      };

      for await (const payload of parseChatCompletionSse(
        response.streamText(),
        this.id,
      )) {
        if (payload.done) break;

        responseModel = payload.model ?? responseModel;
        usage = normalizeUsage(payload.usage) ?? usage;

        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        for (const choice of choices) {
          const delta = choice?.delta ?? {};

          if (typeof delta.reasoning_content === "string") {
            yield {
              type: "reasoning",
              provider: this.id,
              model: responseModel,
            };
          }

          if (typeof delta.content === "string" && delta.content) {
            emittedContent = true;
            yield {
              type: "content",
              content: delta.content,
              provider: this.id,
              model: responseModel,
            };
          }

          if (choice?.finish_reason !== undefined) {
            finishReason = choice.finish_reason;
          }
        }
      }

      yield {
        type: "done",
        provider: this.id,
        model: responseModel,
        finishReason,
        usage,
      };
    } catch (cause) {
      if (!emittedContent && shouldFallbackToNonStreaming(cause)) {
        yield* super.chatStream(messages, options);
        return;
      }
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

  createChatCompletionBody(messages, options, stream) {
    return removeUndefined({
      model: options.model ?? this.model,
      messages: this.normalizeMessages(messages),
      stream,
      temperature: options.temperature,
      top_p: options.topP,
      max_tokens: options.maxTokens,
      stop: options.stop,
      response_format: options.responseFormat,
      tools: options.tools,
      tool_choice: options.toolChoice,
    });
  }
}

function normalizeModelList(payload) {
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

  return entries
    .map((model) => {
      const id =
        typeof model === "string"
          ? model
          : typeof model?.id === "string"
            ? model.id
            : typeof model?.model === "string"
              ? model.model
              : typeof model?.name === "string"
                ? model.name
                : "";
      if (!id.trim()) return null;

      return {
        id: id.trim(),
        name:
          typeof model?.name === "string" && model.name.trim()
            ? model.name.trim()
            : id.trim(),
        ownedBy:
          typeof model?.owned_by === "string"
            ? model.owned_by
            : typeof model?.ownedBy === "string"
              ? model.ownedBy
              : "kisski",
      };
    })
    .filter(Boolean);
}

async function* parseChatCompletionSse(textStream, providerId) {
  let buffer = "";
  let dataLines = [];

  const consumeLine = (line) => {
    if (line === "") {
      return flushDataLines();
    }

    if (line.startsWith(":")) return null;

    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const rawValue = separator >= 0 ? line.slice(separator + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "data") {
      dataLines.push(value);
    }
    return null;
  };

  const flushDataLines = () => {
    if (!dataLines.length) return null;
    const data = dataLines.join("\n");
    dataLines = [];
    return data;
  };

  for await (const chunk of textStream) {
    buffer += chunk;
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const data = consumeLine(line);
      if (data !== null) yield parseSseData(data, providerId);
    }
  }

  if (buffer) {
    const data = consumeLine(buffer);
    if (data !== null) yield parseSseData(data, providerId);
  }

  const finalData = flushDataLines();
  if (finalData !== null) yield parseSseData(finalData, providerId);
}

function parseSseData(data, providerId) {
  if (data.trim() === "[DONE]") {
    return { done: true };
  }

  try {
    return JSON.parse(data);
  } catch (cause) {
    throw new AIProviderResponseError(
      providerId,
      "KISSKI returned invalid streaming data",
      {
        details: data.slice(0, 300),
        cause,
      },
    );
  }
}

function shouldFallbackToNonStreaming(cause) {
  if (cause instanceof HttpStreamingUnsupportedError) return true;
  if (!(cause instanceof HttpResponseError)) return false;

  if ([404, 405, 415, 501].includes(cause.status)) return true;
  if (cause.status !== 400) return false;

  return /stream|sse|event-stream|unsupported|not supported/i.test(
    cause.message,
  );
}

function removeUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}

function removeReasoningContent(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => removeReasoningContent(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "reasoning_content")
      .map(([key, entry]) => [key, removeReasoningContent(entry)]),
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
