// @ts-nocheck -- Upstream template examples target an older toolkit API.
import { getLocaleID } from "../utils/locale";
import {
  registerAssistantToolbarButton,
  unregisterAssistantToolbarButton,
} from "../ui/assistantToolbarButton";

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

export class UIExampleFactory {
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

  @example
  static registerAssistantToolbarButton(win: _ZoteroTypes.MainWindow) {
    registerAssistantToolbarButton(win);
  }

  @example
  static unregisterAssistantToolbarButton(win: _ZoteroTypes.MainWindow) {
    unregisterAssistantToolbarButton(win);
  }

  @example
  static unregisterAssistantSidenavButton() {
    const paneID = `${addon.data.config.addonRef}-ai-assistant-trigger`;
    Zotero.ItemPaneManager.unregisterSection(paneID);
  }

  @example
  static unregisterTemplateItemPaneSections() {
    Zotero.ItemPaneManager.unregisterSection("example");
    Zotero.ItemPaneManager.unregisterSection("reader-example");
  }

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
        item.setField("title", value);
      },
    });
  }
}
