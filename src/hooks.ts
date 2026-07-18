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

/**
 * Liest eine Plugin-Preference aus Zotero.
 *
 * @param key - Preference-Schluessel ohne Addon-Prefix.
 * @returns Gespeicherter Preference-Wert.
 */
function getPluginPref(key: string) {
  return Zotero.Prefs.get(`${addon.data.config.prefsPrefix}.${key}`, true);
}

/**
 * Liest eine String-Preference.
 *
 * @param key - Preference-Schluessel.
 * @param fallback - Rueckgabewert bei fehlendem String.
 * @returns Getrimmter String oder Fallback.
 */
function getStringSetting(key: string, fallback = "") {
  const value = getPluginPref(key);
  return typeof value === "string" ? value.trim() : fallback;
}

/**
 * Liest eine Number-Preference.
 *
 * @param key - Preference-Schluessel.
 * @param fallback - Rueckgabewert bei fehlender Zahl.
 * @returns Gespeicherte Zahl oder Fallback.
 */
function getNumberSetting(key: string, fallback: number) {
  const value = getPluginPref(key);
  return typeof value === "number" ? value : fallback;
}

/**
 * Liest eine Boolean-Preference.
 *
 * @param key - Preference-Schluessel.
 * @param fallback - Rueckgabewert bei fehlendem Boolean.
 * @returns Gespeicherter Boolean oder Fallback.
 */
function getBooleanSetting(key: string, fallback: boolean) {
  const value = getPluginPref(key);
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Laedt alle Plugin-Einstellungen aus Zotero und konfiguriert Provider neu.
 *
 * @returns void.
 */
function loadSettings() {
  // Der persistierte Provider wird zusammen mit seinen jeweiligen Modell- und
  // Verbindungswerten geladen, bevor die öffentlichen APIs konfiguriert werden.
  addon.data.settings = {
    provider: getProviderSetting(),
    apiKey: getStringSetting("apiKey"),
    baseUrl: getStringSetting("baseUrl", "https://chat-ai.academiccloud.de/v1"),
    // Cloud- und Ollama-Modell werden getrennt geladen, damit die zuletzt
    // getroffene Auswahl beim Wechsel des Providers erhalten bleibt.
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
    initialIndexPromptShown: getBooleanSetting(
      "initialIndexPromptShown",
      false,
    ),
    chunkTargetTokens: getNumberSetting("chunkTargetTokens", 1024),
    chunkOverlapTokens: getNumberSetting("chunkOverlapTokens", 100),
    chunkCount: getNumberSetting("chunkCount", 3),
  };
  // Erst nach dem vollständigen Laden darf der Provider-Manager umgeschaltet
  // werden, damit er sofort die passenden Cloud- oder Ollama-Werte erhält.
  addon.api.configureAI();
  addon.api.configureEmbeddings();
}

/**
 * Initialisiert Addon-Dienste nach dem Zotero-Start.
 *
 * @returns Promise, das nach Abschluss der Startup-Routine aufloest.
 */
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

    // Wir loggen hier nicht mehr automatisch alle indexierten Dokumente,
    // um "Item data not loaded" Warnungen beim Zotero-Start zu vermeiden.

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

  UIExampleFactory.registerItemPaneCustomInfoRow();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
}

/**
 * Loescht alte, nicht favorisierte Chats beim Start.
 *
 * @returns Promise, das nach der Bereinigung aufloest.
 */
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

/**
 * Liest den aktiven Chat-Provider aus den Einstellungen.
 *
 * @returns Normalisierte Provider-ID.
 */
function getProviderSetting(): LLMProvider {
  // Alte oder ungültige Preference-Werte dürfen keinen unbekannten Provider in
  // den Manager übertragen und fallen deshalb auf KISSKI zurück.
  const value = getStringSetting("provider", "kisski");
  return value === "ollama" ? "ollama" : "kisski";
}

/**
 * Liest den Provider fuer die Router-KI aus den Einstellungen.
 *
 * @returns Normalisierte Router-Provider-ID.
 */
