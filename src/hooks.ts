import {
  BasicExampleFactory,
  HelperExampleFactory,
  KeyExampleFactory,
  PromptExampleFactory,
  UIExampleFactory,
} from "./modules/examples";
import {
  EMBEDDING_DEFAULT_BASE_URL,
  EMBEDDING_DEFAULT_MODEL,
} from "./ai/EmbeddingProvider.js";
import { getString, initLocale } from "./utils/locale";
import { registerPreferencesPane } from "./modules/preferences";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createCheckingProviderConnectionResult } from "./ai/providerConnectionStatus";
import {
  closeChatDatabase,
  initializeChatDatabase,
} from "./persistence/ChatDatabase";
import { ChatRepository } from "./core/ChatRepository";
import { initializeChatPersistence } from "./ui/assistantChatController";
import {
  handleAssistantPopoutWindowUnload,
  initializeAssistantPopoutWindow,
} from "./ui/assistantPopoutWindow";
import { unregisterAssistantSidebarController } from "./ui/assistantSidebarController";
import { createZToolkit } from "./utils/ztoolkit";
import type { LLMProvider } from "./addon";
import { vectorStore } from "./core/OramaService";
import { backgroundIndexer } from "./core/BackgroundIndexer";

const OLD_CHAT_RETENTION_DAYS = 14;

// Reads one setting from Zotero's preference storage for this plugin.
// The prefix keeps our settings separate from Zotero's own settings.
function getPluginPref(key: string) {
  return Zotero.Prefs.get(`${addon.data.config.prefsPrefix}.${key}`, true);
}

function getStringSetting(key: string, fallback = "") {
  const value = getPluginPref(key);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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
    embeddingSearchEnabled: getBooleanSetting("embeddingSearchEnabled", true),
    embeddingBaseUrl: getStringSetting(
      "embeddingBaseUrl",
      EMBEDDING_DEFAULT_BASE_URL,
    ),
    embeddingModel: getStringSetting("embeddingModel", EMBEDDING_DEFAULT_MODEL),
    maxItems: getNumberSetting("maxItems", 20),
    ollamaBaseUrl: getStringSetting("ollamaBaseUrl", "http://localhost:11434"),
    ollamaModel: getStringSetting("ollamaModel", "qwen2.5:3b"),
    autoDeleteOldChats: getBooleanSetting("autoDeleteOldChats", true),
  };
  addon.api.configureAI();
  addon.api.configureEmbeddings();
}

async function onStartup() {
  await new Promise(resolve => setTimeout(resolve, 1000));
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

    backgroundIndexer.indexAllLibraryItems().catch((err) => {
      Zotero.debug(`[BackgroundIndexer] Erst-Indexierung fehlgeschlagen: ${err}`);
    });
  } catch (err: any) {
    Zotero.debug(`[ZAIA-Startup] CRITICAL ERROR IN ONSTARTUP: ${err}\n${err.stack}`);
  }


  void checkActiveProviderConnectionOnStartup();
  await initializeChatDatabase();
  await cleanupOldChatsOnStartup();
  await initializeChatPersistence();

  await registerPreferencesPane();

  BasicExampleFactory.registerNotifier();

  KeyExampleFactory.registerShortcuts();

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

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  // @ts-ignore This is a moz feature
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString("startup-begin"),
      type: "default",
      progress: 0,
    })
    .show();

  await Zotero.Promise.delay(1000);
  popupWin.changeLine({
    progress: 30,
    text: `[30%] ${getString("startup-begin")}`,
  });

  UIExampleFactory.registerStyleSheet(win);

  UIExampleFactory.registerAssistantToolbarButton(win);

  UIExampleFactory.registerRightClickMenuItem();

  UIExampleFactory.registerRightClickMenuPopup(win);

  UIExampleFactory.registerWindowMenuWithSeparator();

  PromptExampleFactory.registerNormalCommandExample();

  PromptExampleFactory.registerAnonymousCommandExample(win);

  PromptExampleFactory.registerConditionalCommandExample();

  await Zotero.Promise.delay(1000);

  popupWin.changeLine({
    progress: 100,
    text: `[100%] ${getString("startup-finish")}`,
  });
  popupWin.startCloseTimer(5000);

  // addon.hooks.onDialogEvents("dialogExample");
}

async function onMainWindowUnload(win: Window): Promise<void> {
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
    await vectorStore.forceSave();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }

  try {
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
  if (
    event == "select" &&
    type == "tab" &&
    extraData[ids[0]].type == "reader"
  ) {
    BasicExampleFactory.exampleNotifierCallback();
  } else {
    return;
  }
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

function onShortcuts(type: string) {
  switch (type) {
    case "larger":
      KeyExampleFactory.exampleShortcutLargerCallback();
      break;
    case "smaller":
      KeyExampleFactory.exampleShortcutSmallerCallback();
      break;
    default:
      break;
  }
}

function onDialogEvents(type: string) {
  switch (type) {
    case "manualTrigger":
      Zotero.debug("[ZAIA-ManualTrigger] User requested manual background indexer start.");
      Zotero.getMainWindow()?.alert("Starte BackgroundIndexer manuell...");
      backgroundIndexer.indexAllLibraryItems()
        .then(() => Zotero.getMainWindow()?.alert("Indexer-Startbefehl gesendet!"))
        .catch(err => {
          Zotero.debug("[ZAIA-ManualTrigger] Error: " + err);
          Zotero.getMainWindow()?.alert("Fehler beim Indexer: " + err);
        });
      break;
    case "dialogExample":
      HelperExampleFactory.dialogExample();
      break;
    case "clipboardExample":
      HelperExampleFactory.clipboardExample();
      break;
    case "filePickerExample":
      HelperExampleFactory.filePickerExample();
      break;
    case "progressWindowExample":
      HelperExampleFactory.progressWindowExample();
      break;
    case "vtableExample":
      HelperExampleFactory.vtableExample();
      break;
    default:
      break;
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

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
  onAssistantWindowLoad,
  onAssistantWindowUnload,
};
