declare const Zotero: any;
declare namespace Zotero {
  type Item = any;
}

/**
 * Determines whether a Zotero item can appear in the paper index manager.
 *
 * @param item - Zotero item to classify.
 * @returns True for regular items and standalone PDF attachments.
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
 * Reads Zotero's internal deletion flag without querying an invalid field.
 *
 * @param item - Zotero item to inspect.
 * @returns True when Zotero marks the item as deleted.
 */
export function isDeletedItem(item: Zotero.Item): boolean {
  try {
    // item.deleted is the correct internal Zotero property.
    // getField("deleted") is not a valid metadata field and may cause warnings.
    return Boolean(item.deleted);
  } catch {
    return false;
  }
}

/**
 * Ensures item data is loaded and falls back to fetching a fresh Zotero item.
 *
 * @param item - Potentially partially loaded Zotero item.
 * @returns Fully loaded replacement when available, otherwise the original item.
 */
export async function loadItemCompletely(
  item: Zotero.Item,
): Promise<Zotero.Item> {
  try {
    await item.loadAllData?.(true);
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

/**
 * Resolves an item's title, using an attachment filename as a fallback.
 *
 * @param item - Zotero item whose display title is needed.
 * @returns Displayable title or a generic fallback.
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
 * Safely reads a Zotero metadata field.
 *
 * @param item - Zotero item containing the field.
 * @param field - Zotero field name to read.
 * @param fallback - Value returned when the field is empty or inaccessible.
 * @returns String field value or the supplied fallback.
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
 * Formats up to three creator names for an index-manager row.
 *
 * @param item - Zotero item whose creators should be displayed.
 * @returns Comma-separated creator names or a generic fallback.
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
 * Resolves a concise item-type label and normalizes PDF attachments.
 *
 * @param item - Zotero item whose type should be displayed.
 * @returns Item-type label for the index manager.
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
    // Fall through to the generic label.
  }

  return "Eintrag";
}
