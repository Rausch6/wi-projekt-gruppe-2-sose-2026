import { VECTOR_SIZE, vectorStore, type ChunkDocument } from "./OramaService";
import { DocumentExtractor } from "./DocumentExtractor";
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

/**
 * Zustandsdarstellung des Indexierungsprozesses.
 */
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

/**
 * Ergebnis der Indexierung eines einzelnen Items.
 */
type IndexItemResult = {
  indexed: boolean;
  skipped?: boolean;
  targetId?: number;
  unchanged?: boolean;
};

/**
 * Optionen für die Bibliotheks-Indexierung.
 */
export type IndexAllLibraryItemsOptions = {
  libraryIDs?: number[];
  rebuild?: boolean;
};

/**
 * Koordiniert die Hintergrundindexierung von Zotero-Items.
 * Verarbeitet Items über eine Warteschlange, reagiert auf Zotero-Events
 * (Hinzufügen, Ändern, Löschen) und unterstützt sowohl Einzel- als auch
 * Vollbibliotheks-Indexierung.
 */
export class BackgroundIndexer {
  private static instance: BackgroundIndexer;
  private observerId: string | null = null;

  private queue: number[] = [];
  private pendingModifications = new Set<number>();
  private isProcessing = false;
  private currentlyIndexing = new Set<number>();
  private abortController: AbortController | null = null;
  private activeRunMode: "single" | "full" | null = null;

  /** Aktueller Zustand der laufenden oder abgeschlossenen Indexierung. */
  public indexingState: IndexingState = { status: "idle" };

  private constructor() {}

