/// <reference types="zotero-types" />

export interface PageTextChunk {
  page: number | null;
  text: string;
}

export interface ExtractedPaperDocument {
  item: Zotero.Item;
  attachment: Zotero.Item;
  title: string;
  creators: string;
  year: string;
  pages: PageTextChunk[];
}

/**
 * Reads PDF text through Zotero's own full-text index.
 *
 * Zotero already extracts and caches attachment text in `.zotero-ft-cache`.
 * Reusing that cache avoids shipping a second, incompatible PDF.js runtime.
 */
export class PdfExtractor {
  static async getPdfAttachment(
    parentItem: Zotero.Item,
  ): Promise<Zotero.Item | null> {
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

  static async extractDocument(
    parentItem: Zotero.Item,
  ): Promise<ExtractedPaperDocument | null> {
    const item = await resolveRegularItem(parentItem);
    if (!item) return null;

    const attachment = await this.getPdfAttachment(item);
    if (!attachment) return null;

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

  static async getStructuredText(
    parentItem: Zotero.Item,
  ): Promise<PageTextChunk[] | null> {
    return (await this.extractDocument(parentItem))?.pages ?? null;
  }

  static async extractText(parentItem: Zotero.Item): Promise<string | null> {
    const pages = await this.getStructuredText(parentItem);
    if (!pages?.length) return null;

    return pages.map((page) => page.text).join("\n\n");
  }
}

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

async function resolveRegularItem(item: Zotero.Item) {
  if (item.isRegularItem()) return item;
  if (!item.isAttachment() || !item.parentID) return null;

  const parent = await Zotero.Items.getAsync(item.parentID);
  return parent?.isRegularItem() ? parent : null;
}

function splitIntoPages(text: string): PageTextChunk[] {
  const rawPages = text.includes("\f") ? text.split(/\f+/) : [text];

  return rawPages
    .map((pageText, index) => ({
      page: rawPages.length > 1 ? index + 1 : null,
      text: pageText.trim(),
    }))
    .filter((page) => page.text);
}
