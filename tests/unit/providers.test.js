import { afterEach, describe, expect, it, vi } from "vitest";
import { AIProviderConfigurationError } from "../../src/ai/AIProvider.js";
import { KisskiProvider } from "../../src/ai/providers/KisskiProvider.js";
import { OllamaProvider } from "../../src/ai/providers/OllamaProvider.js";
import { httpClient } from "../../src/utils/httpClient.js";

function jsonResponse(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe("AI providers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("KISSKI requires an API key before creating auth headers", () => {
    const provider = new KisskiProvider();

    expect(() => provider.getAuthHeaders()).toThrow(
      AIProviderConfigurationError,
    );
  });

  it("KISSKI sends OpenAI-compatible chat requests", async () => {
    const provider = new KisskiProvider({
      apiKey: "secret",
      baseUrl: "https://kisski.test/v1",
      model: "deepseek-test",
    });
    const post = vi.spyOn(httpClient, "post").mockResolvedValue(
      jsonResponse({
        model: "deepseek-test",
        choices: [
          {
            message: { role: "assistant", content: "Antwort" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    );

    const result = await provider.chat([{ role: "user", content: "Hallo" }], {
      temperature: 0.2,
      maxTokens: 100,
    });

    expect(post).toHaveBeenCalledWith(
      "https://kisski.test/v1/chat/completions",
      expect.objectContaining({
        model: "deepseek-test",
        messages: [{ role: "user", content: "Hallo" }],
        stream: false,
        temperature: 0.2,
        max_tokens: 100,
      }),
      expect.objectContaining({
        headers: { Authorization: "Bearer secret" },
        mode: "cloud",
      }),
    );
    expect(result).toMatchObject({
      provider: "kisski",
      model: "deepseek-test",
      content: "Antwort",
      finishReason: "stop",
      usage: {
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7,
      },
    });
  });

  it("KISSKI falls back from GET to POST when listing models", async () => {
    const provider = new KisskiProvider({
      apiKey: "secret",
      baseUrl: "https://kisski.test/v1",
    });
    vi.spyOn(httpClient, "get").mockResolvedValue(jsonResponse({}, 405));
    const post = vi.spyOn(httpClient, "post").mockResolvedValue(
      jsonResponse({
        data: [{ id: "deepseek-a", owned_by: "kisski" }],
      }),
    );

    await expect(provider.listModels()).resolves.toEqual([
      { id: "deepseek-a", name: "deepseek-a", ownedBy: "kisski" },
    ]);
    expect(post).toHaveBeenCalledWith(
      "https://kisski.test/v1/models",
      undefined,
      expect.objectContaining({ mode: "cloud" }),
    );
  });

  it("Ollama lists local models", async () => {
    const provider = new OllamaProvider({ baseUrl: "http://localhost:11434" });
    vi.spyOn(httpClient, "get").mockResolvedValue(
      jsonResponse({
        models: [{ name: "qwen2.5:3b" }, { model: "llama3.2:latest" }],
      }),
    );

    await expect(provider.listModels()).resolves.toEqual([
      { id: "qwen2.5:3b", name: "qwen2.5:3b", ownedBy: "ollama" },
      { id: "llama3.2:latest", name: "llama3.2:latest", ownedBy: "ollama" },
    ]);
  });

  it("Ollama sends native chat requests", async () => {
    const provider = new OllamaProvider({
      baseUrl: "http://localhost:11434",
      model: "qwen2.5:3b",
    });
    const post = vi.spyOn(httpClient, "post").mockResolvedValue(
      jsonResponse({
        model: "qwen2.5:3b",
        message: { role: "assistant", content: "Lokale Antwort" },
        done_reason: "stop",
        prompt_eval_count: 2,
        eval_count: 5,
      }),
    );

    const result = await provider.chat([{ role: "user", content: "Hallo" }], {
      maxTokens: 50,
    });

    expect(post).toHaveBeenCalledWith(
      "http://localhost:11434/api/chat",
      expect.objectContaining({
        model: "qwen2.5:3b",
        messages: [{ role: "user", content: "Hallo" }],
        stream: false,
        options: { num_predict: 50 },
      }),
      expect.objectContaining({ mode: "local" }),
    );
    expect(result).toMatchObject({
      provider: "ollama",
      content: "Lokale Antwort",
      usage: {
        promptTokens: 2,
        completionTokens: 5,
        totalTokens: 7,
      },
    });
  });
});
