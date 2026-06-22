import { vectorStore, type ChunkDocument } from "./OramaService";
import { PdfExtractor } from "./PdfExtractor";
import { chunkPaperText } from "./TextChunker";
import { embeddingProvider } from "../ai/EmbeddingProvider.js";

declare const Zotero: any;

export class BackgroundIndexer {
  private static instance: BackgroundIndexer;
  private observerId: string | null = null;
  
  private queue: number[] = [];
  private isProcessing = false;

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
      "ZAIA_BackgroundIndexer"
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
    extraData: Record<string, any>
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
            Zotero.debug(`[BackgroundIndexer] Error deleting item ${id}: ${err}`);
          });
        }
        break;

      case "trash":

        const deleteImmediately = Zotero.Prefs.get("extensions.zaia.deleteOnTrash") ?? false;

        if (deleteImmediately) {
          for (const id of itemIds) {
            vectorStore.deleteByZoteroItemId(id.toString()).catch((err) => {
              Zotero.debug(`[BackgroundIndexer] Error deleting item ${id}: ${err}`);
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
  private enqueue(itemIds: number[]) {
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

    while (this.queue.length > 0) {
      const itemId = this.queue.shift();
      if (!itemId) continue;

      try {
        await this.indexItem(itemId);
      } catch (error) {
        Zotero.debug(
          `[BackgroundIndexer] Error indexing item ${itemId}: ${error}`
        );
      }
    }

    this.isProcessing = false;
  }

  /**
   * Text extrahieren, chunken, einbetten und speichern.
   */
  private async indexItem(itemId: number) {
    const item = await Zotero.Items.getAsync(itemId);
    if (!item) return;

    if (!item.isAttachment() || item.attachmentContentType !== "application/pdf") {
      if (!item.isRegularItem()) return; 
    }

    Zotero.debug(`[BackgroundIndexer] Starting extraction for item ${item.id}...`);

    const extractedDoc = await PdfExtractor.extractDocument(item);
    if (!extractedDoc || !extractedDoc.pages || extractedDoc.pages.length === 0) {
      Zotero.debug(`[BackgroundIndexer] No text found for item ${item.id}.`);
      return;
    }

    await vectorStore.deleteByZoteroItemId(item.id.toString());

    const chunks = chunkPaperText(extractedDoc.pages);
    
    const oramaChunks: ChunkDocument[] = [];

    for (const chunk of chunks) {
      let embedding: number[];
      try {
        [embedding] = await embeddingProvider.embedTexts([chunk.text], {
          inputType: "passage",
        });
      } catch (embeddingError) {
        Zotero.debug(
          `[BackgroundIndexer] Embedding fehlgeschlagen für Chunk ${chunk.id}, wird übersprungen: ${embeddingError}`
        );
        continue;
      }

      Zotero.debug(`[BackgroundIndexer] Chunk ${chunk.id} embedded successfully! Length of vector: ${embedding ? embedding.length : 'undefined'}`);

      oramaChunks.push({
        id: `doc_${item.id}_${chunk.id}`,
        zoteroItemId: item.id.toString(),
        content: chunk.text,
        pageNumber: chunk.pageStart || 0,
        embedding,
      });
      
      // Heartbeat every 5 chunks to ensure the user sees logs
      if (oramaChunks.length % 5 === 0) {
        Zotero.debug(`[BackgroundIndexer] Heartbeat: Still processing item ${item.id}, ${oramaChunks.length} chunks done...`);
      }
    }

    if (oramaChunks.length > 0) {
      Zotero.debug(`[BackgroundIndexer] Now adding ${oramaChunks.length} chunks to Orama for item ${item.id}...`);
      await vectorStore.addChunks(oramaChunks);
      Zotero.debug(`[BackgroundIndexer] Successfully indexed ${oramaChunks.length} chunks for item ${item.id}.`);
    }
  }
  /**
   * Indexiert alle PDFs aus persönlicher Bibliothek und Gruppenbibliothekan,
   * die noch nicht in Orama vorhanden sind.
   * Bereits indexierte Items werden übersprungen.
   * Diese Methode nur einmalig beim ersten Start der Erweiterung aufgerufen.
   */
  async indexAllLibraryItems(): Promise<void> {
    Zotero.debug("[BackgroundIndexer] Starte Erst-Indexierung der Bibliothek...");

    const allLibraries: any[] = Zotero.Libraries.getAll();
    const allAttachments: Zotero.Item[] = [];

    for (const library of allLibraries) {
      try {
        const items: Zotero.Item[] = await Zotero.Items.getAll(
          library.libraryID,
          false, 
          false, 
          false,  // excludeAttachments = false
        );
        allAttachments.push(...items);
      } catch (err) {
        Zotero.debug(
          `[BackgroundIndexer] Bibliothek ${library.libraryID} konnte nicht gelesen werden: ${err}`,
        );
      }
    }

    const targetItems = allAttachments.filter(
      (item) => item.isRegularItem() || (item.isAttachment() && item.attachmentContentType === "application/pdf" && !item.parentID)
    );

    const msg = `[BackgroundIndexer] ${targetItems.length} unterstützte Einträge (Paper & Standalone PDFs) gefunden. Starte Erst-Indexierung...`;
    Zotero.debug(msg);

    const BATCH_SIZE = 5;
    const BATCH_PAUSE_MS = 300;
    let indexed = 0;
    let skipped = 0;

    for (let i = 0; i < targetItems.length; i += BATCH_SIZE) {
      const batch = targetItems.slice(i, i + BATCH_SIZE);

      for (const item of batch) {
        const idStr = item.id.toString();

        if (await vectorStore.isItemIndexed(idStr)) {
          skipped++;
          continue;
        }

        try {
          await this.indexItem(item.id);
          indexed++;
        } catch (err) {
          Zotero.debug(
            `[BackgroundIndexer] Fehler bei Erst-Indexierung von Item ${item.id}: ${err}`,
          );
        }
      }

      if (i + BATCH_SIZE < targetItems.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    const finishMsg = `[BackgroundIndexer] Erst-Indexierung abgeschlossen: ${indexed} neu indexiert, ${skipped} bereits vorhanden.`;
    Zotero.debug(finishMsg);
  }
}

export const backgroundIndexer = BackgroundIndexer.getInstance();
