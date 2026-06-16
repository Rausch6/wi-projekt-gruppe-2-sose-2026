import { vectorStore, type ChunkDocument } from "./OramaService";
import { PdfExtractor } from "./PdfExtractor";
import { chunkPaperText } from "./TextChunker";

declare const Zotero: any;

export class BackgroundIndexer {
  private static instance: BackgroundIndexer;
  private observerId: string | null = null;
  
  // Warteschlange für die Indexierung
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
    if (this.observerId) return; // Bereits registriert

    // Kontrolle auf Hinzufügen, Ändern und Löschen von Items/PDFs
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
        // Neue oder veränderte Items zur Warteschlange hinzufügen
        this.enqueue(itemIds);
        break;

      case "delete":
        // Beim Löschen sofort aus der Datenbank entfernen
        for (const id of itemIds) {
          // IDs sind bei Zotero Numbers, Orama erwartet Strings
          vectorStore.deleteByZoteroItemId(id.toString()).catch((err) => {
            Zotero.debug(`[BackgroundIndexer] Error deleting item ${id}: ${err}`);
          });
        }
        break;

      case "trash":
        // Wir lesen aus den Zotero-Einstellungen aus, was der Nutzer bevorzugt
        // Standardmäßig (false) löschen wir nicht sofort
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
   * Fügt Items in die Warteschlange ein und startet die Verarbeitung, falls sie nicht läuft.
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
   * Der Kernprozess: Text extrahieren, chunken, einbetten und speichern.
   */
  private async indexItem(itemId: number) {
    const item = await Zotero.Items.getAsync(itemId);
    if (!item) return;

    // Nur PDFs verarbeiten; Prüfen, ob attachment pdf ist
    if (!item.isAttachment() || item.attachmentContentType !== "application/pdf") {
      if (!item.isRegularItem()) return; 
    }

    Zotero.debug(`[BackgroundIndexer] Starting extraction for item ${item.id}...`);

    // Text extrahieren
    const extractedDoc = await PdfExtractor.extractDocument(item);
    if (!extractedDoc || !extractedDoc.pages || extractedDoc.pages.length === 0) {
      Zotero.debug(`[BackgroundIndexer] No text found for item ${item.id}.`);
      return;
    }

    // Falls das Item bereits in der Datenbank ist, löschen wir die alten Chunks
    await vectorStore.deleteByZoteroItemId(item.id.toString());

    // Chunken
    const chunks = chunkPaperText(extractedDoc.pages);
    
    // Vektorisieren & Formatieren für Orama
    const oramaChunks: ChunkDocument[] = [];
    
    for (const chunk of chunks) {
      // TODO: Embeddingmodell aufrufen
      // Dummy-Array, damit der Rest funktioniert.
      const dummyEmbedding = new Array(768).fill(0.1); 

      oramaChunks.push({
        id: `doc_${item.id}_${chunk.id}`, // Eindeutige ID
        zoteroItemId: item.id.toString(),
        content: chunk.text,
        pageNumber: chunk.pageStart || 0,
        embedding: dummyEmbedding, // TODO: Hier das tatsächliche Embedding einfügen
      });
    }

    // In Orama speichern
    if (oramaChunks.length > 0) {
      await vectorStore.addChunks(oramaChunks);
      Zotero.debug(`[BackgroundIndexer] Successfully indexed ${oramaChunks.length} chunks for item ${item.id}.`);
    }
  }
}

export const backgroundIndexer = BackgroundIndexer.getInstance();
