// @ts-nocheck
import { getLocaleID } from "../utils/locale";
import {
  registerAssistantToolbarButton,
  unregisterAssistantToolbarButton,
} from "../ui/assistantToolbarButton";

/**
 * Wraps example methods with logging and error forwarding.
 *
 * @param target - Class constructor or prototype that owns the decorated member.
 * @param propertyKey - Decorated member name.
 * @param descriptor - Property descriptor for the decorated method.
 * @returns Updated method descriptor with logging behavior.
 */
function example(
  target: any,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor,
) {
  const original = descriptor.value;
  descriptor.value = function (...args: any) {
    try {
      ztoolkit.log(`Calling example ${target.name}.${String(propertyKey)}`);
      return original.apply(this, args);
    } catch (e) {
      ztoolkit.log(`Error in example ${target.name}.${String(propertyKey)}`, e);
      throw e;
    }
  };
  return descriptor;
}

/**
 * Registers and unregisters Zotero UI examples used by the plugin scaffold.
 */
export class UIExampleFactory {
  /**
   * Adds the assistant sidebar stylesheet to the Zotero main window.
   *
   * @param win - Zotero main window that should receive the stylesheet.
   * @returns Nothing.
   */
  @example
  static registerStyleSheet(win: _ZoteroTypes.MainWindow) {
    const doc = win.document;
    const styleId = `${addon.data.config.addonRef}-assistant-sidebar-styles`;
    doc.getElementById(styleId)?.remove();

    const styles = ztoolkit.UI.createElement(doc, "link", {
      properties: {
        id: styleId,
        type: "text/css",
        rel: "stylesheet",
        href: `chrome://${addon.data.config.addonRef}/content/assistantSidebar.css?v=${Date.now()}`,
      },
    });
    doc.documentElement?.appendChild(styles);
  }

  /**
   * Registers the ZAIA assistant toolbar button.
   *
   * @param win - Zotero main window that should receive the toolbar button.
   * @returns Nothing.
   */
  @example
  static registerAssistantToolbarButton(win: _ZoteroTypes.MainWindow) {
    registerAssistantToolbarButton(win);
  }

  /**
   * Unregisters the ZAIA assistant toolbar button.
   *
   * @param win - Zotero main window whose toolbar button should be removed.
   * @returns Nothing.
   */
  @example
  static unregisterAssistantToolbarButton(win: _ZoteroTypes.MainWindow) {
    unregisterAssistantToolbarButton(win);
  }

  /**
   * Unregisters the assistant side navigation item pane section.
   *
   * @returns Nothing.
   */
  @example
  static unregisterAssistantSidenavButton() {
    const paneID = `${addon.data.config.addonRef}-ai-assistant-trigger`;
    Zotero.ItemPaneManager.unregisterSection(paneID);
  }

  /**
   * Unregisters template item pane sections from the upstream scaffold.
   *
   * @returns Nothing.
   */
  @example
  static unregisterTemplateItemPaneSections() {
    Zotero.ItemPaneManager.unregisterSection("example");
    Zotero.ItemPaneManager.unregisterSection("reader-example");
  }

  /**
   * Registers a scaffold example column in Zotero's item tree.
   *
   * @returns Promise that resolves after the column has been registered.
   */
  @example
  static async registerExtraColumn() {
    const field = "test1";
    await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: field,
      label: "text column",
      dataProvider: (item: Zotero.Item, dataKey: string) => {
        return field + String(item.id);
      },
      iconPath: "chrome://zotero/skin/cross.png",
    });
  }

  /**
   * Registers a scaffold example column with a custom rendered cell.
   *
   * @returns Promise that resolves after the column has been registered.
   */
  @example
  static async registerExtraColumnWithCustomCell() {
    const field = "test2";
    await Zotero.ItemTreeManager.registerColumns({
      pluginID: addon.data.config.addonID,
      dataKey: field,
      label: "custom column",
      dataProvider: (item: Zotero.Item, dataKey: string) => {
        return field + String(item.id);
      },
      renderCell(index, data, column, isFirstColumn, doc) {
        ztoolkit.log("Custom column cell is rendered!");
        const span = doc.createElement("span");
        span.className = `cell ${column.className}`;
        span.style.background = "#0dd068";
        span.innerText = "⭐" + data;
        return span;
      },
    });
  }

  /**
   * Registers a scaffold item pane row that mirrors the item title.
   *
   * @returns Nothing.
   */
  @example
  static registerItemPaneCustomInfoRow() {
    Zotero.ItemPaneManager.registerInfoRow({
      rowID: "example",
      pluginID: addon.data.config.addonID,
      editable: true,
      label: {
        l10nID: getLocaleID("item-info-row-example-label"),
      },
      position: "afterCreators",
      onGetData: ({ item }) => {
        return item.getField("title");
      },
      onSetData: ({ item, value }) => {
        if (!item.isEditable()) return;
        item.setField("title", value);
        item.saveTx();
      },
    });
  }
}
