/// <reference types="zotero-types" />

import type { ExtractedPaperDocument, PageTextChunk } from "./PdfExtractor";

declare const Zotero: any;
declare const IOUtils: any;

/**
 * MIME-Typen, die als Snapshot-Attachments erkannt werden.
 */
const SNAPSHOT_CONTENT_TYPES = ["text/html", "text/plain"] as const;

/**
 * Liest Text aus HTML- und Text-Snapshot-Attachments über Zoteros Volltext-Cache.
 * Analog zu PdfExtractor, aber für nicht-PDF-Anhänge.
 */
export class SnapshotExtractor {
  /**
   * Gibt das erste HTML- oder Text-Attachment eines Zotero-Items zurück.
   *
   * @param parentItem - Das zu prüfende Zotero-Item.
   * @returns Das Snapshot-Attachment oder null, wenn keines gefunden wurde.
   */
  static async getSnapshotAttachment(
    parentItem: Zotero.Item,
  ): Promise<Zotero.Item | null> {
    if (
      parentItem.isAttachment?.() &&
      SNAPSHOT_CONTENT_TYPES.includes(
        parentItem.attachmentContentType as (typeof SNAPSHOT_CONTENT_TYPES)[number],
      )
    ) {
      return parentItem;
    }

    const regularItem = await resolveRegularItem(parentItem);
    if (!regularItem) return null;

    for (const attachmentID of regularItem.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (
        attachment?.isAttachment?.() &&
        SNAPSHOT_CONTENT_TYPES.includes(
          attachment.attachmentContentType as (typeof SNAPSHOT_CONTENT_TYPES)[number],
        )
      ) {
        return attachment;
      }
    }

    Zotero.debug("ZAIA [SnapshotExtractor]: Kein HTML/Text-Snapshot gefunden.");
    return null;
  }

  /**
   * Extrahiert Text und Metadaten eines Zotero-Items über den Zotero-Volltext-Cache.
   * HTML-Snapshots haben keine Seitennummerierung (pageStart/pageEnd = null).
   *
   * @param parentItem - Das zu verarbeitende Zotero-Item.
   * @returns Aufbereitetes Dokument oder null, wenn kein Text extrahierbar ist.
   */
  static async extractDocument(
    parentItem: Zotero.Item,
  ): Promise<ExtractedPaperDocument | null> {
    const attachment = await this.getSnapshotAttachment(parentItem);
    if (!attachment) return null;

    const item = (await resolveRegularItem(parentItem)) ?? attachment;

    try {
      await item.loadAllData(true);
    } catch (e) {
      Zotero.debug(`ZAIA [SnapshotExtractor]: Laden fehlgeschlagen: ${e}`);
    }

    const text = await readZoteroSnapshotFullText(attachment);
    if (!text.trim()) {
      Zotero.debug(
        "ZAIA [SnapshotExtractor]: Kein Text im Zotero-Cache für diesen Snapshot.",
      );
      return null;
    }

    const pages: PageTextChunk[] = [{ page: null, text }];

    return {
      item,
      attachment,
      title: item.getField("title") || "Ohne Titel",
      creators: item.getField("firstCreator") || "Unbekannte Autorenschaft",
      year: item.getField("year") || "",
      pages,
    };
  }
}

/**
 * Liest den Volltext eines Snapshot-Attachments aus dem Zotero-Cache.
 * Löst bei fehlendem Cache eine Neuindexierung durch Zotero aus.
 *
 * @param attachment - Das Snapshot-Attachment.
 * @returns Extrahierter Volltext oder leerer String bei Fehler.
 */
async function readZoteroSnapshotFullText(attachment: Zotero.Item) {
  let text = await readFullTextCache(attachment);
  if (text) return text;

  try {
    await Zotero.Fulltext.indexItems(attachment.id, {
      complete: true,
      ignoreErrors: false,
    });
    text = await readFullTextCache(attachment);
  } catch (error) {
    Zotero.debug(
      `ZAIA [SnapshotExtractor]: Cache-Indexierung fehlgeschlagen: ${error}`,
    );
  }

  return text ?? "";
}

/**
 * Liest den gecachten Volltext eines Attachments aus der `.zotero-ft-cache`-Datei.
 *
 * @param attachment - Das Snapshot-Attachment.
 * @returns Gecachter Volltext oder null, wenn kein Cache vorhanden ist.
 */
async function readFullTextCache(attachment: Zotero.Item): Promise<string | null> {
  const cacheFile = Zotero.Fulltext.getItemCacheFile(attachment);
  if (!cacheFile?.path || !(await IOUtils.exists(cacheFile.path))) {
    return null;
  }

  try {
    const contents = await Zotero.File.getContentsAsync(cacheFile.path, "utf-8");
    return typeof contents === "string" ? contents : null;
  } catch (error) {
    Zotero.debug(
      `ZAIA [SnapshotExtractor]: Cache lesen fehlgeschlagen: ${error}`,
    );
    return null;
  }
}

/**
 * Löst ein Zotero-Item zu seinem regulären Parent-Item auf.
 *
 * @param item - Das aufzulösende Zotero-Item.
 * @returns Das reguläre Item oder null.
 */
async function resolveRegularItem(
  item: Zotero.Item,
): Promise<Zotero.Item | null> {
  if (item.isRegularItem?.()) return item;
  if (!item.isAttachment?.() || !item.parentID) return null;

  const parent = await Zotero.Items.getAsync(item.parentID);
  return parent?.isRegularItem?.() ? parent : null;
}
