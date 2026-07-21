/// <reference types="zotero-types" />

import { ItemManager } from "./ItemManager";

/**
 * Identifies whether a Zotero library scope belongs to the user or to a group.
 */
export type LibraryScopeType = "user" | "group";

/**
 * Describes a Zotero library that can be used as a RAG indexing scope.
 */
export interface LibraryScope {
  /**
   * Zotero library identifier.
   */
  libraryID: number;

  /**
   * Type of Zotero library.
   */
  type: LibraryScopeType;

  /**
   * Human-readable library name.
   */
  name: string;

  /**
   * Zotero group identifier for group libraries, or null for the user library.
   */
  groupID: number | null;

  /**
   * Indicates whether items in the library can be edited.
   */
  editable: boolean;

  /**
   * Indicates whether files in the library can be edited.
   */
  filesEditable: boolean;
}

/**
 * Contains metadata for a Zotero item that can be offered for RAG indexing.
 */
export interface RagItemCandidate {
  /**
   * Library scope that owns the item.
   */
  library: LibraryScope;

  /**
   * Zotero item identifier.
   */
  itemID: number;

  /**
   * Zotero item key.
   */
  itemKey: string;

  /**
   * Best available title for display and retrieval context.
   */
  title: string;

  /**
   * Semicolon-separated creator names.
   */
  creators: string;

  /**
   * Publication year, if available.
   */
  year: string;

  /**
   * Publication date, if available.
   */
  publicationDate: string;

  /**
   * Publication title, journal, or container title, if available.
   */
  publicationTitle: string;

  /**
   * Publisher name, if available.
   */
  publisher: string;

  /**
   * DOI value, if available.
   */
  doi: string;

  /**
   * ISBN value, if available.
   */
  isbn: string;

  /**
   * URL value, if available.
   */
  url: string;

  /**
   * Abstract text, if available.
   */
  abstractNote: string;

  /**
   * Zotero date-added value.
   */
  dateAdded: string;

  /**
   * Zotero date-modified value.
   */
  dateModified: string;

  /**
   * Zotero item type name.
   */
  itemType: string;

  /**
   * Tag names assigned to the item.
   */
  tags: string[];

  /**
   * Zotero collection identifiers containing the item.
   */
  collectionIDs: number[];
}

/**
 * Configures how RAG item candidates are loaded from a Zotero library.
 */
export interface LibraryItemQuery {
  /**
   * Zotero library identifier to query.
   */
  libraryID: number;

  /**
   * Optional maximum number of candidates to return.
   */
  limit?: number;

  /**
   * Includes regular items without PDF attachments when set to true.
   */
  includeWithoutPdf?: boolean;
}

/**
 * Provides helpers for resolving Zotero libraries and RAG-indexable item candidates.
 */
