import { afterEach, describe, expect, it, vi } from "vitest";
import { AIProviderManager } from "../../src/ai/AIProviderManager.js";

/**
 * Creates the minimal fetch response shape consumed by the HTTP client.
 *
 * @param {number} status - HTTP response status code.
 * @param {unknown} body - JSON-serializable response body.
 * @returns {object} Mocked fetch response.
 */
function createFetchResponse(status, body) {
  return {
    status,
    headers: {
      forEach() {},
    },
    text: async () => JSON.stringify(body),
  };
}

/**
 * Verifies end-to-end provider routing through the manager and HTTP client layer.
 */
describe("provider pipeline integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes a KISSKI chat request through manager, provider and HTTP client", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createFetchResponse(200, {
        model: "deepseek-r1-distill-llama-70b",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Cloud Antwort",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
        },
      }),
    );
    const manager = new AIProviderManager({
      kisski: {
        apiKey: "test-key",
        baseUrl: "http://localhost:9999/v1",
        model: "deepseek-r1-distill-llama-70b",
      },
      activeProvider: "kisski",
    });

    const result = await manager.chat(
      [{ role: "user", content: "Hallo KISSKI" }],
      { temperature: 0, maxTokens: 50 },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9999/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"messages"'),
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(result).toMatchObject({
      provider: "kisski",
      content: "Cloud Antwort",
      usage: {
        promptTokens: 12,
        completionTokens: 8,
        totalTokens: 20,
      },
    });
  });

  it("routes an Ollama chat request through manager, provider and HTTP client", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createFetchResponse(200, {
        model: "qwen2.5:3b",
        message: {
          role: "assistant",
          content: "Lokale Antwort",
        },
        done_reason: "stop",
        prompt_eval_count: 7,
        eval_count: 5,
      }),
    );
    const manager = new AIProviderManager({
      ollama: {
        baseUrl: "http://localhost:11434",
        model: "qwen2.5:3b",
      },
      activeProvider: "ollama",
    });

    const result = await manager.chat([{ role: "user", content: "Hallo" }], {
      providerId: "ollama",
      maxTokens: 25,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/chat",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"num_predict":25'),
      }),
    );
    expect(result).toMatchObject({
      provider: "ollama",
      content: "Lokale Antwort",
      usage: {
        promptTokens: 7,
        completionTokens: 5,
        totalTokens: 12,
      },
    });
  });
});
