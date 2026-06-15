import { config } from "../../package.json";
import {
  KISSKI_DEFAULT_BASE_URL,
  KISSKI_DEFAULT_MODEL,
} from "../ai/providers/KisskiProvider.js";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
} from "../ai/providers/OllamaProvider.js";

const FIELD_NAMES = [
  "api-key",
  "base-url",
  "model",
  "send-paper-context-to-kisski",
  "ollama-base-url",
  "ollama-model",
  "max-items",
  "auto-delete-old-chats",
] as const;

const OLLAMA_INSTALL_COMMANDS = {
  unix: "curl -fsSL https://ollama.com/install.sh | sh",
  windows: "irm https://ollama.com/install.ps1 | iex",
} as const;

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

  getElement(window, "copy-ollama-install-command")?.addEventListener(
    "command",
    () => {
      void copyOllamaInstallCommand(window);
    },
  );

  getElement(window, "download-ollama-model")?.addEventListener(
    "command",
    () => {
      void downloadOllamaModel(window);
    },
  );
}

function syncRuntimeSettings(window: Window) {
  const apiKey = getElement<HTMLInputElement>(window, "api-key")?.value ?? "";
  const baseUrl =
    getElement<HTMLInputElement>(window, "base-url")?.value.trim() ||
    KISSKI_DEFAULT_BASE_URL;
  const model =
    getElement<HTMLInputElement>(window, "model")?.value.trim() ||
    KISSKI_DEFAULT_MODEL;
  const sendPaperContextToKisski =
    getElement<HTMLInputElement>(window, "send-paper-context-to-kisski")
      ?.checked ?? true;
  const ollamaBaseUrl =
    getElement<HTMLInputElement>(window, "ollama-base-url")?.value.trim() ||
    OLLAMA_DEFAULT_BASE_URL;
  const ollamaModel =
    getElement<HTMLInputElement>(window, "ollama-model")?.value.trim() ||
    OLLAMA_DEFAULT_MODEL;
  const maxItemsValue =
    getElement<HTMLInputElement>(window, "max-items")?.value ?? "20";
  const autoDeleteOldChats =
    getElement<HTMLInputElement>(window, "auto-delete-old-chats")?.checked ??
    true;

  addon.data.settings = {
    provider: addon.data.settings.provider,
    apiKey,
    baseUrl,
    model,
    sendPaperContextToKisski,
    ollamaBaseUrl,
    ollamaModel,
    maxItems: Number.parseInt(maxItemsValue, 10) || 20,
    autoDeleteOldChats,
  };
  addon.api.configureAI();
}

export function getOllamaInstallCommand(window: Window) {
  const platform = window.navigator.platform.toLowerCase();
  const userAgent = window.navigator.userAgent.toLowerCase();
  const isWindows = platform.includes("win") || userAgent.includes("windows");

  return isWindows
    ? OLLAMA_INSTALL_COMMANDS.windows
    : OLLAMA_INSTALL_COMMANDS.unix;
}

async function copyOllamaInstallCommand(window: Window) {
  const status = getElement<HTMLElement>(window, "ollama-setup-status");
  const command = getOllamaInstallCommand(window);

  try {
    await window.navigator.clipboard.writeText(command);
    setStatus(status, "Ollama install command copied.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(status, `Copy failed: ${message}`);
  }
}

async function downloadOllamaModel(window: Window) {
  const status = getElement<HTMLElement>(window, "ollama-setup-status");
  const button = getElement<HTMLButtonElement>(window, "download-ollama-model");

  syncRuntimeSettings(window);
  const model = addon.data.settings.ollamaModel || OLLAMA_DEFAULT_MODEL;
  setStatus(status, `Downloading ${model}...`);
  if (button) button.disabled = true;

  try {
    const provider = addon.api.ai.getProvider("ollama");
    if (typeof provider.pullModel !== "function") {
      throw new Error("Ollama provider does not support model downloads.");
    }

    await provider.pullModel(model);
    setStatus(status, `${model} is ready.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(status, `Download failed: ${message}`);
  } finally {
    if (button) button.disabled = false;
  }
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
