import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperContextService } from "../../src/core/PaperContextService";
import { embeddingProvider } from "../../src/ai/EmbeddingProvider.js";
import { vectorStore } from "../../src/core/OramaService";

type MockItemOptions = {
  id: number;
  key: string;
  libraryID: number;
  title: string;
  creators?: Array<{ firstName?: string; lastName?: string; name?: string }>;
  tags?: string[];
  fields?: Record<string, string>;
};

function createMockItem(options: MockItemOptions) {
  const fields = {
    title: options.title,
    firstCreator: options.creators?.[0]?.lastName ?? "",
    year: options.fields?.year ?? "2024",
    date: options.fields?.date ?? "2024",
    publicationTitle: options.fields?.publicationTitle ?? "Journal Test",
    publisher: options.fields?.publisher ?? "",
    DOI: options.fields?.DOI ?? "",
    ISBN: options.fields?.ISBN ?? "",
    url: options.fields?.url ?? "",
    abstractNote: options.fields?.abstractNote ?? "",
    dateAdded: options.fields?.dateAdded ?? "2026-01-01",
    dateModified: options.fields?.dateModified ?? "2026-06-01",
    itemType: options.fields?.itemType ?? "journalArticle",
    ...options.fields,
  };

  return {
    id: options.id,
    key: options.key,
    libraryID: options.libraryID,
    parentID: null,
    attachmentContentType: "",
    isRegularItem: () => true,
    isAttachment: () => false,
    getField: (field: string) => fields[field] ?? "",
    getCreators: () => options.creators ?? [],
    getTags: () => (options.tags ?? []).map((tag) => ({ tag })),
    getAttachments: () => [],
    loadAllData: vi.fn(async () => undefined),
  };
}

describe("paper context pipeline integration", () => {
  const marketingItem = createMockItem({
    id: 101,
    key: "MARKETING",
    libraryID: 1,
    title: "Past, present and future of AI in marketing",
    creators: [{ firstName: "Alex", lastName: "Kumar" }],
    tags: ["AI", "Marketing"],
    fields: {
      abstractNote: "This paper reviews AI applications in marketing.",
      DOI: "10.1000/ai-marketing",
    },
  });

  const kmItem = createMockItem({
    id: 202,
    key: "KM",
    libraryID: 2,
    title: "AI in knowledge management",
    creators: [{ firstName: "Sam", lastName: "Singh" }],
    tags: ["AI", "Knowledge Management"],
    fields: {
      abstractNote: "This paper studies knowledge management systems.",
    },
  });

  beforeEach(() => {
    vi.spyOn(embeddingProvider, "embedTexts").mockResolvedValue([[0.1, 0.2]]);
    vi.spyOn(vectorStore, "searchSimilar").mockImplementation(
      async (_queryVector, _limit, whereFilter) => {
        const zoteroItemId = whereFilter?.zoteroItemId ?? "101";
        return [
          {
            id: `${zoteroItemId}_chunk_1`,
            score: 1,
            document: {
              id: `${zoteroItemId}_chunk_1`,
              zoteroItemId,
              sourceType: "fulltext",
              content:
                zoteroItemId === "101"
                  ? "AI in marketing improves segmentation and campaign decisions."
                  : "AI supports knowledge management workflows.",
              pageNumber: 1,
              embedding: [0.1, 0.2],
            },
          },
        ];
      },
    );

    globalThis.Zotero = {
      debug: vi.fn(),
      Prefs: {
        get: vi.fn(() => "title,creators"),
      },
      Libraries: {
        getName: vi.fn((libraryID: number) =>
          libraryID === 2 ? "Group Library" : "Meine Bibliothek",
        ),
      },
      Items: {
        getAsync: vi.fn(async (itemID: number) =>
          itemID === 202 ? kmItem : marketingItem,
        ),
      },
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).Zotero;
  });

  it("builds vector context with selected metadata fields and matching chunks", async () => {
    const context = await PaperContextService.buildVectorContextForItems(
      "Welches Paper passt zu AI im Marketing?",
      [101, 202],
      "Relevante Auszüge aus ausgewählten Papern:",
      {
        contentFocus: "abstracts",
        metadataFields: ["title", "creators"],
      },
    );

    expect(embeddingProvider.embedTexts).toHaveBeenCalledWith(
      [
        expect.stringContaining(
          "Welches Paper passt zu AI im Marketing?",
        ) as unknown as string,
      ],
      { inputType: "query" },
    );
    expect(vectorStore.searchSimilar).toHaveBeenCalledWith(
      [0.1, 0.2],
      expect.any(Number),
      { zoteroItemId: "101" },
      expect.any(String),
    );
    expect(context).toContain("Paper-Metadaten:");
    expect(context).toContain(
      "Titel: Past, present and future of AI in marketing",
    );
    expect(context).toContain("Autorenschaft: Alex Kumar");
    expect(context).not.toContain("Tags:");
    expect(context).toContain(
      "AI in marketing improves segmentation and campaign decisions.",
    );
    expect(context).toContain("AI supports knowledge management workflows.");
  });

  it("falls back to metadata and Zotero abstracts when no vector chunks are found", async () => {
    vi.mocked(vectorStore.searchSimilar).mockResolvedValue([]);

    const context = await PaperContextService.buildVectorContextForItems(
      "Fasse alle Paper zusammen",
      [101],
      "Relevante Auszüge aus allen Papern:",
      {
        contentFocus: "abstracts",
        metadataFields: ["title"],
      },
    );

    expect(context).toContain(
      "keine passenden Textauszuege in der lokalen Vektordatenbank",
    );
    expect(context).toContain(
      "Titel: Past, present and future of AI in marketing",
    );
    const metadataBlock = context?.slice(
      context.indexOf("<paper-metadata>"),
      context.indexOf("</paper-metadata>"),
    );
    expect(metadataBlock).not.toContain("Autorenschaft:");
    expect(context).toContain("Zotero-Abstracts:");
    expect(context).toContain(
      "This paper reviews AI applications in marketing.",
    );
  });
});
