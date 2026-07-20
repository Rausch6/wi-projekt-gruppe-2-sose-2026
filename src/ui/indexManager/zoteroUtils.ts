declare const Zotero: any;
declare namespace Zotero {
  type Item = any;
}

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

export function isDeletedItem(item: Zotero.Item): boolean {
  try {
    // item.deleted is the correct internal Zotero property.
    // getField("deleted") is not a valid metadata field and may cause warnings.
    return Boolean(item.deleted);
  } catch {
    return false;
  }
}

export async function loadItemCompletely(
  item: Zotero.Item,
): Promise<Zotero.Item> {
  try {
    // WICHTIG: Wir rufen hier absichtlich NICHT `item.loadAllData(true)` auf.
    // Ein massenhafter Aufruf von loadAllData() für alle Items der Bibliothek 
    // zwingt Zotero dazu, für jedes einzelne Paper ein "modify"-Event abzufeuern.
    // Dies würde den BackgroundIndexer fluten und Zotero sowie die GPU komplett blockieren,
    // da fälschlicherweise eine komplette Re-Indexierung der Bibliothek getriggert wird.
    return item;
  } catch (error) {
    try {
      return (await Zotero.Items.getAsync(item.id)) ?? item;
    } catch (reloadError) {
      Zotero.debug(
        `ZAIA: Item ${item.id} konnte für den Index Manager nicht vollständig geladen werden: ${reloadError || error}`,
      );
      return item;
    }
  }
}

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
    // Fall through to the generic label.
  }

  return "Eintrag";
}
