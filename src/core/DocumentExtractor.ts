/// <reference types="zotero-types" />

import { PdfExtractor, type ExtractedPaperDocument } from "./PdfExtractor";
import { SnapshotExtractor } from "./SnapshotExtractor";
import { MetadataExtractor } from "./MetadataExtractor";

declare const Zotero: any;

/**
 * Zentraler Einstiegspunkt für die Textextraktion aus Zotero-Items.
 *
 * Versucht Text in dieser Prioritätsreihenfolge zu extrahieren:
 *   1. PDF-Attachment (via PdfExtractor)
 *   2. HTML- oder Text-Snapshot (via SnapshotExtractor, Zotero-Cache)
 *   3. Metadaten-only – Titel + Abstract (via MetadataExtractor)
 *
 * Gibt null zurück, wenn keiner der Pfade erfolgreich war.
 */
export class DocumentExtractor {
  /**
   * Extrahiert Text und Metadaten aus einem Zotero-Item über den
   * am besten geeigneten Extraktionspfad.
   *
   * @param item - Das zu verarbeitende Zotero-Item.
   * @returns Aufbereitetes Dokument oder null, wenn kein Text extrahierbar ist.
   */
  static async extractDocument(
    item: Zotero.Item,
  ): Promise<ExtractedPaperDocument | null> {
    const pdfDoc = await PdfExtractor.extractDocument(item);
    if (pdfDoc) {
      Zotero.debug(
        `ZAIA [DocumentExtractor]: Item ${item.id} via PDF extrahiert.`,
      );
      return pdfDoc;
    }

    const snapshotDoc = await SnapshotExtractor.extractDocument(item);
    if (snapshotDoc) {
      Zotero.debug(
        `ZAIA [DocumentExtractor]: Item ${item.id} via Snapshot extrahiert.`,
      );
      return snapshotDoc;
    }

    const metaDoc = await MetadataExtractor.extractDocument(item);
    if (metaDoc) {
      Zotero.debug(
        `ZAIA [DocumentExtractor]: Item ${item.id} via Metadaten-Fallback extrahiert.`,
      );
      return metaDoc;
    }

    Zotero.debug(
      `ZAIA [DocumentExtractor]: Kein Text für Item ${item.id} extrahierbar.`,
    );
    return null;
  }
}
