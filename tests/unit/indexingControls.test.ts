import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundIndexer } from "../../src/core/BackgroundIndexer";
import { LibraryScopeManager } from "../../src/core/LibraryScopeManager";
import { PdfExtractor } from "../../src/core/PdfExtractor";
import { vectorStore } from "../../src/core/OramaService";
import { embeddingProvider } from "../../src/ai/EmbeddingProvider.js";
import {
  markInitialIndexPromptShown,
  shouldShowInitialIndexPrompt,
} from "../../src/ui/indexManager/actions";
import { filterPapersByLibrary } from "../../src/ui/indexManager/state";
import type { PaperRecord } from "../../src/ui/indexManager/types";

function createItem(id: number, libraryID: number, title: string) {
  return {
    id,
    libraryID,
    parentID: null,
    attachmentContentType: "",
    isNote: () => false,
    isRegularItem: () => true,
    isAttachment: () => false,
    getField: (field: string) => {
      if (field === "title") return title;
      if (field === "year") return "2026";
      if (field === "deleted") return false;
      return "";
    },
  };
}

function createPaperRecord(itemID: number, libraryID: number): PaperRecord {
  return {
    itemID,
    libraryID,
    libraryName: `Library ${libraryID}`,
    title: `Paper ${itemID}`,
    author: "Autor",
    year: "2026",
    itemType: "journalArticle",
    indexed: false,
    searchText: "",
  };
}

