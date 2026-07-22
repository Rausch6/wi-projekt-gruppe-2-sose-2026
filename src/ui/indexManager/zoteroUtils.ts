declare const Zotero: any;
declare namespace Zotero {
  type Item = any;
}

/**
 * Prüft, ob ein Zotero-Item für den ZAIA-Index geeignet ist.
 *
 * @param item - Das zu prüfende Zotero-Item.
 * @returns `true`, wenn das Item indexierbar ist, sonst `false`.
 */
export function isIndexableItem(item: Zotero.Item): boolean {
  if (isDeletedItem(item)) {
    return false;
  }

  if (item.isNote?.()) {
    return false;
  }

  if (item.isAttachment?.() && item.parentID) {
    return false;
  }

  if (item.isRegularItem?.()) {
    return true;
  }

  if (
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf"
  ) {
    return true;
  }

  return Boolean(item.isPDFAttachment?.());
}

/**
 * Prüft, ob ein Zotero-Item als gelöscht markiert ist.
 *
 * @param item - Das zu prüfende Zotero-Item.
 * @returns `true`, wenn das Item gelöscht ist, sonst `false`.
 */
export function isDeletedItem(item: Zotero.Item): boolean {
  try {
    return Boolean(item.deleted);
  } catch {
    return false;
  }
}

/**
 * Gibt den Anzeigetitel eines Zotero-Items zurück.
 * Falls kein Titel vorhanden ist, wird der Dateiname als Fallback verwendet.
 *
 * @param item - Das Zotero-Item, dessen Titel ermittelt werden soll.
 * @returns Den Titel des Items oder „Ohne Titel", falls kein Titel verfügbar ist.
 */
export function getItemTitle(item: Zotero.Item): string {
  const title = getItemField(item, "title", "");
  if (title) {
    return title;
  }

  try {
    const filename = item.getFilename?.();
    return filename ? String(filename) : "Ohne Titel";
  } catch {
    return "Ohne Titel";
  }
}

/**
 * Liest ein Metadatenfeld eines Zotero-Items aus.
 * Gibt den angegebenen Fallback-Wert zurück, falls das Feld nicht vorhanden ist
 * oder beim Zugriff eine Exception geworfen wird.
 *
 * @param item - Das Zotero-Item.
 * @param field - Der Name des abzufragenden Metadatenfelds.
 * @param fallback - Rückgabewert, falls das Feld leer oder nicht lesbar ist.
 * @returns Den Feldwert als String oder den Fallback.
 */
export function getItemField(
  item: Zotero.Item,
  field: string,
  fallback: string,
): string {
  try {
    const value = item.getField?.(field);
    return value ? String(value) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Gibt die Autorenliste eines Zotero-Items als formatierten String zurück.
 * Es werden maximal drei Autoren aufgeführt.
 *
 * @param item - Das Zotero-Item, dessen Autoren ermittelt werden sollen.
 * @returns Kommagetrennte Autorennamen oder „Unbekannt", falls keine vorhanden sind.
 */
export function getItemCreators(item: Zotero.Item): string {
  try {
    const creators = item.getCreators?.();
    if (!Array.isArray(creators) || creators.length === 0) {
      return "Unbekannt";
    }

    return creators
      .slice(0, 3)
      .map(
        (creator: any) => creator.lastName || creator.name || creator.firstName,
      )
      .filter(Boolean)
      .join(", ");
  } catch {
    return "Unbekannt";
  }
}

/**
 * Gibt den Typ eines Zotero-Items als lesbaren String zurück.
 *
 * @param item - Das Zotero-Item, dessen Typ ermittelt werden soll.
 * @returns „PDF" bei PDF-Anhängen, den Zotero-Itemtyp bei regulären Items
 *          oder „Eintrag" als generischen Fallback.
 */
export function getItemType(item: Zotero.Item): string {
  if (item.isPDFAttachment?.()) {
    return "PDF";
  }

  if (
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf"
  ) {
    return "PDF";
  }

  try {
    const rawType = item.itemType || item.getField?.("itemType");
    if (rawType) {
      return String(rawType);
    }
  } catch {
    return "Eintrag";
  }

  return "Eintrag";
}