  /**
   * Gibt die Singleton-Instanz des BackgroundIndexers zurück.
   *
   * @returns Die einzige Instanz des BackgroundIndexers.
   */
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
    Zotero.debug("[BackgroundIndexer]: Initialisiert und wartet auf Ereignisse.");
  }

  /**
   * Wird von Zotero aufgerufen, wenn sich Items ändern.
   *
   * @param action - Art der Änderung (add, modify, delete, trash).
   * @param type - Typ des betroffenen Objekts (nur "item" wird verarbeitet).
   * @param ids - IDs der betroffenen Items.
   * @param extraData - Zusatzdaten des Notifiers (z. B. Parent-IDs gelöschter Items).
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
   *
   * @param itemIds - IDs der geänderten Items.
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

  /**
   * Ermittelt die Zotero-Item-ID, die bei einer Änderung neu indexiert werden soll.
   * Bei PDF-Attachments wird auf das Parent-Item umgeleitet.
   *
   * @param itemId - ID des geänderten Items.
   * @returns Ziel-Item-ID für die Re-Indexierung oder null, wenn keine Indexierung nötig ist.
   */
  private async resolveReindexTargetId(itemId: number): Promise<number | null> {
    const INDEXABLE_ATTACHMENT_TYPES = ["application/pdf", "text/html", "text/plain"];
    try {
      const item = await Zotero.Items.getAsync(itemId);
      if (
        !item?.isAttachment?.() ||
        !INDEXABLE_ATTACHMENT_TYPES.includes(item.attachmentContentType)
      ) {
        return null;
      }
      return item.parentID ? Number(item.parentID) : Number(item.id);
    } catch {
      return null;
    }
  }

  /**
   * Löscht Zotero-Items aus dem Vektorindex, wenn sie in Zotero gelöscht oder in den Papierkorb verschoben wurden.
   *
   * @param itemIds - IDs der zu löschenden Items.
   * @param extraData - Notifier-Metadaten zur Ermittlung von Parent-IDs gelöschter Attachments.
   */
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
        `[BackgroundIndexer] Fehler beim Löschen von Items aus dem Index: ${err}`,
      );
    }
  }

  /**
   * Ermittelt die Ziel-Item-ID für das Löschen aus dem Index.
   * Nutzt Notifier-Metadaten als Fallback, wenn das gelöschte Item nicht mehr ladbar ist.
   *
   * @param itemId - ID des zu löschenden Items.
   * @param extraData - Notifier-Metadaten mit Parent-ID-Information.
   * @returns Ziel-ID für die Löschoperation.
   */
  private async resolveIndexTargetIdForRemoval(
    itemId: number,
    extraData: Record<string, any>,
  ) {
    try {
      const item = await Zotero.Items.getAsync(itemId);
      if (item?.isAttachment?.() && item.parentID) return Number(item.parentID);
      if (item?.id) return Number(item.id);
    } catch {

    }

    const parentID = getNotifierParentID(itemId, extraData);
    return parentID ?? itemId;
  }

  /**
   * Fügt Items in die Warteschlange ein und startet die Verarbeitung, falls sie nicht bereits läuft.
   * Stellt sicher, dass Items nacheinander und ohne Duplikate verarbeitet werden.
   *
   * @param itemIds - IDs der zu indexierenden Items.
   * @throws Fehler, wenn eine Vollbibliotheks-Indexierung bereits läuft.
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
   *
   * @returns True, wenn gerade eine Vollindexierung aktiv ist.
   */
  public isFullIndexRunning(): boolean {
    return this.activeRunMode === "full";
  }

  /**
   * Erzeugt einen AbortController, dessen Signal aus demselben Fenster-Global
   * stammt wie das später aufgerufene fetch(). Gecko lehnt ein AbortSignal
   * aus einem anderen Global ab.
   *
   * @returns AbortController aus dem Hauptfenster oder generischer Fallback.
   */
  private createIndexingAbortController(): AbortController {
    try {
      const win = Zotero.getMainWindow();
      if (win) return createWindowAbortController(win);
    } catch {
      
    }
    return createAbortController();
  }

  /**
   * Arbeitet die Warteschlange asynchron ab.
   * Emittiert Fortschritts- und Abschlussereignisse über den IndexingEventBus.
   */
  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    if (this.activeRunMode && this.activeRunMode !== "single") return;

    this.isProcessing = true;
    this.activeRunMode = "single";
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
          const paperTitle = await this.getPaperTitle(itemId);
          const errorMsg = `[BackgroundIndexer] Fehler beim Indexieren von Item ${itemId} ("${paperTitle || "Unbekannt"}"): ${error}`;
          Zotero.debug(errorMsg);
          if (error instanceof Error) {
            Zotero.logError(new Error(`${errorMsg}\nOriginal: ${error.message}`));
          } else {
            Zotero.logError(new Error(errorMsg));
          }
          indexingEvents.emit("error", {
            message: String(error),
            itemID: itemId,
            paperTitle,
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
   * Koordiniert die Indexierung eines einzelnen Zotero-Items.
   * Delegiert Validierung, Embedding-Berechnung und Chunk-Aufbau an dedizierte Hilfsmethoden.
   * Schützt gegen Parallelverarbeitung desselben Items über ein Deduplizierungs-Set.
   *
   * @param itemId - ID des zu indexierenden Zotero-Items.
   * @param options - Optionales AbortSignal für vorzeitigen Abbruch.
   * @returns Ergebnis der Indexierung mit Indexierungsstatus und Ziel-Item-ID.
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

      const item = await this.resolveTargetItem(itemId);
      if (!item) return { indexed: false, skipped: true };

      const targetId = item.id;

      Zotero.debug(`[BackgroundIndexer] Starte Extraktion für Item ${targetId}...`);

      if (this.activeRunMode !== "full") {
        indexingEvents.emit("singleStarted", {
          mode: "single",
          itemID: targetId,
          paperTitle: this.getSafeTitle(item),
        });
      }

      if (options?.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");

      const extractedDoc = await DocumentExtractor.extractDocument(item);
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
        if (vectorStore.hasIndexRecord(targetId.toString())) {
          await vectorStore.deleteByZoteroItemId(targetId.toString());
        }
        Zotero.debug(
          `[BackgroundIndexer] Kein PDF-Text für Item ${targetId} gefunden. Vorhandene Vektoreinträge wurden entfernt.`,
        );
        this.emitSingleDone(targetId, { skipped: true });
        return { indexed: false, skipped: true, targetId };
      }

      const textHash = this.cyrb53(this.createIndexHashSource(chunks)).toString();
      const existingHash = vectorStore.getTextHash(targetId.toString());

      if (existingHash === textHash) {
        Zotero.debug(
          `[BackgroundIndexer] Hash für Item ${targetId} ist unverändert. Überspringe Indexierung.`,
        );
        this.emitSingleDone(targetId, { skipped: true, unchanged: true });
        return { indexed: true, skipped: true, targetId, unchanged: true };
      }

      if (vectorStore.hasIndexRecord(targetId.toString())) {
        await vectorStore.deleteByZoteroItemId(targetId.toString());
      }

      const allEmbeddings = await this.computeEmbeddings(targetId, chunks, options?.signal);
      const oramaChunks = this.buildChunkDocuments(targetId, chunks, allEmbeddings);

      if (oramaChunks.length > 0) {
        vectorStore.markAsIndexing(targetId.toString(), textHash);
        try {
          await vectorStore.addChunks(oramaChunks);
          vectorStore.markAsIndexed(targetId.toString());
        } catch (err) {
          vectorStore.deleteIndexRecord(targetId.toString());
          throw err;
        }

        if (this.activeRunMode !== "full") {
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

  /**
   * Lädt und validiert ein Zotero-Item für die Indexierung.
   * Leitet Attachment-Events auf das übergeordnete Parent-Item um.
   * Gibt null zurück, wenn das Item übersprungen werden soll (Notiz, ungültiger Typ).
   *
   * @param itemId - ID des zu ladenden Zotero-Items.
   * @returns Validiertes Zotero-Item oder null, wenn das Item nicht indexiert werden soll.
   */
  private async resolveTargetItem(itemId: number): Promise<any | null> {
    let item = await Zotero.Items.getAsync(itemId);
    if (!item) return null;
    if (item.isNote()) return null;

    if (item.isAttachment() && item.parentID) {
      const parentItem = await Zotero.Items.getAsync(item.parentID);
      if (parentItem) {
        Zotero.debug(
          `[BackgroundIndexer] Event für Attachment ${itemId} auf Parent ${parentItem.id} umgeleitet.`,
        );
        item = parentItem;
      }
    }

    if (!item.isAttachment() || item.attachmentContentType !== "application/pdf") {
      if (!item.isRegularItem()) return null;
    }

    return item;
  }

  /**
   * Berechnet Embedding-Vektoren für alle Chunks eines Items in Batches.
   * Wiederholt fehlgeschlagene Batches bis zu zweimal, bevor ein Fehler weitergeleitet wird.
   * Gibt Nullvektoren zurück, wenn der Embedding-Dienst deaktiviert ist.
   *
   * @param targetId - ID des zu indexierenden Zotero-Items (für Logging).
   * @param chunks - Die zu embeddenden Text-Chunks.
   * @param signal - Optionales AbortSignal für vorzeitigen Abbruch.
   * @returns Matrix der Embedding-Vektoren in Chunk-Reihenfolge.
   */
  private async computeEmbeddings(
    targetId: number,
    chunks: TextChunk[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (!EmbeddingSearchService.isEnabled() || chunks.length === 0) {
      return chunks.map(() => Array(VECTOR_SIZE).fill(0));
    }

    const MAX_BATCH_SIZE = 20;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < chunks.length; i += MAX_BATCH_SIZE) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const batchChunks = chunks.slice(i, i + MAX_BATCH_SIZE);
      const texts = batchChunks.map((c) => c.text);
      let batchEmbeddings: number[][] = batchChunks.map(() => Array(VECTOR_SIZE).fill(0));

      const maxRetries = 2;
      let retryCount = 0;

      while (retryCount <= maxRetries) {
        try {
          batchEmbeddings = await embeddingProvider.embedTexts(texts, {
            inputType: "passage",
            timeout: 120_000,
            signal,
          });
          break;
        } catch (err: any) {
          if (signal?.aborted) throw err;
          if (retryCount >= maxRetries) throw err;
          retryCount++;
          Zotero.debug(
            `[BackgroundIndexer] Wiederholung ${retryCount} für Chunk-Batch ${
              Math.floor(i / MAX_BATCH_SIZE) + 1
            } von Item ${targetId}`,
          );
        }
      }

      allEmbeddings.push(...batchEmbeddings);
      Zotero.debug(
        `[BackgroundIndexer] Batch ${
          Math.floor(i / MAX_BATCH_SIZE) + 1
        } für Item ${targetId} erfolgreich eingebettet.`,
      );
    }

    if (allEmbeddings.length !== chunks.length) {
      throw new Error(
        `[BackgroundIndexer] computeEmbeddings hat ${allEmbeddings.length} Vektoren ` +
        `für ${chunks.length} Chunks erzeugt (Item ${targetId}).`,
      );
    }

    return allEmbeddings;
  }

  /**
   * Erzeugt die Chunk-Dokumente für die Vektordatenbank aus Chunks und ihren Embeddings.
   *
   * @param targetId - ID des Zotero-Items, dem die Chunks zugeordnet werden.
   * @param chunks - Die Text-Chunks des Papers.
   * @param embeddings - Embedding-Vektoren in gleicher Reihenfolge wie die Chunks.
   * @returns Liste von Chunk-Dokumenten, die in Orama gespeichert werden können.
   */
  private buildChunkDocuments(
    targetId: number,
    chunks: TextChunk[],
    embeddings: number[][],
  ): ChunkDocument[] {
    
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `[BackgroundIndexer] Embedding-Längen-Mismatch für Item ${targetId}: ` +
        `${chunks.length} Chunks, aber ${embeddings.length} Embeddings erhalten.`,
      );
    }

    return chunks.map((chunk, i) => ({
      id: `doc_${targetId}_${chunk.id}`,
      zoteroItemId: targetId.toString(),
      sourceType: "fulltext" as const,
      content: chunk.text,
      pageNumber: chunk.pageStart || 0,
      embedding: embeddings[i],
    }));
  }

  /**
   * Lädt den Titel eines Zotero-Items asynchron.
   *
   * @param itemID - Die Zotero-Item-ID.
   * @returns Titel des Items oder undefined bei Fehler oder nicht geladenem Item.
   */
  private async getPaperTitle(itemID: number): Promise<string | undefined> {
    try {
      const zItem = await Zotero.Items.getAsync(itemID);
      return this.getSafeTitle(zItem) || undefined;
    } catch (_e) {
      return undefined;
    }
  }

  /**
   * Liest den Titel eines Zotero-Items ohne Fehlerrisiko.
   * Gibt undefined zurück, wenn das Item nicht geladen ist oder kein Titel vorhanden ist.
   *
   * @param item - Das Zotero-Item.
   * @returns Titel des Items oder undefined.
   */
  private getSafeTitle(item: any): string | undefined {
    if (item._loaded === false) return undefined;
    try {
      return item.getField?.("title") || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Emittiert das `singleDone`-Ereignis nach der Indexierung eines einzelnen Items.
   * Wird bei einer Vollbibliotheks-Indexierung bewusst nicht aufgerufen.
   *
   * @param itemID - Die Zotero-Item-ID des indexierten Items.
   * @param options - Optionale Flags für übersprungene oder unveränderte Items.
   */
  private emitSingleDone(
    itemID: number,
    options: { skipped?: boolean; unchanged?: boolean } = {},
  ) {
    if (this.activeRunMode === "full") return;

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

  /**
   * Erstellt die Eingabe für den Texthash, der zur Änderungserkennung genutzt wird.
   * Berücksichtigt den Suchmodus (Embedding vs. Keyword), damit ein Wechsel des Modus
   * eine Re-Indexierung auslöst.
   *
   * @param chunks - Die Text-Chunks des Papers.
   * @returns Zusammengefasster String als Hash-Eingabe.
   */
  private createIndexHashSource(chunks: TextChunk[]) {
    const fulltextSource = chunks
      .map(
        (chunk) =>
          `fulltext:${chunk.id}:${chunk.pageStart ?? ""}:${chunk.pageEnd ?? ""}:${chunk.text}`,
      )
      .join("\n\n");

    return `${EmbeddingSearchService.isEnabled() ? "embedding" : "keyword"}\n${fulltextSource}`;
  }

  /**
   * Berechnet einen 53-Bit-Hash (cyrb53) für einen gegebenen String.
   * Wird zur Inhaltsänderungserkennung bei der Indexierung verwendet.
   *
   * @param str - Der zu hashende String.
   * @param seed - Optionaler Startwert für den Hash (Standard: 0).
   * @returns 53-Bit-Hash als Zahl.
   */
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
   * Indexiert alle unterstützten Items der angegebenen Bibliotheken.
   * Unterstützt optionalen Neuaufbau (rebuild) aller vorhandenen Einträge.
   *
   * @param options - Optionale Bibliotheks-IDs und Rebuild-Flag.
   * @returns Statistik der Indexierung (neu indexiert, bereits vorhanden, gesamt).
   * @throws Fehler, wenn bereits eine Indexierung läuft.
   */
  async indexAllLibraryItems(
    options: IndexAllLibraryItemsOptions = {},
  ): Promise<{ newlyIndexed: number; alreadyIndexed: number; total: number }> {
    if (this.activeRunMode) {
      throw new Error("Es läuft bereits eine Indexierung.");
    }

    Zotero.debug("[BackgroundIndexer] Starte Bibliotheks-Indexierung...");
    this.activeRunMode = "full";
    this.abortController = this.createIndexingAbortController();
    this.indexingState = { status: "running", indexed: 0, total: 0 };
    indexingEvents.emit("started", { mode: "full" });

    let targetItems: Zotero.Item[] = [];
    let indexedNew = 0;
    let alreadyIndexedCount = 0;

    try {
      vectorStore.suspendSave();
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
      let skippedNoTextCount = 0;

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
          } else if (result.skipped && !result.unchanged) {
            skippedNoTextCount++;
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
          const errorMsg = `[BackgroundIndexer] Fehler bei der Batch-Verarbeitung von Item ${item.id} ("${paperTitle || "Unbekannt"}"): ${err}`;
          Zotero.debug(errorMsg);
          if (err instanceof Error) {
            Zotero.logError(new Error(`${errorMsg}\nOriginal: ${err.message}`));
          } else {
            Zotero.logError(new Error(errorMsg));
          }
          indexingEvents.emit("error", {
            message: String(err),
            itemID: item.id,
            paperTitle,
          });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
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
          skippedCount: skippedNoTextCount,
        });
      } else {
        indexingEvents.emit("finished", {
          mode: "full",
          indexed: finalIndexedCount,
          newlyIndexed: indexedNew,
          total: targetItems.length,
          skippedCount: skippedNoTextCount,
        });
      }

      return {
        newlyIndexed: indexedNew,
        alreadyIndexed: alreadyIndexedCount,
        total: targetItems.length,
      };
    } finally {
      await vectorStore.resumeSave();
      await vectorStore.forceSave();

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

  /**
   * Zählt die bereits indizierten Items aus einer Liste von Ziel-Items.
   *
   * @param items - Liste der Ziel-Items.
   * @returns Anzahl der bereits indizierten Items.
   */
  private countIndexedTargetItems(items: Zotero.Item[]): number {
    const indexedItemIds = vectorStore.getIndexedItemIds();
    return items.filter((item) => indexedItemIds.has(item.id.toString()))
      .length;
  }

  /**
   * Ermittelt die zu verwendenden Bibliotheks-IDs.
   * Filtert ungültige IDs und beschränkt auf tatsächlich verfügbare Bibliotheken.
   *
   * @param libraryIDs - Optionale Liste gewünschter Bibliotheks-IDs.
   * @returns Gefilterte und validierte Liste der Bibliotheks-IDs.
   */
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

  /**
   * Sammelt alle indizierbaren Items aus den angegebenen Bibliotheken.
   *
   * @param libraryIDs - IDs der zu durchsuchenden Bibliotheken.
   * @returns Flache Liste aller indizierbaren Items.
   */
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

/**
 * Prüft, ob ein Zotero-Item für die Indexierung geeignet ist.
 * Schließt Notizen, Kind-Attachments und gelöschte Items aus.
 *
 * @param item - Das zu prüfende Zotero-Item.
 * @returns True, wenn das Item indexiert werden soll.
 */
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

/**
 * Prüft, ob ein Zotero-Item als gelöscht markiert ist.
 *
 * @param item - Das zu prüfende Zotero-Item.
 * @returns True, wenn das Item gelöscht ist.
 */
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

/**
 * Liest die Parent-Item-ID eines gelöschten Items aus den Notifier-Metadaten.
 *
 * @param itemId - Die ID des gelöschten Items.
 * @param extraData - Notifier-Metadaten.
 * @returns Parent-ID oder null, wenn keine gefunden wurde.
 */
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

/**
 * Liest eine Parent-Item-ID aus einem beliebigen Notifier-Metadaten-Objekt.
 *
 * @param value - Das zu durchsuchende Metadaten-Objekt.
 * @returns Parent-ID als Zahl oder null, wenn keine valide ID gefunden wurde.
 */
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
