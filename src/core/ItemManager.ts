/// <reference types="zotero-types" />

export interface ItemData {
  id: number;
  libraryID: number;
  title: string;
  firstCreator: string;
  year: string;
  itemType: string;
}

export interface ItemReference {
  libraryID: number;
  itemKey: string;
  itemID?: number;
}

export class ItemManager {
  /**
   * Holt alle aktuell ausgewählten Items im Zotero-Hauptfenster.
   * @returns Array von Zotero Item-Objekten
   */

  static getSelectedItems(): Zotero.Item[] {
    const panes = getCandidateZoteroPanes();
    for (const pane of panes) {
      const items = getSelectedItemsForPane(pane);
      if (items.length) return items;
    }

    return [];
  }

  /**
   * Filtert die Auswahl auf reguläre Items, wie Artikel, Bücher etc.
   * Verhindert Abstürze, falls ein PDF-Attachment oder eine Notiz direkt angeklickt hat.
   */

  static filterItems(): Zotero.Item[] {
    const items = this.getSelectedItems();
    return items
      .map((item) => this.resolveRegularItem(item))
      .filter((item): item is Zotero.Item => Boolean(item));
  }

  static async removeItemFromSelection(reference: ItemReference) {
    for (const pane of getCandidateZoteroPanes()) {
      const selectedItems = getSelectedItemsForPane(pane);
      if (!selectedItems.length) continue;

      const remainingItemIDs: number[] = [];
      let removed = false;

      for (const item of selectedItems) {
        const resolvedItem = this.resolveRegularItem(item);
        if (resolvedItem && matchesItemReference(resolvedItem, reference)) {
          removed = true;
          continue;
        }

        remainingItemIDs.push(item.id);
      }

      if (!removed) continue;

      return setPaneSelection(pane, remainingItemIDs);
    }

    return false;
  }

  /**
   * Extrahiert die relevanten Metadaten aus einem Zotero-Item.
   * @param item Das Zotero Item-Objekt
   * @returns Ein strukturiertes ItemData-Objekt
   */
  static extractItemData(item: Zotero.Item): ItemData {
    return {
      id: item.id,
      libraryID: item.libraryID,
      title: getSafeItemField(item, "title", "Ohne Titel"),
      firstCreator: getSafeItemField(
        item,
        "firstCreator",
        "Unbekannter Creator",
      ),
      year: getSafeItemField(item, "year", ""),
      itemType: getSafeItemType(item),
    };
  }

  /**
   * Convenience-Methode: Holt sofort die Metadaten des ersten
   * markierten, gültigen Papers. Schnittstelle für die UI, um direkt mit einem Item zu arbeiten.
   */
  static getFirstSelectedItemData(): ItemData | null {
    const validItems = this.filterItems();

    if (validItems.length === 0) {
      Zotero.debug("KI-Plugin: Kein gültiges Paper ausgewählt.");
      return null;
    }

    return this.extractItemData(validItems[0]);
  }

  /**
   * Holt alle regulären Items aus einer spezifischen oder der globalen Bibliothek.
   * @param libraryID (Optional) Die ID der Bibliothek. Standard ist die Hauptbibliothek.
   * @returns Ein Array von aufbereiteten ItemData-Objekten
   */
  static async getAllLibraryItemsMetadata(
    libraryID?: number,
  ): Promise<ItemData[]> {
    const targetLibraryID = libraryID ?? Zotero.Libraries.userLibraryID;

    let items: Zotero.Item[] = [];
    try {
      items = await Zotero.Items.getAll(targetLibraryID, true, false);
    } catch (error) {
      Zotero.debug(
        `ZAIA: Fehler beim Abrufen aller Items aus Bibliothek ${targetLibraryID}: ${error}`,
      );
      return [];
    }

    const uniqueItemsMap = new Map<number, Zotero.Item>();

    for (const item of items) {
      const resolvedItem = await this.resolveRegularItemAsync(item);
      if (resolvedItem && !uniqueItemsMap.has(resolvedItem.id)) {
        uniqueItemsMap.set(resolvedItem.id, resolvedItem);
      }
    }

    const validItems = Array.from(uniqueItemsMap.values());
    return validItems.map((item) => this.extractItemData(item));
  }

  static async getItemByLibraryAndKey(
    libraryID: number,
    itemKey: string,
  ): Promise<Zotero.Item | null> {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
    if (!item) return null;
    return this.resolveRegularItemAsync(item);
  }

