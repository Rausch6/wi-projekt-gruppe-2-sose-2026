import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { requestSemanticSearchPreferenceFocus } from "./preferenceScript";

export const PREFERENCES_PANE_ID = `${config.addonRef}-preferences`;

export function registerPreferencesPane() {
  return Zotero.PreferencePanes.register({
    id: PREFERENCES_PANE_ID,
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/LogoPlugin.png`,
    stylesheets: [rootURI + "content/preferences.css"],
  });
}

export function openPreferencesPane() {
  return Zotero.Utilities.Internal.openPreferences(PREFERENCES_PANE_ID);
}

export function openSemanticSearchPreference() {
  requestSemanticSearchPreferenceFocus();
  return openPreferencesPane();
}
