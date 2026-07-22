import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundIndexer } from "../../src/core/BackgroundIndexer";
import { LibraryScopeManager } from "../../src/core/LibraryScopeManager";
import { PdfExtractor } from "../../src/core/PdfExtractor";
import { vectorStore } from "../../src/core/OramaService";
import { embeddingProvider } from "../../src/ai/EmbeddingProvider.js";
import {
  collectPapers,
  markInitialIndexPromptShown,
  shouldShowInitialIndexPrompt,
} from "../../src/ui/indexManager/actions";
import { filterPapersByLibrary } from "../../src/ui/indexManager/state";
import type { PaperRecord } from "../../src/ui/indexManager/types";
import {
  getUnindexedPaperContextCount,
  getUnindexedPaperContextWarning,
} from "../../src/ui/paperContextIndexStatus";

/**
 * Erstellt ein vollständig geladenes Mock-Item für Tests mit Zotero-Eigenschaften.
 *
 * @param id - Die ID des Items.
 * @param libraryID - Die ID der Bibliothek, zu der das Item gehört.
 * @param title - Der Titel des Items.
 * @returns Ein Mock-Objekt, das ein vollständig geladenes Zotero-Item simuliert.
 */
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

/**
 * Erstellt einen Paper-Datensatz für Tests, wie er vom IndexManager verwendet wird.
 *
 * @param itemID - Die ID des Zotero-Items.
 * @param libraryID - Die ID der Bibliothek.
 * @returns Ein PaperRecord-Objekt mit Testdaten.
 */
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

