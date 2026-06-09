/**
 * Common contract for cloud and local AI providers.
 */
export class AIProvider {
  constructor({ id, name, baseUrl, model, apiKey = "" }) {
    if (new.target === AIProvider) {
      throw new TypeError("AIProvider is abstract and cannot be instantiated");
    }

    this.id = requireText(id, "Provider id");
    this.name = requireText(name, "Provider name");
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = requireText(model, "Model");
    this.apiKey = apiKey.trim();
  }

  setApiKey(apiKey) {
    this.apiKey = requireText(apiKey, "API key");
    return this;
  }

  clearApiKey() {
    this.apiKey = "";
    return this;
  }

  setModel(model) {
    this.model = requireText(model, "Model");
    return this;
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    return this;
  }

  getConfig() {
    return {
      id: this.id,
      name: this.name,
      baseUrl: this.baseUrl,
      model: this.model,
      hasApiKey: Boolean(this.apiKey),
    };
  }

  requireApiKey() {
    if (!this.apiKey) {
      throw new AIProviderConfigurationError(
        this.id,
        `No API key configured for ${this.name}`,
      );
    }
  }

  normalizeMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AIProviderConfigurationError(
        this.id,
        "At least one chat message is required",
      );
    }

    return messages.map((message, index) => {
      if (!message || typeof message !== "object") {
        throw new AIProviderConfigurationError(
          this.id,
          `Message ${index} must be an object`,
        );
      }

      const role = requireText(message.role, `Message ${index} role`);
      const content = requireText(message.content, `Message ${index} content`);

      if (!["system", "user", "assistant", "tool"].includes(role)) {
        throw new AIProviderConfigurationError(
          this.id,
          `Unsupported message role: ${role}`,
        );
      }

      const normalized = { role, content };
      if (message.name) normalized.name = String(message.name);
      if (message.tool_call_id) {
        normalized.tool_call_id = String(message.tool_call_id);
      }
      return normalized;
    });
  }

  async complete(prompt, options = {}) {
    const messages = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });
    return this.chat(messages, options);
  }

  async isAvailable() {
    throw new Error(`${this.name}.isAvailable() is not implemented`);
  }

  async listModels() {
    throw new Error(`${this.name}.listModels() is not implemented`);
  }

  async chat(_messages, _options = {}) {
    throw new Error(`${this.name}.chat() is not implemented`);
  }

  async *chatStream(messages, options = {}) {
    const response = await this.chat(messages, options);
    const content =
      typeof response?.content === "string" ? response.content : "";

    if (content) {
      yield {
        type: "content",
        content,
        provider: response.provider ?? this.id,
        model: response.model ?? this.model,
      };
    }

    yield {
      type: "done",
      provider: response?.provider ?? this.id,
      model: response?.model ?? this.model,
      finishReason: response?.finishReason ?? null,
      usage: response?.usage ?? null,
    };
  }
}

export class AIProviderError extends Error {
  constructor(providerId, message, options = {}) {
    super(message);
    this.name = "AIProviderError";
    this.providerId = providerId;
    this.status = options.status;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export class AIProviderConfigurationError extends AIProviderError {
  constructor(providerId, message) {
    super(providerId, message);
    this.name = "AIProviderConfigurationError";
  }
}

export class AIProviderResponseError extends AIProviderError {
  constructor(providerId, message, options = {}) {
    super(providerId, message, options);
    this.name = "AIProviderResponseError";
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeBaseUrl(baseUrl) {
  return requireText(baseUrl, "Base URL").replace(/\/+$/, "");
}
