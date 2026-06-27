/// <reference types="zotero-types" />

import { ItemManager } from "./ItemManager";

export type LibraryScopeType = "user" | "group";

export interface LibraryScope {
  libraryID: number;
  type: LibraryScopeType;
  name: string;
  groupID: number | null;
  editable: boolean;
  filesEditable: boolean;
}

export interface RagItemCandidate {
  library: LibraryScope;
  itemID: number;
  itemKey: string;
  title: string;
  creators: string;
  year: string;
  publicationDate: string;
  publicationTitle: string;
  publisher: string;
  doi: string;
  isbn: string;
  url: string;
  abstractNote: string;
  dateAdded: string;
  dateModified: string;
  itemType: string;
  tags: string[];
  collectionIDs: number[];
}

export interface LibraryItemQuery {
  libraryID: number;
  limit?: number;
  includeWithoutPdf?: boolean;
}

export class LibraryScopeManager {
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

  static getLibraryScope(libraryID: number) {
    return createLibraryScope(libraryID);
  }

  static getSelectedLibraryScope(): LibraryScope | null {
    const item = ItemManager.filterItems()[0];
    if (item) return createLibraryScope(item.libraryID);

    const selectedLibraryID = getSelectedLibraryID();
    return selectedLibraryID ? createLibraryScope(selectedLibraryID) : null;
  }

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

function getSelectedLibraryID() {
  for (const pane of getCandidateZoteroPanes()) {
    try {
      const selectedGroup = pane.getSelectedGroup?.(true);
      if (typeof selectedGroup === "number") {
        const libraryID = Zotero.Groups.getLibraryIDFromGroupID(selectedGroup);
        if (typeof libraryID === "number") return libraryID;
      }
    } catch {
      // Continue with the library attached to selected items, if available.
    }
  }

  return null;
}

function getCandidateZoteroPanes() {
  const panes: _ZoteroTypes.ZoteroPane[] = [];
  const addPane = (pane?: _ZoteroTypes.ZoteroPane | null) => {
    if (pane && !panes.includes(pane)) panes.push(pane);
  };

  try {
    addPane(Zotero.getActiveZoteroPane());
  } catch {
    // The developer window can temporarily have no active Zotero pane.
  }

  try {
    const mainWindow = Zotero.getMainWindow() as
      | (_ZoteroTypes.MainWindow & {
          ZoteroPane?: _ZoteroTypes.ZoteroPane;
        })
      | null;
    addPane(mainWindow?.ZoteroPane);
  } catch {
    // Returning an empty list is handled by the caller.
  }

  return panes;
}

function isIndexableRegularItem(item: Zotero.Item | null | undefined) {
  return Boolean(item?.isRegularItem() && !isDeleted(item));
}

function isDeleted(item: Zotero.Item) {
  return Boolean(
    (item as Zotero.Item & { deleted?: boolean }).deleted ??
    item.getField("deleted"),
  );
}

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
  } catch {
    // Fall back to a stable placeholder below.
  }

  return "Ohne Titel";
}

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

function normalizeAttachmentTitle(title: string) {
  return title
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

function normalizeLimit(limit?: number) {
  if (limit === undefined || !Number.isFinite(limit)) return null;
  return Math.max(1, Math.floor(limit));
}