describe("indexing controls", () => {
  const item101 = createItem(101, 1, "Paper 101");
  const item202 = createItem(202, 2, "Paper 202");

  beforeEach(() => {
    vi.spyOn(vectorStore, "getIndexedItemIds").mockReturnValue(new Set());
    vi.spyOn(vectorStore, "getTextHash").mockReturnValue(undefined);
    vi.spyOn(vectorStore, "deleteByZoteroItemId").mockResolvedValue(undefined);
    vi.spyOn(vectorStore, "deleteByZoteroItemIds").mockResolvedValue(undefined);
    vi.spyOn(vectorStore, "addChunks").mockResolvedValue(undefined);
    vi.spyOn(vectorStore, "markAsIndexing").mockImplementation(() => undefined);
    vi.spyOn(vectorStore, "markAsIndexed").mockImplementation(() => undefined);
    vi.spyOn(PdfExtractor, "extractDocument").mockImplementation(
      async (item: any) => ({
        item,
        attachment: {
          id: item.id + 1000,
          version: 1,
          getField: () => "2026-07-09",
        },
        title: item.getField("title"),
        creators: "Autor",
        year: "2026",
        pages: [{ page: 1, text: `Volltext ${item.id}` }],
      }),
    );
    vi.spyOn(embeddingProvider, "embedTexts").mockResolvedValue([
      Array.from({ length: 1024 }, () => 0.1),
    ]);

    globalThis.Zotero = {
      debug: vi.fn(),
      logError: vi.fn(),
      Prefs: {
        get: vi.fn(() => false),
        set: vi.fn(),
      },
      Groups: {
        getAll: vi.fn(() => []),
        getGroupIDFromLibraryID: vi.fn(() => null),
      },
      Libraries: {
        userLibraryID: 1,
        isGroupLibrary: vi.fn((libraryID: number) => libraryID !== 1),
        getName: vi.fn((libraryID: number) => `Library ${libraryID}`),
        isEditable: vi.fn(() => true),
        isFilesEditable: vi.fn(() => true),
      },
      Items: {
        getAsync: vi.fn(async (itemID: number) =>
          itemID === 202 ? item202 : item101,
        ),
        getAll: vi.fn(async (libraryID: number) =>
          libraryID === 2 ? [item202] : [item101],
        ),
      },
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).Zotero;
  });

  it("does not enqueue Zotero add events automatically", () => {
    const enqueueSpy = vi.spyOn(backgroundIndexer, "enqueue");

    backgroundIndexer.notify("add", "item", [101], {});

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(vectorStore.addChunks).not.toHaveBeenCalled();
  });

  it("does not re-enqueue on modify when the PDF's parent item is not indexed yet", async () => {
    const attachment = {
      id: 501,
      parentID: 101,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
    };
    vi.mocked(globalThis.Zotero.Items.getAsync).mockImplementation(
      async (id: number) => (id === 501 ? attachment : item101),
    );
    const enqueueSpy = vi.spyOn(backgroundIndexer, "enqueue");

    backgroundIndexer.notify("modify", "item", [501], {});
    await vi.waitFor(() => {
      expect(globalThis.Zotero.Items.getAsync).toHaveBeenCalledWith(501);
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not re-enqueue on modify of a regular item's metadata (not the attachment)", async () => {
    vi.spyOn(vectorStore, "getIndexedItemIds").mockReturnValue(
      new Set(["101"]),
    );
    const enqueueSpy = vi.spyOn(backgroundIndexer, "enqueue");

    backgroundIndexer.notify("modify", "item", [101], {});
    await vi.waitFor(() => {
      expect(globalThis.Zotero.Items.getAsync).toHaveBeenCalledWith(101);
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("re-enqueues an already indexed paper when its PDF attachment is modified", async () => {
    vi.spyOn(vectorStore, "getIndexedItemIds").mockReturnValue(
      new Set(["101"]),
    );
    const attachment = {
      id: 501,
      parentID: 101,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
    };
    vi.mocked(globalThis.Zotero.Items.getAsync).mockImplementation(
      async (id: number) => (id === 501 ? attachment : item101),
    );
    const enqueueSpy = vi.spyOn(backgroundIndexer, "enqueue");

    backgroundIndexer.notify("modify", "item", [501], {});

    await vi.waitFor(() => {
      expect(enqueueSpy).toHaveBeenCalledWith([101]);
    });
  });

  it("removes the parent item from the index when a child attachment is trashed", async () => {
    const attachment = {
      id: 501,
      parentID: 101,
      isAttachment: () => true,
    };
    vi.mocked(globalThis.Zotero.Items.getAsync).mockResolvedValueOnce(
      attachment,
    );

    backgroundIndexer.notify("trash", "item", [501], {});

    await vi.waitFor(() => {
      expect(vectorStore.deleteByZoteroItemIds).toHaveBeenCalledWith(
        new Set([101]),
      );
    });
  });

  it("still indexes papers that are manually enqueued", async () => {
    backgroundIndexer.enqueue([101]);

    await vi.waitFor(() => {
      expect(vectorStore.markAsIndexing).toHaveBeenCalledWith(
        "101",
        expect.any(String),
      );
    });
    expect(vectorStore.markAsIndexed).toHaveBeenCalledWith("101");
    await vi.waitFor(() => {
      expect(backgroundIndexer.indexingState.status).toBe("done");
    });

    expect(PdfExtractor.extractDocument).toHaveBeenCalledWith(item101);
    expect(vectorStore.addChunks).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          zoteroItemId: "101",
          sourceType: "fulltext",
        }),
      ]),
    );
  });

  it("limits full library indexing to the selected libraries", async () => {
    vi.spyOn(LibraryScopeManager, "listLibraryScopes").mockReturnValue([
      {
        libraryID: 1,
        name: "Library 1",
        type: "user",
        groupID: null,
        editable: true,
        filesEditable: true,
      },
      {
        libraryID: 2,
        name: "Library 2",
        type: "group",
        groupID: 22,
        editable: true,
        filesEditable: true,
      },
    ]);

    await backgroundIndexer.indexAllLibraryItems({ libraryIDs: [2] });

    expect(globalThis.Zotero.Items.getAll).toHaveBeenCalledTimes(1);
    expect(globalThis.Zotero.Items.getAll).toHaveBeenCalledWith(
      2,
      false,
      false,
      false,
    );
    expect(PdfExtractor.extractDocument).toHaveBeenCalledWith(item202);
    expect(PdfExtractor.extractDocument).not.toHaveBeenCalledWith(item101);
  });

  it("filters index manager papers by checked library IDs", () => {
    const papers = [
      createPaperRecord(101, 1),
      createPaperRecord(202, 2),
      createPaperRecord(303, 3),
    ];

    expect(filterPapersByLibrary(papers, new Set([1, 3]))).toEqual([
      papers[0],
      papers[2],
    ]);
    expect(filterPapersByLibrary(papers, new Set())).toEqual([]);
  });

  it("stores the initial indexing prompt preference after first use", () => {
    const prefGet = vi.spyOn(globalThis.Zotero.Prefs, "get");
    const prefSet = vi.spyOn(globalThis.Zotero.Prefs, "set");

    prefGet.mockReturnValueOnce(false);
    expect(shouldShowInitialIndexPrompt()).toBe(true);

    markInitialIndexPromptShown();

    expect(prefSet).toHaveBeenCalledWith(
      "extensions.zotero.addontemplate.initialIndexPromptShown",
      true,
      true,
    );
  });
});
