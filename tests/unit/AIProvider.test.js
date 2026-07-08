import { describe, expect, it } from "vitest";
import {
  AIProvider,
  AIProviderConfigurationError,
} from "../../src/ai/AIProvider.js";

class TestProvider extends AIProvider {
  constructor(options = {}) {
    super({
      id: "test",
      name: "Test Provider",
      baseUrl: "https://example.test/api/",
      model: "test-model",
      ...options,
    });
    this.chatCalls = [];
  }

  async chat(messages, options = {}) {
    this.chatCalls.push({ messages, options });
    return {
      provider: this.id,
      model: options.model ?? this.model,
      content: "ok",
      finishReason: "stop",
      usage: null,
    };
  }
}

describe("AIProvider", () => {
  it("cannot be instantiated directly", () => {
    expect(() => new AIProvider({})).toThrow(TypeError);
  });

  it("normalizes config values", () => {
    const provider = new TestProvider({
      apiKey: " secret ",
      baseUrl: "https://example.test/api///",
    });

    expect(provider.getConfig()).toEqual({
      id: "test",
      name: "Test Provider",
      baseUrl: "https://example.test/api",
      model: "test-model",
      hasApiKey: true,
    });
  });

  it("validates chat messages", () => {
    const provider = new TestProvider();

    expect(() => provider.normalizeMessages([])).toThrow(
      AIProviderConfigurationError,
    );
    expect(() =>
      provider.normalizeMessages([{ role: "invalid", content: "hello" }]),
    ).toThrow(AIProviderConfigurationError);
    expect(
      provider.normalizeMessages([{ role: "user", content: " hello " }]),
    ).toEqual([{ role: "user", content: "hello" }]);
  });

  it("builds completion messages from prompt and system prompt", async () => {
    const provider = new TestProvider();

    await provider.complete("User prompt", { systemPrompt: "System prompt" });

    expect(provider.chatCalls[0].messages).toEqual([
      { role: "system", content: "System prompt" },
      { role: "user", content: "User prompt" },
    ]);
  });

  it("emits a basic stream from non-streaming chat", async () => {
    const provider = new TestProvider();
    const events = [];

    for await (const event of provider.chatStream([
      { role: "user", content: "Hello" },
    ])) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "content",
        content: "ok",
        provider: "test",
        model: "test-model",
      },
      {
        type: "done",
        provider: "test",
        model: "test-model",
        finishReason: "stop",
        usage: null,
      },
    ]);
  });
});
