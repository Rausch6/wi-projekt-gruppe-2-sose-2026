import { config } from "../../package.json";

const INDEX_MANAGER_DEFAULT_WIDTH = 800;
const INDEX_MANAGER_DEFAULT_HEIGHT = 600;
const INDEX_MANAGER_MIN_WIDTH = INDEX_MANAGER_DEFAULT_WIDTH;
const INDEX_MANAGER_MIN_HEIGHT = INDEX_MANAGER_DEFAULT_HEIGHT;

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