/**
 * Tests für die Indexierungssteuerung.
 * Diese Testsuite überprüft das Verhalten des BackgroundIndexers,
 * das Sammeln von Papern sowie die Interaktion mit Zotero-Events
 * (Hinzufügen, Ändern, Löschen).
 */
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
        getAsync: vi.fn(async (itemID: number | number[]) => {
          if (Array.isArray(itemID)) {
            return itemID.map((id) => (id === 202 ? item202 : item101));
          }
          return itemID === 202 ? item202 : item101;
        }),
        getAll: vi.fn(async (libraryID: number) =>
          libraryID === 2 ? [item202] : [item101],
        ),
        getAllIDs: vi.fn(async (libraryID: number) =>
          libraryID === 2 ? [202] : [101],
        ),
      },
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).Zotero;
  });

  /**
   * Stellt sicher, dass Zotero „add"-Events nicht automatisch in die
   * Warteschlange eingereiht werden.
   */
  it("does not enqueue Zotero add events automatically", () => {
    const enqueueSpy = vi.spyOn(backgroundIndexer, "enqueue");

    backgroundIndexer.notify("add", "item", [101], {});

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(vectorStore.addChunks).not.toHaveBeenCalled();
  });

  /**
   * Prüft, dass bei Änderung eines PDF-Anhangs keine erneute Einreihung erfolgt,
   * wenn das übergeordnete Item noch nicht indexiert wurde.
   */
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

  /**
   * Stellt sicher, dass bei Änderung von Metadaten eines regulären Items
   * keine erneute Einreihung in die Warteschlange stattfindet.
   */
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

  /**
   * Überprüft, ob ein bereits indexiertes Paper bei Änderung seines
   * PDF-Anhangs erneut in die Indexierungs-Warteschlange eingereiht wird.
   */
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

  /**
   * Stellt sicher, dass das übergeordnete Item aus dem Index entfernt wird,
   * wenn ein untergeordneter Anhang in den Papierkorb verschoben wird.
   */
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

  /**
   * Überprüft, ob manuell in die Warteschlange eingereihte Paper
   * ordnungsgemäß indexiert werden, inklusive Extraktion und Chunk-Einfügung.
   */
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

  /**
   * Überprüft, ob bei einer vollständigen Bibliotheksindexierung nur die
   * ausgewählten Bibliotheken berücksichtigt werden.
   */
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

  /**
   * Testet die Filterung von Papern im IndexManager anhand der ausgewählten Bibliotheks-IDs.
   */
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

  /**
   * Stellt sicher, dass collectPapers die Item-IDs über getAllIDs abruft
   * und die vollständigen Items anschließend per Batch über getAsync lädt.
   * Damit wird verhindert, dass Items mit ungeladenen Daten
   * verarbeitet werden, wenn eine Bibliothek noch nicht in der Seitenleiste geöffnet wurde.
   */
  it("loads items via getAllIDs and getAsync batch to avoid UnloadedDataException", async () => {
    vi.spyOn(LibraryScopeManager, "listLibraryScopes").mockReturnValue([
      {
        libraryID: 1,
        name: "Library 1",
        type: "user",
        groupID: null,
        editable: true,
        filesEditable: true,
      },
    ]);

    const result = await collectPapers(vectorStore);

    expect(globalThis.Zotero.Items.getAllIDs).toHaveBeenCalledWith(1);
    expect(globalThis.Zotero.Items.getAsync).toHaveBeenCalledWith([101]);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]).toMatchObject({
      itemID: 101,
      title: "Paper 101",
    });
  });

  /**
   * Stellt sicher, dass collectPapers den Titel korrekt anzeigt,
   * auch wenn getField zum Zeitpunkt des ersten Zugriffs eine Exception wirft.
   * Nach dem Laden über getAsync muss der korrekte Titel verfügbar sein.
   */
  it("shows correct title after getAsync load even if item data was initially unloaded", async () => {
    vi.spyOn(LibraryScopeManager, "listLibraryScopes").mockReturnValue([
      {
        libraryID: 1,
        name: "Library 1",
        type: "user",
        groupID: null,
        editable: true,
        filesEditable: true,
      },
    ]);

    const fullyLoadedItem = {
      ...item101,
      getField: vi.fn((field: string) => {
        if (field === "title") return "Vollständig geladener Titel";
        if (field === "year") return "2025";
        return "";
      }),
    };

    vi.mocked(globalThis.Zotero.Items.getAllIDs).mockResolvedValueOnce([101]);
    vi.mocked(globalThis.Zotero.Items.getAsync).mockResolvedValueOnce([
      fullyLoadedItem,
    ]);

    const result = await collectPapers(vectorStore);

    expect(result.papers[0].title).toBe("Vollständig geladener Titel");
    expect(result.papers[0].year).toBe("2025");
  });

  /**
   * Stellt sicher, dass `loadAllData` bei Items nicht aufgerufen wird,
   * da dies modify-Events auslösen würde, die den BackgroundIndexer
   * zu einer unerwünschten Re-Indexierung der gesamten Bibliothek veranlassen.
   */
  it("does not call loadAllData on items to avoid modify event loops", async () => {
    vi.spyOn(LibraryScopeManager, "listLibraryScopes").mockReturnValue([
      {
        libraryID: 1,
        name: "Library 1",
        type: "user",
        groupID: null,
        editable: true,
        filesEditable: true,
      },
    ]);

    const item = {
      ...item101,
      loadAllData: vi.fn(async () => {}),
      getField: vi.fn((field: string) => {
        if (field === "title") return "Test Titel";
        if (field === "year") return "2026";
        return "";
      }),
    };

    vi.mocked(globalThis.Zotero.Items.getAllIDs).mockResolvedValueOnce([101]);
    vi.mocked(globalThis.Zotero.Items.getAsync).mockResolvedValueOnce([item]);

    const result = await collectPapers(vectorStore);

    expect(item.loadAllData).not.toHaveBeenCalled();
    expect(result.papers).toEqual([
      expect.objectContaining({
        itemID: 101,
        title: "Test Titel",
      }),
    ]);
  });

  /**
   * Stellt sicher, dass bei einem Fehler in getAllIDs oder getAsync
   * die betroffene Bibliothek übersprungen wird und die übrigen Paper
   * weiterhin korrekt geladen werden.
   */
  it("skips a library and continues if loading its items fails", async () => {
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

    vi.mocked(globalThis.Zotero.Items.getAllIDs)
      .mockRejectedValueOnce(new Error("Datenbankfehler"))
      .mockResolvedValueOnce([202]);
    vi.mocked(globalThis.Zotero.Items.getAsync).mockResolvedValueOnce([
      item202,
    ]);

    const result = await collectPapers(vectorStore);

    expect(globalThis.Zotero.logError).toHaveBeenCalled();
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].itemID).toBe(202);
  });

  /**
   * Überprüft, ob die Einstellung für den anfänglichen Indexierungsdialog
   * nach der ersten Verwendung gespeichert wird.
   */
  it("stores the initial indexing prompt preference after first use", () => {
    const prefGet = vi.spyOn(globalThis.Zotero.Prefs, "get");
    const prefSet = vi.spyOn(globalThis.Zotero.Prefs, "set");

    prefGet.mockReturnValueOnce(false);
    expect(shouldShowInitialIndexPrompt()).toBe(true);

    markInitialIndexPromptShown();

    expect(prefSet).toHaveBeenCalledWith(
      "extensions.zotero.zaia.initialIndexPromptShown",
      true,
      true,
    );
  });

  /**
   * Testet die Zählung von einzigartigen, nicht indexierten Papern im aktiven Kontext
   * sowie die korrekten Warnmeldungen basierend auf der Anzahl.
   */
  it("counts unique unindexed papers in the active context", () => {
    const references = [
      { itemID: 101 },
      { itemID: 202 },
      { itemID: 202 },
      { itemID: undefined },
    ];

    expect(getUnindexedPaperContextCount(references, new Set(["101"]))).toBe(1);
    expect(getUnindexedPaperContextWarning(1)).toBe(
      "Das Paper im Kontext ist noch nicht indexiert.",
    );
    expect(getUnindexedPaperContextWarning(2)).toBe(
      "2 Paper im Kontext sind noch nicht indexiert.",
    );
  });
});
