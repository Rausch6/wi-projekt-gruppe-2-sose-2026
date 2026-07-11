import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddingProvider } from "../../src/ai/EmbeddingProvider.js";
import { EmbeddingSearchService } from "../../src/core/EmbeddingSearchService";

describe("EmbeddingSearchService disabled mode", () => {
  afterEach(() => {
    EmbeddingSearchService.configure({ enabled: true });
    vi.restoreAllMocks();
  });

  it("uses keyword selection without making an embedding request", async () => {
    EmbeddingSearchService.configure({ enabled: false });
    const embedTexts = vi.spyOn(embeddingProvider, "embedTexts");
    const chunks = [
      {
        id: "C1",
        text: "Semantische Suche mit Embeddings",
        pageStart: 1,
        pageEnd: 1,
        estimatedTokens: 6,
      },
      {
        id: "C2",
        text: "Ein vollständig anderes Thema",
        pageStart: 2,
        pageEnd: 2,
        estimatedTokens: 5,
      },
    ];

    const selected = await EmbeddingSearchService.selectRelevantChunks(
      chunks,
      "Semantische Suche",
    );

    expect(embedTexts).not.toHaveBeenCalled();
    expect(selected[0]?.id).toBe("C1");
    expect(EmbeddingSearchService.getLastStatus().mode).toBe("disabled");
  });
});
