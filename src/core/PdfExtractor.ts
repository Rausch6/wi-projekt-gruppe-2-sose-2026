/// <reference types="zotero-types" />

/**
 * Eine einzelne Seite aus einem extrahierten PDF-Dokument.
 */
export interface PageTextChunk {
  page: number | null;
  text: string;
}

/**
 * Vollständig aufbereitetes Paper-Dokument mit Metadaten und Seitentext.
 */
export interface ExtractedPaperDocument {
  item: Zotero.Item;
  attachment: Zotero.Item;
  title: string;
  creators: string;
  year: string;
  pages: PageTextChunk[];
}

/**
 * Liest PDF-Text über Zoteros eigenen Volltextindex.
 * Zotero extrahiert und cacht Anhangstext bereits in `.zotero-ft-cache`.
 * Die Wiederverwendung dieses Caches vermeidet eine zweite, inkompatible
 * PDF.js-Runtime.
 */
export class PdfExtractor {
  /**
   * Gibt das erste PDF-Attachment eines Zotero-Items zurück.
   *
   * @param parentItem - Das zu prüfende Zotero-Item.
   * @returns Das PDF-Attachment oder null, wenn keines gefunden wurde.
   */
  static async getPdfAttachment(
    parentItem: Zotero.Item,
  ): Promise<Zotero.Item | null> {
    if (parentItem.isAttachment() && parentItem.attachmentContentType === "application/pdf") {
      return parentItem;
    }

    const regularItem = await resolveRegularItem(parentItem);
    if (!regularItem) return null;

    for (const attachmentID of regularItem.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (
        attachment?.isAttachment() &&
        attachment.attachmentContentType === "application/pdf"
      ) {
        return attachment;
      }
    }

    Zotero.debug("ZAIA: Kein PDF an dieses Item angehängt.");
    return null;
  }

  /**
   * Gibt den lokalen Dateipfad des PDF-Anhangs zurück.
   *
   * @param parentItem - Das übergeordnete Zotero-Item.
   * @returns Absoluter Dateipfad oder null, wenn die Datei nicht lokal vorliegt.
   */
  static async getPdfFilePath(parentItem: Zotero.Item): Promise<string | null> {
    const attachment = await this.getPdfAttachment(parentItem);
    if (!attachment) return null;

    const filePath = await attachment.getFilePathAsync();
    if (!filePath || !(await IOUtils.exists(filePath))) {
      Zotero.debug("ZAIA: Das PDF ist nicht lokal verfügbar.");
      return null;
    }

    return filePath;
  }

  /**
   * Extrahiert Text und Metadaten eines Zotero-Items als strukturiertes Dokument.
   *
   * @param parentItem - Das zu verarbeitende Zotero-Item.
   * @returns Aufbereitetes Dokument mit Seitentext und Metadaten, oder null bei fehlendem Text.
   */
  static async extractDocument(
    parentItem: Zotero.Item,
  ): Promise<ExtractedPaperDocument | null> {
    const attachment = await this.getPdfAttachment(parentItem);
    if (!attachment) return null;

    const item = await resolveRegularItem(parentItem) || attachment;

    try {
      await item.loadAllData(true);
    } catch (e) {
      Zotero.debug(`ZAIA: Item ${item.id} konnte nicht vollständig geladen werden: ${e}`);
    }

    const text = await readZoteroFullText(attachment);
    if (!text.trim()) {
      Zotero.debug(
        "ZAIA: Zotero konnte keinen Text aus dem PDF extrahieren. " +
          "Möglicherweise ist OCR erforderlich.",
      );
      return null;
    }

    return {
      item,
      attachment,
      title: item.getField("title") || "Ohne Titel",
      creators: item.getField("firstCreator") || "Unbekannte Autorenschaft",
      year: item.getField("year") || "",
      pages: splitIntoPages(text),
    };
  }

  /**
   * Gibt den strukturierten Seitentext eines Zotero-Items zurück.
   *
   * @param parentItem - Das zu verarbeitende Zotero-Item.
   * @returns Liste von Seiten-Chunks oder null, wenn kein Text extrahierbar ist.
   */
  static async getStructuredText(
    parentItem: Zotero.Item,
  ): Promise<PageTextChunk[] | null> {
    return (await this.extractDocument(parentItem))?.pages ?? null;
  }

  /**
   * Gibt den vollständigen Volltext eines Zotero-Items als zusammengeführten String zurück.
   *
   * @param parentItem - Das zu verarbeitende Zotero-Item.
   * @returns Volltext aller Seiten oder null, wenn kein Text extrahierbar ist.
   */
  static async extractText(parentItem: Zotero.Item): Promise<string | null> {
    const pages = await this.getStructuredText(parentItem);
    if (!pages?.length) return null;

    return pages.map((page) => page.text).join("\n\n");
  }
}

/**
 * Liest den Volltext eines Anhangs aus dem Zotero-Volltextcache.
 * Löst bei fehlendem Cache zunächst eine Neuindexierung durch Zotero aus.
 *
 * @param attachment - Das PDF-Attachment.
 * @returns Extrahierter Volltext oder leerer String bei Fehler.
 */
async function readZoteroFullText(attachment: Zotero.Item) {
  let text = await readFullTextCache(attachment);
  if (text) return text;

  try {
    await Zotero.Fulltext.indexItems(attachment.id, {
      complete: true,
      ignoreErrors: false,
    });
    text = await readFullTextCache(attachment);
  } catch (error) {
    Zotero.debug(`ZAIA: Zotero-Volltextindexierung fehlgeschlagen: ${error}`);
  }

  return text ?? "";
}

/**
 * Liest den gecachten Volltext eines Anhangs aus der `.zotero-ft-cache`-Datei.
 *
 * @param attachment - Das PDF-Attachment.
 * @returns Gecachter Volltext oder null, wenn kein Cache vorhanden ist.
 */
async function readFullTextCache(attachment: Zotero.Item) {
  const cacheFile = Zotero.Fulltext.getItemCacheFile(attachment);
  if (!cacheFile?.path || !(await IOUtils.exists(cacheFile.path))) {
    return null;
  }

  try {
    const contents = await Zotero.File.getContentsAsync(
      cacheFile.path,
      "utf-8",
    );
    return typeof contents === "string" ? contents : null;
  } catch (error) {
    Zotero.debug(`ZAIA: Volltextcache konnte nicht gelesen werden: ${error}`);
    return null;
  }
}

/**
 * Löst ein Zotero-Item zu seinem regulären Parent-Item auf.
 * Gibt bei Attachments das übergeordnete reguläre Item zurück.
 *
 * @param item - Das aufzulösende Zotero-Item.
 * @returns Das reguläre Item oder null, wenn keines gefunden wurde.
 */
async function resolveRegularItem(item: Zotero.Item) {
  if (item.isRegularItem()) return item;
  if (!item.isAttachment() || !item.parentID) return null;

  const parent = await Zotero.Items.getAsync(item.parentID);
  return parent?.isRegularItem() ? parent : null;
}

/**
 * Teilt einen Volltext anhand von Seitenumbrüchen (Form-Feed-Zeichen) in Seiten auf.
 *
 * @param text - Der aufzuteilende Volltext.
 * @returns Liste von Seiten-Chunks mit Seitennummer und Text.
 */
function splitIntoPages(text: string): PageTextChunk[] {
  const rawPages = text.includes("\f") ? text.split(/\f+/) : [text];

  return rawPages
    .map((pageText, index) => ({
      page: rawPages.length > 1 ? index + 1 : null,
      text: pageText.trim(),
    }))
    .filter((page) => page.text);
}
