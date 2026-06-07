import { config } from "../../package.json";
import { renderAssistantSidebar } from "./assistantSidebar";

const PANE_ID = `${config.addonRef}-ai-assistant`;
const SIDENAV_ICON = `chrome://${config.addonRef}/content/icons/IconPlugin-20.png`;
const HEADER_ICON = `chrome://${config.addonRef}/content/icons/IconPlugin-16.png`;

export function registerAssistantItemPaneSection() {
  unregisterAssistantItemPaneSection();

  return Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    sidenav: {
      icon: SIDENAV_ICON,
      darkIcon: SIDENAV_ICON,
      l10nID: "item-section-ai-assistant-sidenav-tooltip",
    },
    header: {
      icon: HEADER_ICON,
      darkIcon: HEADER_ICON,
      l10nID: "item-section-ai-assistant-head-text",
    },
    onRender: ({ body }) => {
      body.classList.add("zai-native-section");
      renderAssistantSidebar(body);
    },
    onItemChange: ({ setEnabled }) => {
      setEnabled(true);
    },
  });
}

export function unregisterAssistantItemPaneSection() {
  Zotero.ItemPaneManager.unregisterSection(PANE_ID);
}
