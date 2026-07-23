import { config } from "../../package.json";

const INDEX_MANAGER_DEFAULT_WIDTH = 800;
const INDEX_MANAGER_DEFAULT_HEIGHT = 600;
const INDEX_MANAGER_MIN_WIDTH = INDEX_MANAGER_DEFAULT_WIDTH;
const INDEX_MANAGER_MIN_HEIGHT = INDEX_MANAGER_DEFAULT_HEIGHT;

/**
 * Opens the index manager as a centered Zotero chrome dialog.
 *
 * The owner and configured add-on instance are passed as dialog arguments so
 * the XHTML bootstrap script can call back into the running plugin instance.
 *
 * @param owner - Zotero window that owns the index manager dialog.
 * @returns Window returned by Zotero's dialog API.
 */
export function openIndexManagerWindow(owner: Window) {
  const url = `chrome://${config.addonRef}/content/indexManager.xhtml`;
  const features = [
    "chrome",
    "titlebar",
    "toolbar",
    "centerscreen",
    "resizable=yes",
    `width=${INDEX_MANAGER_DEFAULT_WIDTH}`,
    `height=${INDEX_MANAGER_DEFAULT_HEIGHT}`,
    `minwidth=${INDEX_MANAGER_MIN_WIDTH}`,
    `minheight=${INDEX_MANAGER_MIN_HEIGHT}`,
  ].join(",");

  return owner.openDialog(url, "_blank", features, {
    addonInstance: config.addonInstance,
    owner,
  });
}
