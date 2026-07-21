import { describe, expect, it, vi } from "vitest";
import { AIProviderManager } from "../../src/ai/AIProviderManager.js";
import { AIProviderConfigurationError } from "../../src/ai/AIProvider.js";

/**
 * Creates a mock provider implementing the AIProviderManager contract.
 *
 * @param {string} id - Provider identifier used by the manager.
 * @returns {object} Mock provider with spyable methods.
 */
function createProvider(id) {
  return {
    id,
    setApiKey: vi.fn().mockReturnThis(),
    clearApiKey: vi.fn().mockReturnThis(),
    setModel: vi.fn().mockReturnThis(),
    setBaseUrl: vi.fn().mockReturnThis(),
    getConfig: vi.fn(() => ({
      id,
      name: id,
      baseUrl: `https://${id}.test`,
      model: "model-a",
      hasApiKey: false,
    })),
    isAvailable: vi.fn(async () => true),
    listModels: vi.fn(async () => [{ id: "model-a", name: "Model A" }]),
    chat: vi.fn(async () => ({ provider: id, content: "answer" })),
    chatStream: vi.fn(),
    complete: vi.fn(async () => ({ provider: id, content: "complete" })),
    embed: vi.fn(async () => [1, 2, 3]),
  };
}

/**
 * Verifies provider registration, configuration, and request routing in the manager.
 */
describe("AIProviderManager", () => {
  it("registers providers and switches the active provider", () => {
    const manager = new AIProviderManager();
    const provider = createProvider("mock");

    manager.register(provider).setActiveProvider("mock");

    expect(manager.getProvider()).toBe(provider);
    expect(manager.listProviders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mock", active: true }),
      ]),
    );
  });

  it("rejects invalid or unknown providers", () => {
    const manager = new AIProviderManager();

    expect(() => manager.register({ id: "broken" })).toThrow(TypeError);
    expect(() => manager.getProvider("missing")).toThrow(
      AIProviderConfigurationError,
    );
  });

  it("configures API key, model, base URL and timeout on a provider", () => {
    const manager = new AIProviderManager();
    const provider = createProvider("mock");
    manager.register(provider);

    manager.configureProvider("mock", {
      apiKey: "secret",
      model: "model-b",
      baseUrl: "https://mock.test/v1",
      timeout: 1234,
    });

    expect(provider.setApiKey).toHaveBeenCalledWith("secret");
    expect(provider.setModel).toHaveBeenCalledWith("model-b");
    expect(provider.setBaseUrl).toHaveBeenCalledWith("https://mock.test/v1");
    expect(provider.timeout).toBe(1234);
  });

  it("routes chat calls to the requested provider and strips providerId", async () => {
    const manager = new AIProviderManager();
    const provider = createProvider("mock");
    manager.register(provider);

    const result = await manager.chat([{ role: "user", content: "Hi" }], {
      providerId: "mock",
      temperature: 0,
    });

    expect(result).toEqual({ provider: "mock", content: "answer" });
    expect(provider.chat).toHaveBeenCalledWith(
      [{ role: "user", content: "Hi" }],
      { temperature: 0 },
    );
  });
});
