/// <reference types="zotero-types" />

import type { ExtractedPaperDocument } from "./PdfExtractor";

declare const Zotero: any;

/**
 * Erzeugt einen Pseudo-Volltext aus reinen Zotero-Metadaten (Titel + Abstract).
 * Wird verwendet, wenn weder PDF noch Snapshot verfügbar ist.
 */
export class MetadataExtractor {
  /**
   * Extrahiert Titel und Abstract eines regulären Zotero-Items als
   * indexierbares Dokument ohne Attachment.
   *
   * Gibt null zurück, wenn weder Titel noch Abstract vorhanden sind –
   * d. h. das Item bietet keinerlei indexierbaren Textinhalt.
   *
   * @param item - Das zu verarbeitende Zotero-Item.
   * @returns Aufbereitetes Dokument oder null, wenn kein Textinhalt vorhanden.
   */
  static async extractDocument(
    item: Zotero.Item,
  ): Promise<ExtractedPaperDocument | null> {
    if (!item.isRegularItem?.()) return null;

    try {
      await item.loadAllData(true);
    } catch (e) {
      Zotero.debug(`ZAIA [MetadataExtractor]: Laden fehlgeschlagen: ${e}`);
    }

    const title = (item.getField("title") as string) || "";
    const abstractNote = (item.getField("abstractNote") as string) || "";

    if (!title && !abstractNote) {
      Zotero.debug(
        `ZAIA [MetadataExtractor]: Item ${item.id} hat weder Titel noch Abstract – übersprungen.`,
      );
      return null;
    }

    const text = [title, abstractNote].filter(Boolean).join("\n\n");

    return {
      item,
      attachment: null,
      title: title || "Ohne Titel",
      creators: (item.getField("firstCreator") as string) || "Unbekannte Autorenschaft",
      year: (item.getField("year") as string) || "",
      pages: [{ page: null, text }],
    };
  }
}