export class LibraryScopeManager {
  /**
   * Lists available Zotero library scopes.
   *
   * @param options - Optional flags for scope discovery.
   * @returns Library scopes sorted by their display name.
   */
  static listLibraryScopes(options: { includeUserLibrary?: boolean } = {}) {
    const includeUserLibrary = options.includeUserLibrary ?? true;
    const scopes: LibraryScope[] = [];

    if (includeUserLibrary) {
      const userLibraryID = Zotero.Libraries.userLibraryID;
      scopes.push(createLibraryScope(userLibraryID));
    }

    for (const group of Zotero.Groups.getAll()) {
      if (typeof group.libraryID !== "number") continue;
      scopes.push(createLibraryScope(group.libraryID));
    }

    return scopes.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Resolves a single Zotero library scope by library ID.
   *
   * @param libraryID - Zotero library identifier.
   * @returns Library scope metadata for the requested library.
   */
  static getLibraryScope(libraryID: number) {
    return createLibraryScope(libraryID);
  }

  /**
   * Resolves the current Zotero selection to a library scope.
   *
   * @returns Selected library scope, or null when no scope can be determined.
   */
  static getSelectedLibraryScope(): LibraryScope | null {
    const item = ItemManager.filterItems()[0];
    if (item) return createLibraryScope(item.libraryID);

    const selectedLibraryID = getSelectedLibraryID();
    return selectedLibraryID ? createLibraryScope(selectedLibraryID) : null;
  }

  /**
   * Loads RAG item candidates from a Zotero library.
   *
   * @param query - Library query options controlling scope, limit, and PDF filtering.
   * @returns Promise resolving to RAG item candidates for the requested library.
   */
  static async listRagItemCandidates(query: LibraryItemQuery) {
    const scope = createLibraryScope(query.libraryID);
    const itemIDs = await Zotero.Items.getAllIDs(query.libraryID);
    const candidates: RagItemCandidate[] = [];
    const limit = normalizeLimit(query.limit);

    for (const itemID of itemIDs) {
      if (limit && candidates.length >= limit) break;

      const item = await loadItemCompletely(
        await Zotero.Items.getAsync(itemID),
      );
      if (!isIndexableRegularItem(item)) continue;
      if (!query.includeWithoutPdf && !(await hasPdfAttachment(item))) continue;

      candidates.push(await createRagItemCandidate(scope, item));
    }

    return candidates;
  }
}

/**
 * Builds normalized library scope metadata from a Zotero library ID.
 *
 * @param libraryID - Zotero library identifier.
 * @returns Library scope metadata for the given library.
 */
function createLibraryScope(libraryID: number): LibraryScope {
  const type = Zotero.Libraries.isGroupLibrary(libraryID) ? "group" : "user";

  return {
    libraryID,
    type,
    name: Zotero.Libraries.getName(libraryID),
    groupID:
      type === "group"
        ? Zotero.Groups.getGroupIDFromLibraryID(libraryID)
        : null,
    editable: Zotero.Libraries.isEditable(libraryID),
    filesEditable: Zotero.Libraries.isFilesEditable(libraryID),
  };
}

/**
 * Attempts to read the currently selected Zotero library ID from available panes.
 *
 * @returns Selected Zotero library ID, or null when no pane exposes one.
 */
function getSelectedLibraryID() {
  for (const pane of getCandidateZoteroPanes()) {
    try {
      const selectedGroup = pane.getSelectedGroup?.(true);
      if (typeof selectedGroup === "number") {
        const libraryID = Zotero.Groups.getLibraryIDFromGroupID(selectedGroup);
        if (typeof libraryID === "number") return libraryID;
      }
    } catch {}
  }

  return null;
}

/**
 * Collects Zotero panes that may expose the active library selection.
 *
 * @returns Candidate Zotero panes without duplicates.
 */
function getCandidateZoteroPanes() {
  const panes: _ZoteroTypes.ZoteroPane[] = [];
  const addPane = (pane?: _ZoteroTypes.ZoteroPane | null) => {
    if (pane && !panes.includes(pane)) panes.push(pane);
  };

  try {
    addPane(Zotero.getActiveZoteroPane());
  } catch {}

  try {
    const mainWindow = Zotero.getMainWindow() as
      | (_ZoteroTypes.MainWindow & {
          ZoteroPane?: _ZoteroTypes.ZoteroPane;
        })
      | null;
    addPane(mainWindow?.ZoteroPane);
  } catch {}

  return panes;
}

/**
 * Checks whether a Zotero item can be indexed as a regular, non-deleted item.
 *
 * @param item - Zotero item to evaluate.
 * @returns True when the item is regular and not deleted.
 */
function isIndexableRegularItem(item: Zotero.Item | null | undefined) {
  return Boolean(item?.isRegularItem() && !isDeleted(item));
}

/**
 * Determines whether a Zotero item is deleted while tolerating partially loaded items.
 *
 * @param item - Zotero item to inspect.
 * @returns True when the item is marked as deleted.
 */
function isDeleted(item: Zotero.Item) {
  const isUnloaded = (item as any)._loaded === false;
  return Boolean(
    (item as Zotero.Item & { deleted?: boolean }).deleted ??
    (isUnloaded ? false : item.getField("deleted")),
  );
}

/**
 * Checks whether a Zotero item has at least one PDF attachment.
 *
 * @param item - Zotero item whose attachments should be inspected.
 * @returns Promise resolving to true when a PDF attachment is present.
 */
async function hasPdfAttachment(item: Zotero.Item) {
  for (const attachmentID of item.getAttachments()) {
    const attachment = await Zotero.Items.getAsync(attachmentID);
    if (
      attachment?.isAttachment() &&
      attachment.attachmentContentType === "application/pdf"
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Creates the RAG candidate metadata object for a Zotero item.
 *
 * @param library - Library scope that owns the item.
 * @param item - Zotero item to convert.
 * @returns Promise resolving to a complete RAG item candidate.
 */
async function createRagItemCandidate(
  library: LibraryScope,
  item: Zotero.Item,
): Promise<RagItemCandidate> {
  return {
    library,
    itemID: item.id,
    itemKey: item.key,
    title: await getSafeTitle(item),
    creators: getSafeCreators(item),
    year: getSafeItemField(item, "year", ""),
    publicationDate: getSafeItemField(item, "date", ""),
    publicationTitle: getSafeItemField(item, "publicationTitle", ""),
    publisher: getSafeItemField(item, "publisher", ""),
    doi: getSafeItemField(item, "DOI", ""),
    isbn: getSafeItemField(item, "ISBN", ""),
    url: getSafeItemField(item, "url", ""),
    abstractNote: getSafeItemField(item, "abstractNote", ""),
    dateAdded: getSafeItemField(item, "dateAdded", ""),
    dateModified: getSafeItemField(item, "dateModified", ""),
    itemType: getSafeItemType(item),
    tags: getSafeTags(item),
    collectionIDs: getSafeCollections(item),
  };
}

/**
 * Resolves the most useful title for a Zotero item or attachment.
 *
 * @param item - Zotero item to inspect.
 * @returns Promise resolving to the best available display title.
 */
async function getSafeTitle(item: Zotero.Item) {
  item = await loadItemCompletely(item);
  const parentTitle = await getParentItemTitle(item);
  if (parentTitle) return parentTitle;

  const title = getSafeItemField(item, "title", "");
  if (title && !isGenericAttachmentTitle(title)) return title;

  const attachmentTitle = await getBestAttachmentTitle(item);
  if (attachmentTitle) return attachmentTitle;

  try {
    const displayTitle = (
      item as Zotero.Item & { getDisplayTitle?: () => string }
    ).getDisplayTitle?.();
    if (displayTitle) return displayTitle;
  } catch {}

  return "Ohne Titel";
}

/**
 * Finds a meaningful title from the item's PDF attachments.
 *
 * @param item - Zotero item whose attachments should be inspected.
 * @returns Promise resolving to a normalized attachment title, or an empty string.
 */
async function getBestAttachmentTitle(item: Zotero.Item) {
  try {
    for (const attachmentID of item.getAttachments()) {
      const attachment = await loadItemCompletely(
        await Zotero.Items.getAsync(attachmentID),
      );
      if (!attachment?.isAttachment()) continue;

      const attachmentTitle =
        getSafeItemField(attachment, "title", "") ||
        (
          attachment as Zotero.Item & { getFilename?: () => string }
        ).getFilename?.() ||
        "";
      if (isGenericAttachmentTitle(attachmentTitle)) continue;
      const normalizedTitle = normalizeAttachmentTitle(attachmentTitle);
      if (normalizedTitle) return normalizedTitle;
    }
  } catch (error) {
    Zotero.debug(
      `ZAIA: Attachment-Titel fuer RAG-Kandidat ${item.id} konnte nicht gelesen werden: ${error}`,
    );
  }

  return "";
}

/**
 * Reads the parent item title for an attachment.
 *
 * @param item - Zotero item that may be an attachment.
 * @returns Promise resolving to the parent title, or an empty string.
 */
async function getParentItemTitle(item: Zotero.Item) {
  if (!item.isAttachment() || !item.parentID) return "";

  try {
    const parent = await loadItemCompletely(
      await Zotero.Items.getAsync(item.parentID),
    );
    const parentTitle = getSafeItemField(parent, "title", "");
    if (parentTitle && !isGenericAttachmentTitle(parentTitle))
      return parentTitle;
  } catch (error) {
    Zotero.debug(
      `ZAIA: Parent-Titel fuer Attachment ${item.id} konnte nicht gelesen werden: ${error}`,
    );
  }

  return "";
}

/**
 * Loads all available Zotero item data while keeping failures non-fatal.
 *
 * @param item - Zotero item to fully load.
 * @returns Promise resolving to the original item instance.
 */
async function loadItemCompletely(item: Zotero.Item) {
  try {
    await item.loadAllData(true);
  } catch (error) {
    Zotero.debug(
      `ZAIA: Item ${item.id} konnte nicht vollstaendig nachgeladen werden: ${error}`,
    );
  }

  return item;
}

/**
 * Normalizes an attachment title or filename for display.
 *
 * @param title - Raw attachment title or filename.
 * @returns Cleaned title without PDF suffix and separator noise.
 */
function normalizeAttachmentTitle(title: string) {
  return title
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks whether a title is too generic to be useful as item metadata.
 *
 * @param title - Title to inspect.
 * @returns True when the title is empty or a common generic attachment label.
 */
function isGenericAttachmentTitle(title: string) {
  const normalized = title
    .toLowerCase()
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return [
    "",
    "pdf",
    "full text",
    "full text pdf",
    "fulltext",
    "fulltext pdf",
    "submitted version",
    "accepted version",
    "publisher version",
  ].includes(normalized);
}

/**
 * Builds a safe creator display string for a Zotero item.
 *
 * @param item - Zotero item whose creators should be read.
 * @returns Creator display string, or a fallback when no creators can be read.
 */
function getSafeCreators(item: Zotero.Item) {
  try {
    const creators = item
      .getCreators()
      .map((creator) => {
        const name = [creator.firstName, creator.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();
        return name || (creator as unknown as { name?: string }).name || "";
      })
      .filter(Boolean);

    if (creators.length) return creators.join("; ");
  } catch (error) {
    Zotero.debug(
      `ZAIA: Creator konnten fÃƒÂ¼r RAG-Kandidat ${item.id} nicht gelesen werden: ${error}`,
    );
  }

  return getSafeItemField(item, "firstCreator", "Unbekannte Autorenschaft");
}

/**
 * Reads a Zotero item field with a fallback for missing fields or API errors.
 *
 * @param item - Zotero item to read from.
 * @param field - Zotero field name.
 * @param fallback - Value returned when the field is empty or cannot be read.
 * @returns Field value or fallback value.
 */
function getSafeItemField(item: Zotero.Item, field: string, fallback: string) {
  try {
    return item.getField(field) || fallback;
  } catch (error) {
    Zotero.debug(
      `ZAIA: Feld "${field}" konnte fÃ¼r RAG-Kandidat ${item.id} nicht gelesen werden: ${error}`,
    );
    return fallback;
  }
}

/**
 * Reads the Zotero item type name safely.
 *
 * @param item - Zotero item whose type should be read.
 * @returns Zotero item type name, or "unknown" when it cannot be read.
 */
function getSafeItemType(item: Zotero.Item) {
  try {
    return Zotero.ItemTypes.getName(item.itemTypeID);
  } catch (error) {
    Zotero.debug(
      `ZAIA: Item-Type konnte fÃ¼r RAG-Kandidat ${item.id} nicht gelesen werden: ${error}`,
    );
    return "unknown";
  }
}

/**
 * Reads Zotero tag names safely.
 *
 * @param item - Zotero item whose tags should be read.
 * @returns Tag names, or an empty array when tags cannot be read.
 */
function getSafeTags(item: Zotero.Item) {
  try {
    return item
      .getTags()
      .map((entry) => entry.tag)
      .filter(Boolean);
  } catch (error) {
    Zotero.debug(
      `ZAIA: Tags konnten fÃ¼r RAG-Kandidat ${item.id} nicht gelesen werden: ${error}`,
    );
    return [];
  }
}

/**
 * Reads Zotero collection IDs safely.
 *
 * @param item - Zotero item whose collections should be read.
 * @returns Collection IDs, or an empty array when collections cannot be read.
 */
function getSafeCollections(item: Zotero.Item) {
  try {
    return item.getCollections();
  } catch (error) {
    Zotero.debug(
      `ZAIA: Collections konnten fÃ¼r RAG-Kandidat ${item.id} nicht gelesen werden: ${error}`,
    );
    return [];
  }
}

/**
 * Normalizes a requested item limit to a positive integer.
 *
 * @param limit - Optional limit value.
 * @returns Positive integer limit, or null when no finite limit was provided.
 */
function normalizeLimit(limit?: number) {
  if (limit === undefined || !Number.isFinite(limit)) return null;
  return Math.max(1, Math.floor(limit));
}