function getContextRouterProviderSetting(): LLMProvider {
  const value = getStringSetting("contextRouterProvider", "ollama");
  return value === "kisski" ? "kisski" : "ollama";
}

/**
 * Prueft beim Start die Verbindung zum aktiven Chat-Provider.
 *
 * @returns Promise, das nach der Pruefung aufloest.
 */
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

/**
 * Prueft beim Start die Verbindung zum Embedding-Modell.
 *
 * @returns Promise, das nach der Pruefung aufloest.
 */
async function checkEmbeddingConnectionOnStartup() {
  addon.data.runtime.embeddingConnection =
    createCheckingEmbeddingConnectionResult();

  try {
    await addon.api.checkEmbeddingConnection();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Initialisiert UI-Komponenten fuer ein Zotero-Hauptfenster.
 *
 * @param win - Zotero-Hauptfenster.
 * @returns Promise, das nach der Fensterinitialisierung aufloest.
 */
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

/**
 * Raeumt UI-Komponenten eines Zotero-Hauptfensters auf.
 *
 * @param win - Zu entladendes Fenster.
 * @returns Promise, das nach dem Aufraeumen aufloest.
 */
async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterZAIAShortcuts(win);
  UIExampleFactory.unregisterAssistantToolbarButton(
    win as _ZoteroTypes.MainWindow,
  );
  unregisterAssistantSidebarController(win);
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

/**
 * Fuehrt globale Shutdown-Aufraeumarbeiten des Addons aus.
 *
 * @returns Promise, das nach dem Shutdown aufloest.
 */
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
 * Verarbeitet Zotero-Notify-Events und aktualisiert bei Auswahlwechseln die Paper-Kontext-UI.
 *
 * @param event - Zotero-Notify-Eventname.
 * @param type - Zotero-Objekttyp des Events.
 * @param ids - Betroffene Zotero-IDs.
 * @param extraData - Zusaetzliche Eventdaten.
 * @returns Promise, das nach der Verarbeitung aufloest.
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
 * Verarbeitet Events der Preference-UI.
 *
 * @param type - Eventtyp der Preferences.
 * @param data - Eventdaten, z. B. das Preference-Fenster.
 * @returns Promise, das nach der Verarbeitung aufloest.
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

/**
 * Initialisiert das ausgelagerte Assistant-Chatfenster.
 *
 * @param data - Fensterdaten mit Owner- und Zielwindow.
 * @returns void.
 */
function onAssistantWindowLoad(data: { owner?: Window; window: Window }) {
  if (!data.owner) return;

  initializeAssistantPopoutWindow(
    data.window,
    data.owner as _ZoteroTypes.MainWindow,
  );
}

/**
 * Raeumt das ausgelagerte Assistant-Chatfenster auf.
 *
 * @param data - Fensterdaten mit Owner- und Zielwindow.
 * @returns void.
 */
function onAssistantWindowUnload(data: { owner?: Window; window: Window }) {
  if (!data.owner) return;

  handleAssistantPopoutWindowUnload(
    data.window,
    data.owner as _ZoteroTypes.MainWindow,
  );
}

/**
 * Initialisiert das lokale Ollama-Modellfenster.
 *
 * @param data - Fensterdaten mit Owner- und Zielwindow.
 * @returns void.
 */
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

/**
 * Raeumt das lokale Ollama-Modellfenster auf.
 *
 * @param data - Fensterdaten mit Owner- und Zielwindow.
 * @returns void.
 */
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

/**
 * Initialisiert das Index-Manager-Fenster.
 *
 * @param data - Fensterdaten mit Owner- und Zielwindow.
 * @returns void.
 */
function onIndexManagerWindowLoad(data: { owner?: Window; window: Window }) {
  if (!data.owner) return;
  void initializeIndexManagerWindow(
    data.window,
    data.owner as _ZoteroTypes.MainWindow,
  );
}

/**
 * Raeumt das Index-Manager-Fenster auf.
 *
 * @param data - Fensterdaten mit Owner- und Zielwindow.
 * @returns void.
 */
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
