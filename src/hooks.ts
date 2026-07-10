import { UIExampleFactory } from "./modules/examples";
import { EMBEDDING_DEFAULT_MODEL } from "./ai/EmbeddingProvider.js";
import {
  DEFAULT_METADATA_FIELD_SELECTION,
  normalizeMetadataFieldSelection,
} from "./core/MetadataFieldSelection";
import { getString, initLocale } from "./utils/locale";
import { registerPreferencesPane } from "./modules/preferences";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createCheckingProviderConnectionResult } from "./ai/providerConnectionStatus";
import { createCheckingEmbeddingConnectionResult } from "./ai/embeddingConnectionStatus";
import {
  closeChatDatabase,
  initializeChatDatabase,
} from "./persistence/ChatDatabase";
import { ChatRepository } from "./core/ChatRepository";
import {
  initializeChatPersistence,
  registerPaperContextSelectionWindow,
  refreshPaperContextControls,
} from "./ui/assistantChatController";
import {
  handleAssistantPopoutWindowUnload,
  initializeAssistantPopoutWindow,
} from "./ui/assistantPopoutWindow";
import {
  handleLocalOllamaModelWindowUnload,
  initializeLocalOllamaModelWindow,
} from "./ui/localOllamaModelWindow";
import { unregisterAssistantSidebarController } from "./ui/assistantSidebarController";
import { createZToolkit } from "./utils/ztoolkit";
import type { LLMProvider } from "./addon";
import { vectorStore } from "./core/OramaService";
import { backgroundIndexer } from "./core/BackgroundIndexer";
import { ollamaLifecycleManager } from "./ai/OllamaLifecycleManager";
import {
  initializeIndexManagerWindow,
  handleIndexManagerWindowUnload,
} from "./ui/indexManagerWindow";
import {
  registerZAIAShortcuts,
  unregisterAllZAIAShortcuts,
  unregisterZAIAShortcuts,
} from "./modules/shortcutManager";

const OLD_CHAT_RETENTION_DAYS = 14;

// Reads one setting from Zotero's preference storage for this plugin.
// The prefix keeps our settings separate from Zotero's own settings.
function getPluginPref(key: string) {
  return Zotero.Prefs.get(`${addon.data.config.prefsPrefix}.${key}`, true);
}

function getStringSetting(key: string, fallback = "") {
  const value = getPluginPref(key);
  return typeof value === "string" ? value.trim() : fallback;
}

function getNumberSetting(key: string, fallback: number) {
  const value = getPluginPref(key);
  return typeof value === "number" ? value : fallback;
}

function getBooleanSetting(key: string, fallback: boolean) {
  const value = getPluginPref(key);
  return typeof value === "boolean" ? value : fallback;
}

function loadSettings() {
  addon.data.settings = {
    provider: getProviderSetting(),
    apiKey: getStringSetting("apiKey"),
    baseUrl: getStringSetting("baseUrl", "https://chat-ai.academiccloud.de/v1"),
    model: getStringSetting("model", "deepseek-r1-distill-llama-70b"),
    sendPaperContextToKisski: getBooleanSetting(
      "sendPaperContextToKisski",
      true,
    ),
    contextRouterProvider: getContextRouterProviderSetting(),
    embeddingSearchEnabled: getBooleanSetting("embeddingSearchEnabled", true),
    embeddingModel: getStringSetting("embeddingModel", EMBEDDING_DEFAULT_MODEL),
    maxItems: getNumberSetting("maxItems", 200),
    metadataFieldSelection: normalizeMetadataFieldSelection(
      getStringSetting(
        "metadataFieldSelection",
        DEFAULT_METADATA_FIELD_SELECTION,
      ),
    ),
    ollamaBaseUrl: getStringSetting("ollamaBaseUrl", "http://localhost:11434"),
    ollamaModel: getStringSetting("ollamaModel", "qwen2.5:3b"),
    autoDeleteOldChats: getBooleanSetting("autoDeleteOldChats", true),
    chunkTargetTokens: getNumberSetting("chunkTargetTokens", 512),
    chunkOverlapTokens: getNumberSetting("chunkOverlapTokens", 100),
    chunkCount: getNumberSetting("chunkCount", 3),
  };
  addon.api.configureAI();
  addon.api.configureEmbeddings();
}

async function onStartup() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  Zotero.debug("[ZAIA-Startup] onStartup BEGIN");
  try {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);
    Zotero.debug("[ZAIA-Startup] Promises resolved");

    initLocale();
    loadSettings();
    Zotero.debug("[ZAIA-Startup] Settings loaded.");

    await vectorStore.initialize();
    Zotero.debug("[ZAIA-Startup] vectorStore initialized.");

    // Log currently indexed documents to debug channel
    await vectorStore.logIndexedDocuments();

    backgroundIndexer.initialize();
    Zotero.debug("[ZAIA-Startup] backgroundIndexer initialized.");
  } catch (err: any) {
    Zotero.debug(
      `[ZAIA-Startup] CRITICAL ERROR IN ONSTARTUP: ${err}\n${err.stack}`,
    );
  }

  void checkEmbeddingConnectionOnStartup();
  void checkActiveProviderConnectionOnStartup();
  await initializeChatDatabase();
  await cleanupOldChatsOnStartup();
  await initializeChatPersistence();

  await registerPreferencesPane();

  await UIExampleFactory.registerExtraColumn();

  await UIExampleFactory.registerExtraColumnWithCustomCell();

  UIExampleFactory.registerItemPaneCustomInfoRow();

  UIExampleFactory.unregisterAssistantSidenavButton();

  UIExampleFactory.unregisterTemplateItemPaneSections();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
}

