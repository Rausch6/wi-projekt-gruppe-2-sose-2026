import { config } from "../../package.json";
import {
  EMBEDDING_DEFAULT_BASE_URL,
  EMBEDDING_DEFAULT_MODEL,
} from "../ai/EmbeddingProvider.js";
import {
  KISSKI_DEFAULT_BASE_URL,
  KISSKI_DEFAULT_MODEL,
} from "../ai/providers/KisskiProvider.js";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
} from "../ai/providers/OllamaProvider.js";

import { backgroundIndexer } from "../core/BackgroundIndexer";
import { vectorStore } from "../core/OramaService";
import { indexingEvents } from "../core/IndexingEventBus";

const OLLAMA_INSTALL_COMMANDS = {
  unix: "curl -fsSL https://ollama.com/install.sh | sh",
  windows: "irm https://ollama.com/install.ps1 | iex",
};

const FIELD_NAMES = [
  "api-key",
  "base-url",
  "model",
  "send-paper-context-to-kisski",
  "context-router-provider",
  "embedding-search-enabled",
  "embedding-base-url",
  "embedding-model",
  "ollama-base-url",
  "ollama-model",
  "max-items",
  "auto-delete-old-chats",
  "chunk-target-tokens",
  "chunk-overlap-tokens",
  "chunk-count",
] as const;

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

  getElement(window, "test-embedding-service")?.addEventListener(
    "command",
    () => {
      void testEmbeddingService(window);
    },
  );

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

  // --- Index-Verwaltungs-Buttons ---
  getElement(window, "rebuild-index")?.addEventListener("command", () => {
    void rebuildIndex(window);
  });
  getElement(window, "clear-index")?.addEventListener("command", () => {
    void clearIndex(window);
  });
  getElement(window, "open-index-manager")?.addEventListener("command", () => {
    void openIndexManager(window);
  });
  
  // Initial stats update
  void updateIndexStats(window);

  // Dynamic updates
  const updateFn = () => { void updateIndexStats(window); };
  indexingEvents.on("finished", updateFn);
  indexingEvents.on("singleDone", updateFn);
  indexingEvents.on("deleted", updateFn);
  indexingEvents.on("progress", updateFn);
}

function openIndexManager(window: Window) {
  const url = `chrome://${config.addonRef}/content/indexManager.xhtml`;
  const features = "chrome,titlebar,toolbar,centerscreen,resizable=yes,width=800,height=600";
  window.openDialog(url, "_blank", features, { owner: window });
}

