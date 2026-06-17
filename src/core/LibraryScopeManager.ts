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

      const item = await Zotero.Items.getAsync(itemID);
      if (!isIndexableRegularItem(item)) continue;
      if (!query.includeWithoutPdf && !(await hasPdfAttachment(item))) continue;

      candidates.push(createRagItemCandidate(scope, item));
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

function createRagItemCandidate(
  library: LibraryScope,
  item: Zotero.Item,
): RagItemCandidate {
  return {
    library,
    itemID: item.id,
    itemKey: item.key,
    title: item.getField("title") || "Ohne Titel",
    creators: item.getField("firstCreator") || "Unbekannte Autorenschaft",
    year: item.getField("year") || "",
    itemType: Zotero.ItemTypes.getName(item.itemTypeID),
    tags: item
      .getTags()
      .map((entry) => entry.tag)
      .filter(Boolean),
    collectionIDs: item.getCollections(),
  };
}

function normalizeLimit(limit?: number) {
  if (limit === undefined || !Number.isFinite(limit)) return null;
  return Math.max(1, Math.floor(limit));
}