async function cleanupOldChatsOnStartup() {
  if (!addon.data.settings.autoDeleteOldChats) return;

  try {
    const deletedCount = await ChatRepository.deleteOldUnfavoriteChats(
      OLD_CHAT_RETENTION_DAYS,
    );
    if (deletedCount > 0) {
      Zotero.debug(
        `ZAIA: ${deletedCount} nicht-favorisierte alte Chats gelöscht.`,
      );
    }
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
}

function getProviderSetting(): LLMProvider {
  const value = getStringSetting("provider", "kisski");
  return value === "ollama" ? "ollama" : "kisski";
}

function getContextRouterProviderSetting(): LLMProvider {
  const value = getStringSetting("contextRouterProvider", "ollama");
  return value === "kisski" ? "kisski" : "ollama";
}

async function checkActiveProviderConnectionOnStartup() {
  const provider = addon.data.settings.provider;
  addon.data.runtime.providerConnections[provider] =
    createCheckingProviderConnectionResult(provider);

  try {
    await addon.api.checkProviderConnection(provider);
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
}

async function checkEmbeddingConnectionOnStartup() {
  addon.data.runtime.embeddingConnection =
    createCheckingEmbeddingConnectionResult();

  try {
    await addon.api.checkEmbeddingConnection();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  // @ts-ignore This is a moz feature
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  Zotero.debug(`[ZAIA] ${getString("startup-begin")}`);

  UIExampleFactory.registerStyleSheet(win);

  UIExampleFactory.registerAssistantToolbarButton(win);
  registerPaperContextSelectionWindow(win);
  registerZAIAShortcuts(win);

  Zotero.debug(`[ZAIA] ${getString("startup-finish")}`);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterZAIAShortcuts(win);
  UIExampleFactory.unregisterAssistantToolbarButton(
    win as _ZoteroTypes.MainWindow,
  );
  unregisterAssistantSidebarController(win);
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

async function onShutdown(): Promise<void> {
  addon.data.alive = false;

  try {
    await ollamaLifecycleManager.shutdown();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }

  try {
    await vectorStore.forceSave();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }

  try {
    unregisterAllZAIAShortcuts();
    Zotero.getMainWindows().forEach((win) => {
      UIExampleFactory.unregisterAssistantToolbarButton(win);
      unregisterAssistantSidebarController(win);
    });
    UIExampleFactory.unregisterAssistantSidenavButton();
    UIExampleFactory.unregisterTemplateItemPaneSections();
    ztoolkit.unregisterAll();
    addon.data.dialog?.window?.close();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }

  try {
    await closeChatDatabase();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  } finally {
    // @ts-ignore - Plugin instance is not typed
    delete Zotero[addon.data.config.addonInstance];
  }
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this funcion clear.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // You can add your code to the corresponding notify type
  ztoolkit.log("notify", event, type, ids, extraData);
  if (event == "select") {
    refreshPaperContextControls();
  }

  return;
}

/**
 * This function is just an example of dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this funcion clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      loadSettings();
      registerPrefsScripts(data.window);
      break;
    case "change":
      loadSettings();
      break;
    default:
      return;
  }
}

function onAssistantWindowLoad(data: { owner?: Window; window: Window }) {
  if (!data.owner) return;

  initializeAssistantPopoutWindow(
    data.window,
    data.owner as _ZoteroTypes.MainWindow,
  );
}

function onAssistantWindowUnload(data: { owner?: Window; window: Window }) {
  if (!data.owner) return;

  handleAssistantPopoutWindowUnload(
    data.window,
    data.owner as _ZoteroTypes.MainWindow,
  );
}

function onLocalOllamaModelWindowLoad(data: {
  owner?: Window;
  window: Window;
}) {
  if (!data.owner) return;

  initializeLocalOllamaModelWindow(
    data.window,
    data.owner as _ZoteroTypes.MainWindow,
  );
}

function onLocalOllamaModelWindowUnload(data: {
  owner?: Window;
  window: Window;
}) {
  if (!data.owner) return;

  handleLocalOllamaModelWindowUnload(data.window, data.owner);
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

function onIndexManagerWindowLoad(data: { owner?: Window; window: Window }) {
  if (!data.owner) return;
  void initializeIndexManagerWindow(
    data.window,
    data.owner as _ZoteroTypes.MainWindow,
  );
}

function onIndexManagerWindowUnload(data: { owner?: Window; window: Window }) {
  handleIndexManagerWindowUnload(data.window, data.owner as Window);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onAssistantWindowLoad,
  onAssistantWindowUnload,
  onLocalOllamaModelWindowLoad,
  onLocalOllamaModelWindowUnload,
  onIndexManagerWindowLoad,
  onIndexManagerWindowUnload,
};
