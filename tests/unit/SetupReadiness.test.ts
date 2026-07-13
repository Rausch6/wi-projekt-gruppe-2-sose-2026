import { describe, expect, it } from "vitest";
import { createEmbeddingConnectionResult } from "../../src/ai/embeddingConnectionStatus";
import { createProviderConnectionResult } from "../../src/ai/providerConnectionStatus";
import { deriveSetupReadiness } from "../../src/core/SetupReadiness";

const baseSettings = {
  provider: "kisski" as const,
  apiKey: "secret",
  embeddingSearchEnabled: true,
};

describe("setup readiness", () => {
  it("allows cloud without semantic search and without embeddings", () => {
    const readiness = deriveSetupReadiness(
      { ...baseSettings, embeddingSearchEnabled: false },
      createProviderConnectionResult("kisski", "ready"),
      createEmbeddingConnectionResult("disabled"),
    );

    expect(readiness.ready).toBe(true);
    expect(readiness.milestones.map(({ id }) => id)).toEqual([
      "cloud-connection",
    ]);
  });

  it("shares Ollama app and service steps for cloud chat with embeddings", () => {
    const readiness = deriveSetupReadiness(
      baseSettings,
      createProviderConnectionResult("kisski", "ready"),
      createEmbeddingConnectionResult("ready"),
    );

    expect(readiness.ready).toBe(true);
    expect(readiness.milestones).toEqual([
      { id: "cloud-connection", state: "complete" },
      { id: "ollama-installation", state: "complete" },
      { id: "ollama-service", state: "complete" },
      { id: "embedding", state: "complete" },
    ]);
  });

  it("blocks the embedding-model step behind Ollama itself for cloud chat", () => {
    const readiness = deriveSetupReadiness(
      baseSettings,
      createProviderConnectionResult("kisski", "ready"),
      createEmbeddingConnectionResult("unreachable", {
        issue: "ollama-not-running",
      }),
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.milestones).toEqual([
      { id: "cloud-connection", state: "complete" },
      { id: "ollama-installation", state: "complete" },
      { id: "ollama-service", state: "action" },
      { id: "embedding", state: "pending" },
    ]);
  });

  it("blocks cloud with semantic search while bge-m3 is missing", () => {
    const readiness = deriveSetupReadiness(
      baseSettings,
      createProviderConnectionResult("kisski", "ready"),
      createEmbeddingConnectionResult("missing-model", {
        issue: "model-not-installed",
        model: "bge-m3:latest",
      }),
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.milestones).toContainEqual({
      id: "embedding",
      state: "action",
    });
  });

  it("does not accept a stale disabled embedding state after enabling search", () => {
    const readiness = deriveSetupReadiness(
      baseSettings,
      createProviderConnectionResult("kisski", "ready"),
      createEmbeddingConnectionResult("disabled"),
    );

    expect(readiness.ready).toBe(false);
  });

  it("allows local without semantic search when its chat model is ready", () => {
    const readiness = deriveSetupReadiness(
      {
        ...baseSettings,
        provider: "ollama",
        apiKey: "",
        embeddingSearchEnabled: false,
      },
      createProviderConnectionResult("ollama", "ready"),
      createEmbeddingConnectionResult("disabled"),
    );

    expect(readiness.ready).toBe(true);
    expect(readiness.milestones).toEqual([
      { id: "ollama-installation", state: "complete" },
      { id: "ollama-service", state: "complete" },
      { id: "local-model", state: "complete" },
    ]);
  });

  it("blocks the local chat model behind Ollama installation when Ollama is missing", () => {
    const readiness = deriveSetupReadiness(
      {
        ...baseSettings,
        provider: "ollama",
        apiKey: "",
        embeddingSearchEnabled: false,
      },
      createProviderConnectionResult("ollama", "unreachable", {
        issue: "ollama-not-installed",
      }),
      createEmbeddingConnectionResult("disabled"),
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.milestones).toEqual([
      { id: "ollama-installation", state: "action" },
      { id: "ollama-service", state: "pending" },
      { id: "local-model", state: "pending" },
    ]);
  });

  it("requires local chat and embedding models when semantic search is on", () => {
    const readiness = deriveSetupReadiness(
      { ...baseSettings, provider: "ollama", apiKey: "" },
      createProviderConnectionResult("ollama", "missing-model", {
        issue: "model-not-installed",
        model: "qwen2.5:3b",
      }),
      createEmbeddingConnectionResult("missing-model", {
        issue: "model-not-installed",
        model: "bge-m3:latest",
      }),
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.milestones).toEqual([
      { id: "ollama-installation", state: "complete" },
      { id: "ollama-service", state: "complete" },
      { id: "local-model", state: "action" },
      { id: "embedding", state: "action" },
    ]);
  });

  it("reopens the cloud setup when the API key is removed", () => {
    const readiness = deriveSetupReadiness(
      { ...baseSettings, apiKey: "" },
      createProviderConnectionResult("kisski", "missing-config", {
        issue: "api-key-missing",
      }),
      createEmbeddingConnectionResult("ready"),
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.milestones[0]).toEqual({
      id: "cloud-connection",
      state: "action",
    });
  });

  it("treats a cleared local base URL or model as actionable, not an error", () => {
    const readiness = deriveSetupReadiness(
      {
        ...baseSettings,
        provider: "ollama",
        apiKey: "",
        embeddingSearchEnabled: false,
      },
      createProviderConnectionResult("ollama", "missing-config", {
        issue: "base-url-missing",
      }),
      createEmbeddingConnectionResult("disabled"),
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.milestones).toContainEqual({
      id: "ollama-installation",
      state: "action",
    });
  });

  it("unlocks the shared Ollama step once either connection confirms it's reachable", () => {
    const readiness = deriveSetupReadiness(
      { ...baseSettings, provider: "ollama", apiKey: "" },
      undefined,
      createEmbeddingConnectionResult("ready"),
    );

    expect(readiness.milestones).toContainEqual({
      id: "ollama-installation",
      state: "complete",
    });
    expect(readiness.milestones).toContainEqual({
      id: "ollama-service",
      state: "complete",
    });
    expect(readiness.milestones).toContainEqual({
      id: "local-model",
      state: "pending",
    });
  });

  it("treats an installed but not-running Ollama as actionable, not an error", () => {
    const readiness = deriveSetupReadiness(
      {
        ...baseSettings,
        provider: "ollama",
        apiKey: "",
        embeddingSearchEnabled: false,
      },
      createProviderConnectionResult("ollama", "unreachable", {
        issue: "ollama-not-running",
      }),
      createEmbeddingConnectionResult("disabled"),
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.milestones).toContainEqual({
      id: "ollama-installation",
      state: "complete",
    });
    expect(readiness.milestones).toContainEqual({
      id: "ollama-service",
      state: "action",
    });
  });

  it("keeps the app complete when only the Ollama service fails to start", () => {
    const readiness = deriveSetupReadiness(
      {
        ...baseSettings,
        provider: "ollama",
        apiKey: "",
        embeddingSearchEnabled: false,
      },
      createProviderConnectionResult("ollama", "error", {
        issue: "ollama-start-failed",
      }),
      createEmbeddingConnectionResult("disabled"),
    );

    expect(readiness.milestones).toEqual([
      { id: "ollama-installation", state: "complete" },
      { id: "ollama-service", state: "error" },
      { id: "local-model", state: "pending" },
    ]);
  });
});
