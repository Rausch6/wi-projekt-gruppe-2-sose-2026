import { VECTOR_SIZE, vectorStore, type ChunkDocument } from "./OramaService";
import { PdfExtractor } from "./PdfExtractor";
import { chunkPaperText, type TextChunk } from "./TextChunker";
import { embeddingProvider } from "../ai/EmbeddingProvider.js";
import { indexingEvents } from "./IndexingEventBus";
import {
  createAbortController,
  createWindowAbortController,
} from "../utils/AbortController";
import { config } from "../../package.json";
import { LibraryScopeManager } from "./LibraryScopeManager";
import { EmbeddingSearchService } from "./EmbeddingSearchService";

declare const Zotero: any;

export type IndexingState =
  | { status: "idle" }
  | {
      status: "running";
      indexed: number;
      total: number;
      estimatedRemainingMs?: number;
    }
  | { status: "done"; indexed: number; total: number; newlyIndexed: number }
  | { status: "aborted"; indexed: number; total: number; newlyIndexed: number };

type IndexItemResult = {
  indexed: boolean;
  skipped?: boolean;
  targetId?: number;
  unchanged?: boolean;
};

export type IndexAllLibraryItemsOptions = {
  libraryIDs?: number[];
  rebuild?: boolean;
};

export class BackgroundIndexer {
  private static instance: BackgroundIndexer;
  private observerId: string | null = null;

  private queue: number[] = [];
  private pendingModifications = new Set<number>();
  private isProcessing = false;
  private currentlyIndexing = new Set<number>();
  private isSingleMode = true;
  private abortController: AbortController | null = null;
  private activeRunMode: "single" | "full" | null = null;

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
        Zotero.debug(
          `[BackgroundIndexer] ${action}-Event ignoriert; automatische Indexierung ist deaktiviert.`,
        );
        break;

      case "modify":
        void this.handleModifyEvent(itemIds);
        break;

      case "delete":
        void this.deleteItemsFromIndex(itemIds, extraData);
        break;

