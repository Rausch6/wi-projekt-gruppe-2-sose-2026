/// <reference types="zotero-types" />

export interface ItemData {
  id: number;
  libraryID: number;
  title: string;
  firstCreator: string;
  year: string;
  itemType: string;
}

export class ItemManager {
  
  /**
   * Holt alle aktuell ausgewählten Items im Zotero-Hauptfenster.
   * @returns Array von Zotero Item-Objekten
   */

  static getSelectedItems(): Zotero.Item[] {
    const panes = getCandidateZoteroPanes();
    for (const pane of panes) {
      try {
        const items = pane.getSelectedItems() as Zotero.Item[];
        if (items.length) return items;
      } catch (error) {
        Zotero.debug(
          `ZAIA: Zotero-Auswahl konnte nicht gelesen werden: ${error}`,
        );
      }
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

  /**
   * Extrahiert die relevanten Metadaten aus einem Zotero-Item.
   * @param item Das Zotero Item-Objekt
   * @returns Ein strukturiertes ItemData-Objekt
   */
  static extractItemData(item: Zotero.Item): ItemData {
    return {
      id: item.id,
      libraryID: item.libraryID,
      title: item.getField("title") || "Ohne Titel",
      firstCreator: item.getField("firstCreator") || "Unbekannter Creator",
      year: item.getField("year") || "",
      itemType: Zotero.ItemTypes.getName(item.itemTypeID),
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

  static async getItemByLibraryAndKey(
    libraryID: number,
    itemKey: string,
  ): Promise<Zotero.Item | null> {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
    return item && item.isRegularItem() ? item : null;
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
    if (!item.isAttachment() || !item.parentID) return null;

    const parent = Zotero.Items.get(item.parentID);
    return parent?.isRegularItem() ? parent : null;
  }

  private static async resolveRegularItemAsync(item: Zotero.Item) {
    if (item.isRegularItem()) return item;
    if (!item.isAttachment() || !item.parentID) return null;

    const parent = await Zotero.Items.getAsync(item.parentID);
    return parent?.isRegularItem() ? parent : null;
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
        })
      | null;
    addPane(mainWindow?.ZoteroPane);
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