async function updateIndexStats(window: Window) {
  const statusEl = getElement<HTMLElement>(window, "indexing-db-status");
  if (!statusEl) return;
  
  try {
    const stats = await vectorStore.getDatabaseStats();
    statusEl.textContent = `Vektordatenbank: ${stats.papers} Paper / ${stats.chunks} Chunks.`;
  } catch (err) {
    statusEl.textContent = `Vektordatenbank-Status konnte nicht geladen werden.`;
  }
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
  const contextRouterProviderValue =
    getElement<HTMLSelectElement>(window, "context-router-provider")?.value ??
    "ollama";
  const contextRouterProvider =
    contextRouterProviderValue === "kisski" ? "kisski" : "ollama";
  const embeddingSearchEnabled =
    getElement<HTMLInputElement>(window, "embedding-search-enabled")?.checked ??
    true;
  const embeddingBaseUrl =
    getElement<HTMLInputElement>(window, "embedding-base-url")?.value.trim() ||
    EMBEDDING_DEFAULT_BASE_URL;
  const embeddingModel =
    getElement<HTMLInputElement>(window, "embedding-model")?.value.trim() ||
    EMBEDDING_DEFAULT_MODEL;
  const ollamaBaseUrl =
    getElement<HTMLInputElement>(window, "ollama-base-url")?.value.trim() ||
    OLLAMA_DEFAULT_BASE_URL;
  const ollamaModel =
    getElement<HTMLInputElement>(window, "ollama-model")?.value.trim() ||
    OLLAMA_DEFAULT_MODEL;
  const maxItemsValue =
    getElement<HTMLInputElement>(window, "max-items")?.value ?? "200";
  const autoDeleteOldChats =
    getElement<HTMLInputElement>(window, "auto-delete-old-chats")?.checked ??
    true;

  const chunkTargetTokensValue =
    getElement<HTMLInputElement>(window, "chunk-target-tokens")?.value ?? "512";
  const chunkOverlapTokensValue =
    getElement<HTMLInputElement>(window, "chunk-overlap-tokens")?.value ?? "100";
  const chunkCountValue =
    getElement<HTMLInputElement>(window, "chunk-count")?.value ?? "3";

  Object.assign(addon.data.settings, {
    provider: addon.data.settings.provider,
    apiKey,
    baseUrl,
    model,
    sendPaperContextToKisski,
    contextRouterProvider,
    embeddingSearchEnabled,
    embeddingBaseUrl,
    embeddingModel,
    ollamaBaseUrl,
    ollamaModel,
    maxItems: Number.parseInt(maxItemsValue, 10) || 200,
    autoDeleteOldChats,
    metadataFieldSelection: addon.data.settings.metadataFieldSelection,
    chunkTargetTokens: Number.parseInt(chunkTargetTokensValue, 10) || 512,
    chunkOverlapTokens: Number.parseInt(chunkOverlapTokensValue, 10) || 100,
    chunkCount: Number.parseInt(chunkCountValue, 10) || 3,
  });
  addon.api.configureAI();
  addon.api.configureEmbeddings();
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

async function testEmbeddingService(window: Window) {
  const status = getElement<HTMLElement>(window, "embedding-service-status");
  const button = getElement<HTMLButtonElement>(
    window,
    "test-embedding-service",
  );

  syncRuntimeSettings(window);
  setStatus(status, "Testing embedding service...");
  if (button) button.disabled = true;

  try {
    const [embedding] = await addon.api.embeddings.embedTexts(
      ["semantic paper search"],
      { inputType: "query", timeout: 30_000 },
    );
    setStatus(status, `Embedding service ready (${embedding.length} dims).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(status, `Embedding test failed: ${message}`);
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

async function rebuildIndex(window: Window) {
  const status = getElement<HTMLElement>(window, "indexing-action-status");
  const rebuildBtn = getElement<HTMLButtonElement>(window, "rebuild-index");
  const clearBtn = getElement<HTMLButtonElement>(window, "clear-index");

  const confirmed = window.confirm(
    "Der gesamte Vektor-Index wird geleert und neu aufgebaut.\n\nDies kann je nach Bibliotheksgröße einige Minuten dauern. Fortfahren?",
  );
  if (!confirmed) return;

  if (rebuildBtn) rebuildBtn.disabled = true;
  if (clearBtn) clearBtn.disabled = true;
  setStatus(status, "Leere Index…");

  try {
    await vectorStore.clearIndex();
    setStatus(status, "Index geleert. Neu-Indexierung läuft im Hintergrund…");
    backgroundIndexer.indexAllLibraryItems().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(status, `Fehler bei Neu-Indexierung: ${msg}`);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(status, `Fehler beim Leeren: ${message}`);
  } finally {
    if (rebuildBtn) rebuildBtn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;
    void updateIndexStats(window);
  }
}

async function clearIndex(window: Window) {
  const status = getElement<HTMLElement>(window, "indexing-action-status");
  const rebuildBtn = getElement<HTMLButtonElement>(window, "rebuild-index");
  const clearBtn = getElement<HTMLButtonElement>(window, "clear-index");

  const confirmed = window.confirm(
    "Der gesamte Vektor-Index wird unwiderruflich geleert.\n\nDie Dokumente müssen danach erneut indexiert werden. Fortfahren?",
  );
  if (!confirmed) return;

  if (rebuildBtn) rebuildBtn.disabled = true;
  if (clearBtn) clearBtn.disabled = true;
  setStatus(status, "Leere Index…");

  try {
    await vectorStore.clearIndex();
    setStatus(status, "Index erfolgreich geleert.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(status, `Fehler: ${message}`);
  } finally {
    if (rebuildBtn) rebuildBtn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;
    void updateIndexStats(window);
  }
}
