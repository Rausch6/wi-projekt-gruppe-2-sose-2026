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
    const pane = Zotero.getActiveZoteroPane();
    return pane ? (pane.getSelectedItems() as Zotero.Item[]) : [];
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

  private static resolveRegularItem(item: Zotero.Item) {
    if (item.isRegularItem()) return item;
    if (!item.isAttachment() || !item.parentID) return null;

    const parent = Zotero.Items.get(item.parentID);
    return parent?.isRegularItem() ? parent : null;
  }
}
