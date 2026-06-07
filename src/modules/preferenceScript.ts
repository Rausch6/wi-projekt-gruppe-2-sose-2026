import { config } from "../../package.json";
import {
  KISSKI_DEFAULT_BASE_URL,
  KISSKI_DEFAULT_MODEL,
} from "../ai/providers/KisskiProvider.js";

const FIELD_NAMES = ["api-key", "base-url", "model", "max-items"] as const;

export async function registerPrefsScripts(window: Window) {
  addon.data.prefs = {
    window,
    columns: [],
    rows: [],
  };

  bindPreferenceEvents(window);
}

function bindPreferenceEvents(window: Window) {
  for (const fieldName of FIELD_NAMES) {
    getElement<HTMLInputElement>(window, fieldName)?.addEventListener(
      "change",
      () => syncRuntimeSettings(window),
    );
  }

  getElement(window, "load-models")?.addEventListener("command", () => {
    void loadModels(window);
  });
}

function syncRuntimeSettings(window: Window) {
  const apiKey = getElement<HTMLInputElement>(window, "api-key")?.value ?? "";
  const baseUrl =
    getElement<HTMLInputElement>(window, "base-url")?.value.trim() ||
    KISSKI_DEFAULT_BASE_URL;
  const model =
    getElement<HTMLInputElement>(window, "model")?.value.trim() ||
    KISSKI_DEFAULT_MODEL;
  const maxItemsValue =
    getElement<HTMLInputElement>(window, "max-items")?.value ?? "20";

  addon.data.settings = {
    provider: "kisski",
    apiKey,
    baseUrl,
    model,
    maxItems: Number.parseInt(maxItemsValue, 10) || 20,
  };
  addon.api.configureAI();
}

async function loadModels(window: Window) {
  const status = getElement<HTMLElement>(window, "connection-status");
  const dataList = window.document.getElementById(
    `${config.addonRef}-model-options`,
  );

  syncRuntimeSettings(window);
  setStatus(status, "Loading models...");

  try {
    const models = await addon.api.ai.listModels("kisski");
    dataList?.replaceChildren(
      ...models.map((model: { id: string }) => {
        const option = window.document.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "option",
        ) as HTMLOptionElement;
        option.value = model.id;
        return option;
      }),
    );
    setStatus(status, `${models.length} models available.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(status, `Connection failed: ${message}`);
  }
}

function setStatus(element: HTMLElement | null, message: string) {
  if (element) element.textContent = message;
}

function getElement<T extends Element = Element>(window: Window, name: string) {
  return window.document.querySelector<T>(
    `#zotero-prefpane-${config.addonRef}-${name}`,
  );
}