  static async getSelectedRegularItem(
    itemID?: number,
  ): Promise<Zotero.Item | null> {
    const item =
      typeof itemID === "number"
        ? await Zotero.Items.getAsync(itemID)
        : this.getSelectedItems()[0];
    if (!item) return null;

    return this.resolveRegularItemAsync(item);
  }

  private static resolveRegularItem(item: Zotero.Item) {
    if (item.isRegularItem()) return item;
    if (
      item.isAttachment() &&
      item.attachmentContentType === "application/pdf" &&
      !item.parentID
    )
      return item;
    if (!item.isAttachment() || !item.parentID) return null;

    const parent = Zotero.Items.get(item.parentID);
    return parent?.isRegularItem() ? parent : null;
  }

  private static async resolveRegularItemAsync(item: Zotero.Item) {
    const loadedItem = await loadItemData(item);
    item = loadedItem ?? item;

    if (item.isRegularItem()) return item;
    if (
      item.isAttachment() &&
      item.attachmentContentType === "application/pdf" &&
      !item.parentID
    )
      return item;
    if (!item.isAttachment() || !item.parentID) return null;

    const parent = await Zotero.Items.getAsync(item.parentID);
    return parent?.isRegularItem() ? parent : null;
  }
}

function getSelectedItemsForPane(pane: _ZoteroTypes.ZoteroPane) {
  try {
    const items = pane.getSelectedItems() as Zotero.Item[];
    if (items.length) return items;
  } catch (error) {
    Zotero.debug(
      `ZAIA: Zotero-Auswahl konnte nicht gelesen werden: ${error}`,
    );
  }

  try {
    const itemIDs = pane.getSelectedItems(true) as number[];
    return itemIDs
      .map((itemID) => Zotero.Items.get(itemID))
      .filter((item): item is Zotero.Item => Boolean(item));
  } catch (error) {
    Zotero.debug(
      `ZAIA: Zotero-Auswahl-IDs konnten nicht gelesen werden: ${error}`,
    );
    return [];
  }
}

async function setPaneSelection(
  pane: _ZoteroTypes.ZoteroPane,
  itemIDs: number[],
) {
  try {
    await pane.selectItems(itemIDs);
    if (!itemIDs.length) clearPaneItemSelection(pane);
    return true;
  } catch (error) {
    Zotero.debug(
      `ZAIA: Zotero-Auswahl konnte nicht aktualisiert werden: ${error}`,
    );
    if (!itemIDs.length) return clearPaneItemSelection(pane);
    return false;
  }
}

function clearPaneItemSelection(pane: _ZoteroTypes.ZoteroPane) {
  try {
    const selection = pane.itemsView && pane.itemsView.selection;
    if (selection?.clearSelection) {
      selection.clearSelection();
      return true;
    }
  } catch (error) {
    Zotero.debug(
      `ZAIA: Zotero-Auswahl konnte nicht geleert werden: ${error}`,
    );
  }

  return false;
}

function matchesItemReference(item: Zotero.Item, reference: ItemReference) {
  if (item.libraryID !== reference.libraryID) return false;
  if (item.key === reference.itemKey) return true;
  return typeof reference.itemID === "number" && item.id === reference.itemID;
}

async function loadItemData(item: Zotero.Item) {
  try {
    const loadedItem = await Zotero.Items.getAsync(item.id);
    return loadedItem ?? item;
  } catch (error) {
    Zotero.debug(
      `ZAIA: Item ${item.id} konnte nicht nachgeladen werden: ${error}`,
    );
    return item;
  }
}

function getSafeItemField(item: Zotero.Item, field: string, fallback: string) {
  try {
    return item.getField(field) || fallback;
  } catch (error) {
    Zotero.debug(
      `ZAIA: Feld "${field}" konnte fÃ¼r Item ${item.id} nicht gelesen werden: ${error}`,
    );
    return fallback;
  }
}

function getSafeItemType(item: Zotero.Item) {
  try {
    return Zotero.ItemTypes.getName(item.itemTypeID);
  } catch (error) {
    Zotero.debug(
      `ZAIA: Item-Type konnte fÃ¼r Item ${item.id} nicht gelesen werden: ${error}`,
    );
    return "unknown";
  }
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
          ZoteroPane_Local?: _ZoteroTypes.ZoteroPane;
        })
      | null;
    addPane(mainWindow?.ZoteroPane);
    addPane(mainWindow?.ZoteroPane_Local);
  } catch {
    // Continue with the panes known to Zotero.
  }

  try {
    for (const pane of Zotero.getZoteroPanes()) addPane(pane);
  } catch {
    // Returning an empty list is handled by the caller.
  }

  return panes;
}
