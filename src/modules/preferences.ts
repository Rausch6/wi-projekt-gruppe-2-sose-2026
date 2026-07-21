import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { requestSemanticSearchPreferenceFocus } from "./preferenceScript";

/**
 * Zotero preference pane identifier for the ZAIA settings page.
 */
export const PREFERENCES_PANE_ID = `${config.addonRef}-preferences`;

/**
 * Registers the ZAIA preferences pane with Zotero.
 *
 * @returns Zotero preference pane registration result.
 */
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

/**
 * Opens the ZAIA preferences pane.
 *
 * @returns Result of Zotero's internal preference pane opening call.
 */
export function openPreferencesPane() {
  return Zotero.Utilities.Internal.openPreferences(PREFERENCES_PANE_ID);
}

/**
 * Opens preferences and requests focus for the semantic search setting.
 *
 * @returns Result of opening the ZAIA preferences pane.
 */
export function openSemanticSearchPreference() {
  requestSemanticSearchPreferenceFocus();
  return openPreferencesPane();
}
