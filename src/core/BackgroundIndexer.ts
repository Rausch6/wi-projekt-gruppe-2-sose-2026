import { vectorStore, type ChunkDocument } from "./OramaService";
import { PdfExtractor } from "./PdfExtractor";
import { chunkPaperText, type TextChunk } from "./TextChunker";
import { embeddingProvider } from "../ai/EmbeddingProvider.js";
import { indexingEvents } from "./IndexingEventBus";
import { config } from "../../package.json";

declare const Zotero: any;

export type IndexingState =
  | { status: "idle" }
  | {
      status: "running";
      indexed: number;
      total: number;
      estimatedRemainingMs?: number;
    }
  | { status: "done"; indexed: number; total: number; newlyIndexed: number };

type IndexItemResult = {
  indexed: boolean;
  skipped?: boolean;
  targetId?: number;
  unchanged?: boolean;
};

export class BackgroundIndexer {
  private static instance: BackgroundIndexer;
  private observerId: string | null = null;

  private queue: number[] = [];
  private isProcessing = false;
  private currentlyIndexing = new Set<number>();
  private isSingleMode = true;

  public indexingState: IndexingState = { status: "idle" };

  private constructor() {}

  static getInstance(): BackgroundIndexer {
    if (!BackgroundIndexer.instance) {
      BackgroundIndexer.instance = new BackgroundIndexer();
    }
    return BackgroundIndexer.instance;
  }

  /**
   * Registriert den Notifier bei Zotero, um auf Dateiänderungen zu hören.
   */
  initialize() {
    if (this.observerId) return;
    this.observerId = Zotero.Notifier.registerObserver(
      this,
      ["item"],
      "ZAIA_BackgroundIndexer",
    );
    Zotero.debug("[BackgroundIndexer]: Initialized and listening for events.");
  }

  /**
   * Wird von Zotero aufgerufen, wenn sich Items ändern.
   */
  notify(
    action: string,
    type: string,
    ids: (string | number)[],
    extraData: Record<string, any>,
  ) {
    if (type !== "item") return;

    const itemIds = ids.map((id) => Number(id));

    switch (action) {
      case "add":
      case "modify":
        this.enqueue(itemIds);
        break;

      case "delete":
        for (const id of itemIds) {
          vectorStore.deleteByZoteroItemId(id.toString()).catch((err) => {
            Zotero.debug(
              `[BackgroundIndexer] Error deleting item ${id}: ${err}`,
            );
          });
        }
        break;

      case "trash":
        const deleteImmediately =
          Zotero.Prefs.get("extensions.zaia.deleteOnTrash") ?? false;

        if (deleteImmediately) {
          for (const id of itemIds) {
            vectorStore.deleteByZoteroItemId(id.toString()).catch((err) => {
              Zotero.debug(
                `[BackgroundIndexer] Error deleting item ${id}: ${err}`,
              );
            });
          }
        }
        break;
    }
  }

  /**
   * Fügt Items in die Warteschlange ein und startet die Verarbeitung, falls sie nicht bereits läuft.
   * So wird sichergestellt, dass die items nacheinander verarbeitet werden.
   */
  public enqueue(itemIds: number[]) {
    for (const id of itemIds) {
      if (!this.queue.includes(id)) {
        this.queue.push(id);
      }
    }
    this.processQueue();
  }

  /**
   * Arbeitet die Warteschlange asynchron ab.
   */
  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    indexingEvents.emit("started", { mode: "single" });

    while (this.queue.length > 0) {
      const itemId = this.queue.shift();
      if (!itemId) continue;

      try {
        await this.indexItem(itemId);
      } catch (error) {
        Zotero.debug(
          `[BackgroundIndexer] Error indexing item ${itemId}: ${error}`,
        );
        indexingEvents.emit("error", {
          message: String(error),
          itemID: itemId,
        });
      }
    }