      case "trash":
        void this.deleteItemsFromIndex(itemIds, extraData);
        break;
    }
  }

  /**
   * Indexiert bereits indexierte Paper automatisch neu, wenn ihr PDF-Anhang
   * geändert wurde (z. B. Datei ersetzt). Reine Metadaten-Edits am Eltern-Item
   * (Tags, Collections, ...) lösen bewusst keine Extraktion aus.
   */
  private async handleModifyEvent(itemIds: number[]) {
    const targetIds = new Set<number>();

    for (const itemId of itemIds) {
      const targetId = await this.resolveReindexTargetId(itemId);
      if (targetId !== null) targetIds.add(targetId);
    }

    if (targetIds.size === 0) return;

    const indexedItemIds = vectorStore.getIndexedItemIds();
    const idsToReindex = [...targetIds].filter((id) =>
      indexedItemIds.has(id.toString()),
    );
    if (idsToReindex.length === 0) return;

    try {
      this.enqueue(idsToReindex);
    } catch (err: any) {
      if (this.isFullIndexRunning()) {
        Zotero.debug(
          `[BackgroundIndexer] Voll-Indexierung läuft. Modifikation wird zwischengespeichert.`,
        );
        idsToReindex.forEach((id) => this.pendingModifications.add(id));
      } else {
        Zotero.debug(
          `[BackgroundIndexer] Automatische Re-Indexierung konnte nicht gestartet werden: ${err}`,
        );
      }
    }
  }

  private async resolveReindexTargetId(itemId: number): Promise<number | null> {
    try {
      const item = await Zotero.Items.getAsync(itemId);
      if (
        !item?.isAttachment?.() ||
        item.attachmentContentType !== "application/pdf"
      ) {
        return null;
      }
      return item.parentID ? Number(item.parentID) : Number(item.id);
    } catch {
      return null;
    }
  }

  private async deleteItemsFromIndex(
    itemIds: number[],
    extraData: Record<string, any>,
  ) {
    const targetIds = new Set<number>();

    for (const itemId of itemIds) {
      const targetId = await this.resolveIndexTargetIdForRemoval(
        itemId,
        extraData,
      );
      if (Number.isFinite(targetId)) targetIds.add(targetId);
    }

    try {
      await vectorStore.deleteByZoteroItemIds(targetIds);
    } catch (err) {
      Zotero.debug(
        `[BackgroundIndexer] Error deleting items from index: ${err}`,
      );
    }
  }

  private async resolveIndexTargetIdForRemoval(
    itemId: number,
    extraData: Record<string, any>,
  ) {
    try {
      const item = await Zotero.Items.getAsync(itemId);
      if (item?.isAttachment?.() && item.parentID) return Number(item.parentID);
      if (item?.id) return Number(item.id);
    } catch {
      // Deleted items may no longer be loadable; fall back to notifier metadata.
    }

    const parentID = getNotifierParentID(itemId, extraData);
    return parentID ?? itemId;
  }

  /**
   * Fügt Items in die Warteschlange ein und startet die Verarbeitung, falls sie nicht bereits läuft.
   * So wird sichergestellt, dass die items nacheinander verarbeitet werden.
   */
  public enqueue(itemIds: number[]) {
    if (this.activeRunMode === "full") {
      throw new Error("Eine vollständige Indexierung läuft bereits.");
    }

    for (const id of itemIds.filter(Number.isFinite)) {
      if (!this.queue.includes(id)) {
        this.queue.push(id);
      }
    }
    void this.processQueue();
  }

  /**
   * Bricht die laufende Indexierung ab.
   */
  public abort() {
    this.abortController?.abort();
  }

  /**
   * Gibt an, ob gerade eine vollständige Bibliotheks-Indexierung läuft.
   * Wird von der UI genutzt, um konkurrierende Aktionen zu sperren.
   */
  public isFullIndexRunning(): boolean {
    return this.activeRunMode === "full";
  }

  /**
   * Erzeugt einen AbortController, dessen Signal aus demselben Fenster-Global
   * stammt wie das später aufgerufene fetch() - Gecko lehnt ein AbortSignal
   * aus einem anderen Global ab ("'signal' member of RequestInit does not
   * implement interface AbortSignal").
   */
  private createIndexingAbortController(): AbortController {
    try {
      const win = Zotero.getMainWindow();
      if (win) return createWindowAbortController(win);
    } catch {
      // Kein Hauptfenster verfügbar; auf den generischen Controller zurückfallen.
    }
    return createAbortController();
  }

  /**
   * Arbeitet die Warteschlange asynchron ab.
   */
  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    if (this.activeRunMode && this.activeRunMode !== "single") return;

    this.isProcessing = true;
    this.activeRunMode = "single";
    this.isSingleMode = true;
    this.abortController = this.createIndexingAbortController();
    indexingEvents.emit("started", { mode: "single" });

    let itemsProcessed = 0;
    let newlyIndexed = 0;
    let emaMsPerItem = 0;
    let wasAborted = false;

    this.indexingState = {
      status: "running",
      indexed: 0,
      total: this.queue.length,
    };

    try {
      while (this.queue.length > 0) {
        const itemId = this.queue.shift();
        if (!itemId) continue;

        try {
          const startItem = Date.now();
          const result = await this.indexItem(itemId, {
            signal: this.abortController.signal,
          });
          const itemTime = Date.now() - startItem;

          itemsProcessed++;
          if (result.indexed && !result.skipped) newlyIndexed++;

          if (itemsProcessed === 1) {
            emaMsPerItem = itemTime;
          } else {
            emaMsPerItem = emaMsPerItem * 0.5 + itemTime * 0.5;
          }

          const remainingItems = this.queue.length;
          const currentTotal = itemsProcessed + remainingItems;
          const estimatedRemainingMs = emaMsPerItem * remainingItems;

          this.indexingState = {
            status: "running",
            indexed: itemsProcessed,
            total: currentTotal,
            estimatedRemainingMs,
          };

          indexingEvents.emit("progress", {
            mode: "single",
            indexed: itemsProcessed,
            total: currentTotal,
            estimatedRemainingMs,
          });
        } catch (error: any) {
          if (error?.name === "AbortError") {
            Zotero.debug(
              "[BackgroundIndexer] Einzel-Indexierung durch Nutzer abgebrochen.",
            );
            this.queue = [];
            wasAborted = true;
            break;
          }
          let paperTitle: string | undefined;
          try {
            const zItem = await Zotero.Items.getAsync(itemId);
            paperTitle = zItem?._loaded === false ? undefined : zItem?.getField("title") || undefined;
          } catch {}
          const errorMsg = `[BackgroundIndexer] Error indexing item ${itemId} ("${paperTitle || "Unbekannt"}"): ${error}`;
          Zotero.debug(errorMsg);
          if (error instanceof Error) {
            Zotero.logError(new Error(`${errorMsg}\nOriginal: ${error.message}`));
          } else {
            Zotero.logError(new Error(errorMsg));
          }
          indexingEvents.emit("error", {
            message: String(error),
            itemID: itemId,
            paperTitle
          });
        }
      }
    } finally {
      this.indexingState = {
        status: wasAborted ? "aborted" : "done",
        indexed: itemsProcessed,
        newlyIndexed,
        total: itemsProcessed,
      };
      
      if (wasAborted) {
        indexingEvents.emit("aborted", {
          mode: "single",
          indexed: itemsProcessed,
          newlyIndexed,
          total: itemsProcessed,
        });
      }

      this.isProcessing = false;
      this.activeRunMode = null;
      this.abortController = null;
    }
  }
  /**
   * Text extrahieren, chunken, einbetten und speichern.
   * Child-Attachments werden auf den Parent umgeleitet, um Duplikate zu vermeiden.
   */
  private async indexItem(
    itemId: number,
    options?: { signal?: AbortSignal },
  ): Promise<IndexItemResult> {
    if (this.currentlyIndexing.has(itemId)) {
      return {
        indexed: vectorStore.getIndexedItemIds().has(itemId.toString()),
        skipped: true,
      };
    }
    this.currentlyIndexing.add(itemId);

    try {
      if (options?.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");

      let item = await Zotero.Items.getAsync(itemId);
      if (!item) return { indexed: false, skipped: true };

      if (item.isNote()) return { indexed: false, skipped: true };

      if (item.isAttachment() && item.parentID) {
        const parentItem = await Zotero.Items.getAsync(item.parentID);
        if (parentItem) {
          item = parentItem;
          Zotero.debug(
            `[BackgroundIndexer] Event für Attachment ${itemId} auf Parent ${item.id} umgeleitet.`,
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

      Zotero.debug(
        `[BackgroundIndexer] Starting extraction for item ${targetId}...`,
      );

      if (this.isSingleMode) {
        let paperTitle: string | undefined;
        try {
          const zItem = await Zotero.Items.getAsync(targetId);
          paperTitle = zItem?._loaded === false ? undefined : zItem?.getField("title") || undefined;
        } catch (_e) {
          /* ignore */
        }
        indexingEvents.emit("singleStarted", {
          mode: "single",
          itemID: targetId,
          paperTitle,
        });
      }

      if (options?.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");

      const extractedDoc = await PdfExtractor.extractDocument(item);
      const addon =
        (globalThis as any).Zotero?.[config.addonInstance] ||
        (globalThis as any).addon;
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
        if (options?.signal?.aborted)
          throw new DOMException("Aborted", "AbortError");

        let embedding: number[] = Array(VECTOR_SIZE).fill(0);
        if (EmbeddingSearchService.isEnabled()) {
          let retryCount = 0;
          const maxRetries = 2;

          while (retryCount <= maxRetries) {
            try {
              [embedding] = await embeddingProvider.embedTexts([chunk.text], {
                inputType: "passage",
                timeout: 20_000,
                signal: options?.signal,
              });
              break;
            } catch (err: any) {
              if (options?.signal?.aborted) throw err;
              if (retryCount >= maxRetries) throw err;
              retryCount++;
              Zotero.debug(
                `[BackgroundIndexer] Retry ${retryCount} for chunk ${chunk.id}`,
              );
            }
          }

          Zotero.debug(
            `[BackgroundIndexer] Chunk ${chunk.id} embedded successfully!`,
          );
        }

        oramaChunks.push({
          id: `doc_${targetId}_${chunk.id}`,
          zoteroItemId: targetId.toString(),
          sourceType: "fulltext",
          content: chunk.text,
          pageNumber: chunk.pageStart || 0,
          embedding,
        });
      }

      if (oramaChunks.length > 0) {
        vectorStore.markAsIndexing(targetId.toString(), textHash);
        await vectorStore.addChunks(oramaChunks);
        vectorStore.markAsIndexed(targetId.toString());

        if (this.isSingleMode) {
          this.emitSingleDone(targetId);
        }
        return { indexed: true, targetId };
      }
      this.emitSingleDone(targetId, { skipped: true });
      return { indexed: false, skipped: true, targetId };
    } finally {
      this.currentlyIndexing.delete(itemId);
    }
  }

  private async getPaperTitle(itemID: number): Promise<string | undefined> {
    try {
      const zItem = await Zotero.Items.getAsync(itemID);
      // getSafeTitle() already includes the _loaded guard, unlike a direct getField() call.
      return this.getSafeTitle(zItem) || undefined;
    } catch (_e) {
      return undefined;
    }
  }

  private getSafeTitle(item: any): string | undefined {
    if (item._loaded === false) return undefined;
    try {
      return item.getField?.("title") || undefined;
    } catch {
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

    return `${EmbeddingSearchService.isEnabled() ? "embedding" : "keyword"}\n${fulltextSource}`;
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
  async indexAllLibraryItems(
    options: IndexAllLibraryItemsOptions = {},
  ): Promise<{ newlyIndexed: number; alreadyIndexed: number; total: number }> {
    if (this.activeRunMode) {
      throw new Error("Es läuft bereits eine Indexierung.");
    }

    Zotero.debug("[BackgroundIndexer] Starte Bibliotheks-Indexierung...");
    this.activeRunMode = "full";
    this.isSingleMode = false;
    this.abortController = this.createIndexingAbortController();
    this.indexingState = { status: "running", indexed: 0, total: 0 };
    indexingEvents.emit("started", { mode: "full" });

    let targetItems: Zotero.Item[] = [];
    let indexedNew = 0;
    let alreadyIndexedCount = 0;

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const libraryIDs = this.resolveLibraryIDs(options.libraryIDs);
      targetItems = await this.collectTargetItems(libraryIDs);

      Zotero.debug(
        `[BackgroundIndexer] ${targetItems.length} unterstützte Einträge in ${libraryIDs.length} Bibliothek(en) gefunden.`,
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

      if (options.rebuild && targetItems.length) {
        await vectorStore.deleteByZoteroItemIds(
          targetItems.map((item) => item.id),
        );
      }

      const indexedItemIds = vectorStore.getIndexedItemIds();
      alreadyIndexedCount = options.rebuild
        ? 0
        : this.countIndexedTargetItems(targetItems);
      const itemsToIndex = options.rebuild
        ? targetItems
        : targetItems.filter((item) => !indexedItemIds.has(item.id.toString()));

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

      let processedItems = 0;
      let emaMsPerItem = 0;
      let wasAborted = false;

      for (const item of itemsToIndex) {
        try {
          const startItem = Date.now();
          const result = await this.indexItem(item.id, {
            signal: this.abortController.signal,
          });
          const itemTime = Date.now() - startItem;
          processedItems++;

          if (result.indexed && !result.skipped) {
            indexedNew++;
          }

          if (processedItems === 1) {
            emaMsPerItem = itemTime;
          } else {
            emaMsPerItem = emaMsPerItem * 0.5 + itemTime * 0.5;
          }

          const remainingItems = itemsToIndex.length - processedItems;
          const estimatedRemainingMs = emaMsPerItem * remainingItems;
          const currentIndexedCount = alreadyIndexedCount + indexedNew;
          this.indexingState = {
            status: "running",
            indexed: currentIndexedCount,
            total: targetItems.length,
            estimatedRemainingMs,
          };

          indexingEvents.emit("progress", {
            mode: "full",
            indexed: currentIndexedCount,
            total: targetItems.length,
            estimatedRemainingMs,
            paperTitle: this.getSafeTitle(item),
          });
        } catch (err: any) {
          if (err?.name === "AbortError") {
            Zotero.debug(
              "[BackgroundIndexer] Bibliotheks-Indexierung durch Nutzer abgebrochen.",
            );
            wasAborted = true;
            break;
          }
          const paperTitle = this.getSafeTitle(item);
          const errorMsg = `[BackgroundIndexer] Error in batch processing for item ${item.id} ("${paperTitle || "Unbekannt"}"): ${err}`;
          Zotero.debug(errorMsg);
          if (err instanceof Error) {
            Zotero.logError(new Error(`${errorMsg}\nOriginal: ${err.message}`));
          } else {
            Zotero.logError(new Error(errorMsg));
          }
          indexingEvents.emit("error", {
            message: String(err),
            itemID: item.id,
            paperTitle
          });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
      }

      const finalIndexedCount = alreadyIndexedCount + indexedNew;
      Zotero.debug(
        `[BackgroundIndexer] Bibliotheks-Indexierung ${wasAborted ? "abgebrochen" : "abgeschlossen"}: ${indexedNew} neu indexiert, ${alreadyIndexedCount} bereits vorhanden.`,
      );

      this.indexingState = {
        status: wasAborted ? "aborted" : "done",
        indexed: finalIndexedCount,
        newlyIndexed: indexedNew,
        total: targetItems.length,
      };
      
      if (wasAborted) {
        indexingEvents.emit("aborted", {
          mode: "full",
          indexed: finalIndexedCount,
          newlyIndexed: indexedNew,
          total: targetItems.length,
        });
      } else {
        indexingEvents.emit("finished", {
          mode: "full",
          indexed: finalIndexedCount,
          newlyIndexed: indexedNew,
          total: targetItems.length,
        });
      }

      return {
        newlyIndexed: indexedNew,
        alreadyIndexed: alreadyIndexedCount,
        total: targetItems.length,
      };
    } finally {
      this.isSingleMode = true;
      this.activeRunMode = null;
      this.abortController = null;

      if (this.pendingModifications.size > 0) {
        const pendingIds = Array.from(this.pendingModifications);
        this.pendingModifications.clear();
        Zotero.debug(
          `[BackgroundIndexer] Starte ${pendingIds.length} ausstehende Re-Indexierungen nach Voll-Indexierung...`,
        );
        setTimeout(() => {
          try {
            this.enqueue(pendingIds);
          } catch (e) {
            Zotero.debug(`[BackgroundIndexer] Fehler beim Starten der ausstehenden Indexierungen: ${e}`);
          }
        }, 500);
      }
    }
  }

  private countIndexedTargetItems(items: Zotero.Item[]): number {
    const indexedItemIds = vectorStore.getIndexedItemIds();
    return items.filter((item) => indexedItemIds.has(item.id.toString()))
      .length;
  }

  private resolveLibraryIDs(libraryIDs?: number[]) {
    const availableLibraryIDs = LibraryScopeManager.listLibraryScopes().map(
      (scope) => scope.libraryID,
    );
    if (!libraryIDs?.length) return availableLibraryIDs;

    const allowedLibraryIDs = new Set(availableLibraryIDs);
    return [...new Set(libraryIDs.filter(Number.isFinite))].filter(
      (libraryID) => allowedLibraryIDs.has(libraryID),
    );
  }

  private async collectTargetItems(libraryIDs: number[]) {
    const targetItems: Zotero.Item[] = [];

    for (const libraryID of libraryIDs) {
      try {
        const items: Zotero.Item[] = await Zotero.Items.getAll(
          libraryID,
          false,
          false,
          false,
        );
        targetItems.push(...items.filter(isIndexableTargetItem));
      } catch (err) {
        Zotero.debug(
          `[BackgroundIndexer] Bibliothek ${libraryID} konnte nicht gelesen werden: ${err}`,
        );
      }
    }

    return targetItems;
  }
}

export const backgroundIndexer = BackgroundIndexer.getInstance();

function isIndexableTargetItem(item: Zotero.Item) {
  if (!item || isDeleted(item)) return false;
  if (item.isNote?.()) return false;
  if (item.isAttachment?.() && item.parentID) return false;
  if (item.isRegularItem?.()) return true;
  return Boolean(
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf" &&
    !item.parentID,
  );
}

function isDeleted(item: Zotero.Item) {
  try {
    const isUnloaded = (item as any)._loaded === false;
    return Boolean(
      (item as Zotero.Item & { deleted?: boolean }).deleted ??
      (isUnloaded ? false : item.getField("deleted")),
    );
  } catch {
    return false;
  }
}

function getNotifierParentID(
  itemId: number,
  extraData: Record<string, any>,
): number | null {
  const candidates = [
    extraData?.[itemId],
    extraData?.[String(itemId)],
    extraData,
  ];

  for (const candidate of candidates) {
    const parentID = readParentID(candidate);
    if (parentID !== null) return parentID;
  }

  return null;
}

function readParentID(value: any): number | null {
  if (!value || typeof value !== "object") return null;

  const parentID =
    value.parentID ??
    value.parentItemID ??
    value.old?.parentID ??
    value.old?.parentItemID ??
    value.item?.parentID;
  const parsed = Number(parentID);
  return Number.isFinite(parsed) ? parsed : null;
}