    this.isProcessing = false;
  }
  /**
   * Text extrahieren, chunken, einbetten und speichern.
   * Child-Attachments werden auf den Parent umgeleitet, um Duplikate zu vermeiden.
   */
  private async indexItem(rawItemId: number): Promise<IndexItemResult> {
    let item = await Zotero.Items.getAsync(rawItemId);
    if (!item) return { indexed: false, skipped: true };

    if (item.isNote()) return { indexed: false, skipped: true };

    if (item.isAttachment() && item.parentID) {
      const parentItem = await Zotero.Items.getAsync(item.parentID);
      if (parentItem) {
        item = parentItem;
        Zotero.debug(
          `[BackgroundIndexer] Event für Attachment ${rawItemId} auf Parent ${item.id} umgeleitet.`,
        );
      }
    }

    if (
      !item.isAttachment() ||
      item.attachmentContentType !== "application/pdf"
    ) {
      if (!item.isRegularItem()) return { indexed: false, skipped: true };
    }

    const targetId = item.id;

    if (this.currentlyIndexing.has(targetId)) {
      Zotero.debug(
        `[BackgroundIndexer] Item ${targetId} wird bereits indexiert. Überspringe doppelten Aufruf.`,
      );
      return {
        indexed: vectorStore.getIndexedItemIds().has(targetId.toString()),
        skipped: true,
        targetId,
      };
    }
    this.currentlyIndexing.add(targetId);

    try {
      Zotero.debug(
        `[BackgroundIndexer] Starting extraction for item ${targetId}...`,
      );

      if (this.isSingleMode) {
        let paperTitle: string | undefined;
        try {
          const zItem = await Zotero.Items.getAsync(targetId);
          paperTitle = zItem?.getField("title") || undefined;
        } catch (_e) {
          /* ignore */
        }
        indexingEvents.emit("singleStarted", {
          mode: "single",
          itemID: targetId,
          paperTitle,
        });
      }

      const extractedDoc = await PdfExtractor.extractDocument(item);
      const addon = (globalThis as any).Zotero?.[config.addonInstance] || (globalThis as any).addon;
      const addonSettings = addon?.data?.settings;
      const chunks = extractedDoc?.pages?.length
        ? chunkPaperText(extractedDoc.pages, {
            targetTokens: addonSettings?.chunkTargetTokens,
            overlapTokens: addonSettings?.chunkOverlapTokens,
          })
        : [];

      if (chunks.length === 0) {
        await vectorStore.deleteByZoteroItemId(targetId.toString());
        Zotero.debug(
          `[BackgroundIndexer] No PDF text found for item ${targetId}. Existing vector entries were removed.`,
        );
        this.emitSingleDone(targetId, { skipped: true });
        return { indexed: false, skipped: true, targetId };
      }

      const textHash = this.cyrb53(
        this.createIndexHashSource(chunks),
      ).toString();
      const existingHash = vectorStore.getTextHash(targetId.toString());

      if (existingHash === textHash) {
        Zotero.debug(
          `[BackgroundIndexer] Hash für Item ${targetId} ist unverändert. Überspringe Indexierung.`,
        );
        this.emitSingleDone(targetId, { skipped: true, unchanged: true });
        return { indexed: true, skipped: true, targetId, unchanged: true };
      }

      await vectorStore.deleteByZoteroItemId(targetId.toString());

      const oramaChunks: ChunkDocument[] = [];

      for (const chunk of chunks) {
        let embedding: number[];
        try {
          [embedding] = await embeddingProvider.embedTexts([chunk.text], {
            inputType: "passage",
          });
        } catch (embeddingError) {
          Zotero.debug(
            `[BackgroundIndexer] Embedding fehlgeschlagen für Chunk ${chunk.id}, wird übersprungen: ${embeddingError}`,
          );
          continue;
        }

        Zotero.debug(
          `[BackgroundIndexer] Chunk ${chunk.id} embedded successfully! Length of vector: ${embedding ? embedding.length : "undefined"}`,
        );

        oramaChunks.push({
          id: `doc_${targetId}_${chunk.id}`,
          zoteroItemId: targetId.toString(),
          sourceType: "fulltext",
          content: chunk.text,
          pageNumber: chunk.pageStart || 0,
          embedding,
        });

        // Heartbeat every 5 chunks to ensure the user sees logs
        if (oramaChunks.length % 5 === 0) {
          Zotero.debug(
            `[BackgroundIndexer] Heartbeat: Still processing item ${targetId}, ${oramaChunks.length} chunks done...`,
          );
        }
      }

      if (oramaChunks.length > 0) {
        Zotero.debug(
          `[BackgroundIndexer] Now adding ${oramaChunks.length} chunks to Orama for item ${targetId}...`,
        );
        await vectorStore.addChunks(oramaChunks);
        vectorStore.setTextHash(targetId.toString(), textHash);
        Zotero.debug(
          `[BackgroundIndexer] Successfully indexed ${oramaChunks.length} chunks for item ${targetId}.`,
        );

        if (this.isSingleMode) {
          this.emitSingleDone(targetId);
        }
        return { indexed: true, targetId };
      }
      this.emitSingleDone(targetId, { skipped: true });
      return { indexed: false, skipped: true, targetId };
    } finally {
      this.currentlyIndexing.delete(targetId);
    }
  }

  private async getPaperTitle(itemID: number): Promise<string | undefined> {
    try {
      const zItem = await Zotero.Items.getAsync(itemID);
      return zItem?.getField("title") || undefined;
    } catch (_e) {
      return undefined;
    }
  }

  private emitSingleDone(
    itemID: number,
    options: { skipped?: boolean; unchanged?: boolean } = {},
  ) {
    if (!this.isSingleMode) return;

    this.getPaperTitle(itemID)
      .then((paperTitle) => {
        indexingEvents.emit("singleDone", {
          mode: "single",
          itemID,
          paperTitle,
          skipped: options.skipped,
          unchanged: options.unchanged,
        });
      })
      .catch(() => {
        indexingEvents.emit("singleDone", {
          mode: "single",
          itemID,
          skipped: options.skipped,
          unchanged: options.unchanged,
        });
      });
  }

  private createIndexHashSource(chunks: TextChunk[]) {
    const fulltextSource = chunks
      .map(
        (chunk) =>
          `fulltext:${chunk.id}:${chunk.pageStart ?? ""}:${chunk.pageEnd ?? ""}:${chunk.text}`,
      )
      .join("\n\n");

    return fulltextSource;
  }

  private cyrb53(str: string, seed = 0): number {
    let h1 = 0xdeadbeef ^ seed,
      h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 =
      Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
      Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 =
      Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
      Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  /**
   * Indexiert alle PDFs aus persönlicher Bibliothek und Gruppenbibliothekan,
   * die noch nicht in Orama vorhanden sind.
   * Bereits indexierte Items werden übersprungen.
   * Diese Methode nur einmalig beim ersten Start der Erweiterung aufgerufen.
   */
  async indexAllLibraryItems(): Promise<void> {
    Zotero.debug(
      "[BackgroundIndexer] Starte Erst-Indexierung der Bibliothek...",
    );
    this.isSingleMode = false;
    this.indexingState = { status: "running", indexed: 0, total: 0 };
    indexingEvents.emit("started", { mode: "full" });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const allLibraries: any[] = Zotero.Libraries.getAll();
    const allAttachments: Zotero.Item[] = [];

    for (const library of allLibraries) {
      try {
        const items: Zotero.Item[] = await Zotero.Items.getAll(
          library.libraryID,
          false,
          false,
          false,
        );
        allAttachments.push(...items);
      } catch (err) {
        Zotero.debug(
          `[BackgroundIndexer] Bibliothek ${library.libraryID} konnte nicht gelesen werden: ${err}`,
        );
      }
    }

    const targetItems = allAttachments.filter(
      (item) =>
        item.isRegularItem() ||
        (item.isAttachment() &&
          item.attachmentContentType === "application/pdf" &&
          !item.parentID),
    );

    Zotero.debug(
      `[BackgroundIndexer] ${targetItems.length} unterstützte Einträge gefunden. Prüfe Index-Status...`,
    );

    this.indexingState = {
      status: "running",
      indexed: 0,
      total: targetItems.length,
    };
    indexingEvents.emit("progress", {
      mode: "full",
      indexed: 0,
      total: targetItems.length,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const indexedItemIds = vectorStore.getIndexedItemIds();
    const alreadyIndexedCount = this.countIndexedTargetItems(targetItems);
    const itemsToIndex = targetItems.filter(
      (item) => !indexedItemIds.has(item.id.toString()),
    );

    this.indexingState = {
      status: "running",
      indexed: alreadyIndexedCount,
      total: targetItems.length,
    };
    indexingEvents.emit("progress", {
      mode: "full",
      indexed: alreadyIndexedCount,
      total: targetItems.length,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    let indexedNew = 0;
    let emaMsPerItem = 0;

    for (const item of itemsToIndex) {
      try {
        const startItem = Date.now();
        const wasIndexed = vectorStore
          .getIndexedItemIds()
          .has(item.id.toString());
        await this.indexItem(item.id);
        const isIndexed = vectorStore
          .getIndexedItemIds()
          .has(item.id.toString());
        const itemTime = Date.now() - startItem;

        if (!wasIndexed && isIndexed) {
          indexedNew++;
        }

        if (indexedNew === 1) {
          emaMsPerItem = itemTime;
        } else {
          emaMsPerItem = emaMsPerItem * 0.5 + itemTime * 0.5;
        }

        const remainingItems = itemsToIndex.length - indexedNew;
        const estimatedRemainingMs = emaMsPerItem * remainingItems;

        const currentIndexedCount = this.countIndexedTargetItems(targetItems);

        this.indexingState = {
          status: "running",
          indexed: currentIndexedCount,
          total: targetItems.length,
          estimatedRemainingMs,
        };

        let paperTitle: string | undefined;
        try {
          const zItem = await Zotero.Items.getAsync(item.id);
          paperTitle = zItem?.getField("title") || undefined;
        } catch (_e) {
          /* ignore */
        }

        indexingEvents.emit("progress", {
          mode: "full",
          indexed: currentIndexedCount,
          total: targetItems.length,
          estimatedRemainingMs,
          paperTitle,
        });
      } catch (err) {
        Zotero.debug(
          `[BackgroundIndexer] Fehler bei Erst-Indexierung von Item ${item.id}: ${err}`,
        );
        indexingEvents.emit("error", { message: String(err) });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }

    const finishMsg = `[BackgroundIndexer] Erst-Indexierung abgeschlossen: ${indexedNew} neu indexiert, ${alreadyIndexedCount} bereits vorhanden.`;
    Zotero.debug(finishMsg);

    this.isSingleMode = true;
    const finalIndexedCount = this.countIndexedTargetItems(targetItems);

    this.indexingState = {
      status: "done",
      indexed: finalIndexedCount,
      newlyIndexed: indexedNew,
      total: targetItems.length,
    };
    indexingEvents.emit("finished", {
      mode: "full",
      indexed: finalIndexedCount,
      newlyIndexed: indexedNew,
      total: targetItems.length,
    });
  }

  private countIndexedTargetItems(items: Zotero.Item[]): number {
    const indexedItemIds = vectorStore.getIndexedItemIds();
    return items.filter((item) => indexedItemIds.has(item.id.toString()))
      .length;
  }
}

export const backgroundIndexer = BackgroundIndexer.getInstance();
