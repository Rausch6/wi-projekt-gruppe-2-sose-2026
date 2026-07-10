import { config } from "../../package.json";
import {
  EMBEDDING_DEFAULT_MODEL,
  REQUIRED_EMBEDDING_MODEL,
} from "../ai/EmbeddingProvider.js";
import type { EmbeddingConnectionResult } from "../ai/embeddingConnectionStatus";
import type { ProviderConnectionResult } from "../ai/providerConnectionStatus";
import {
  KISSKI_DEFAULT_BASE_URL,
  KISSKI_DEFAULT_MODEL,
} from "../ai/providers/KisskiProvider.js";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
} from "../ai/providers/OllamaProvider.js";
import type { LLMProvider, PluginSettings } from "../addon";
import { DEFAULT_METADATA_FIELD_SELECTION } from "../core/MetadataFieldSelection";

const HTML_NS = "http://www.w3.org/1999/xhtml";

type StatusState = "loading" | "success" | "warning" | "error";
type PreferenceValue = string | number | boolean;
type ModelSelectState = "idle" | "loaded" | "empty" | "error";
type ModelOption = {
  id: string;
  name: string;
};
type ModelSelectUpdate = {
  selectedAvailable: boolean;
};

const DEFAULT_SETTINGS = {
  provider: "kisski",
  apiKey: "",
  baseUrl: KISSKI_DEFAULT_BASE_URL,
  model: KISSKI_DEFAULT_MODEL,
  sendPaperContextToKisski: true,
  contextRouterProvider: "ollama",
  embeddingSearchEnabled: true,
  embeddingModel: EMBEDDING_DEFAULT_MODEL,
  maxItems: 200,
  metadataFieldSelection: DEFAULT_METADATA_FIELD_SELECTION,
  ollamaBaseUrl: OLLAMA_DEFAULT_BASE_URL,
  ollamaModel: OLLAMA_DEFAULT_MODEL,
  autoDeleteOldChats: true,
  chunkTargetTokens: 512,
  chunkOverlapTokens: 100,
  chunkCount: 3,
} satisfies PluginSettings;

const FIELD_NAMES = [
  "api-key",
  "base-url",
  "model",
  "send-paper-context-to-kisski",
  "context-router-provider",
  "embedding-search-enabled",
  "ollama-base-url",
  "ollama-model",
  "max-items",
  "auto-delete-old-chats",
] as const;

const INDEX_MANAGER_DEFAULT_WIDTH = 800;
const INDEX_MANAGER_DEFAULT_HEIGHT = 600;
const INDEX_MANAGER_MIN_WIDTH = INDEX_MANAGER_DEFAULT_WIDTH;
const INDEX_MANAGER_MIN_HEIGHT = INDEX_MANAGER_DEFAULT_HEIGHT;
let semanticSearchFocusRequested = false;

const PREFERENCE_FIELD_NAMES: Partial<Record<keyof PluginSettings, string>> = {
  apiKey: "api-key",
  baseUrl: "base-url",
  model: "model",
  sendPaperContextToKisski: "send-paper-context-to-kisski",
  contextRouterProvider: "context-router-provider",
  embeddingSearchEnabled: "embedding-search-enabled",
  maxItems: "max-items",
  ollamaBaseUrl: "ollama-base-url",
  ollamaModel: "ollama-model",
  autoDeleteOldChats: "auto-delete-old-chats",
};

export async function registerPrefsScripts(window: Window) {
  addon.data.prefs = {
    window,
    columns: [],
    rows: [],
  };

  migrateHiddenPreferences();
  applySettingsToFields(window, addon.data.settings);
  bindPreferenceEvents(window);
  applyRequestedPreferenceFocus(window);
}

export function requestSemanticSearchPreferenceFocus() {
  semanticSearchFocusRequested = true;
  const window = addon.data.prefs?.window;
  if (window && !window.closed) applyRequestedPreferenceFocus(window);
}

function applyRequestedPreferenceFocus(window: Window) {
  if (!semanticSearchFocusRequested) return;
  const field = getElement<HTMLInputElement>(
    window,
    "embedding-search-enabled",
  );
  if (!field) return;

  semanticSearchFocusRequested = false;
  field.scrollIntoView({ behavior: "smooth", block: "center" });
  field.focus();
  const container = field.closest<HTMLElement>(".zaia-pref-field");
  container?.classList.add("zaia-pref-field-highlight");
  window.setTimeout(() => {
    container?.classList.remove("zaia-pref-field-highlight");
  }, 2_400);
}

function bindPreferenceEvents(window: Window) {
  for (const fieldName of FIELD_NAMES) {
    getElement<HTMLInputElement | HTMLSelectElement>(
      window,
      fieldName,
    )?.addEventListener("change", () => syncRuntimeSettings(window));
  }

  bindCommand(window, "load-cloud-models", () => {
    void loadModels(window, "kisski");
  });
  bindCommand(window, "test-cloud-connection", () => {
    void testProviderConnection(window, "kisski");
  });
  bindCommand(window, "load-local-models", () => {
    void loadModels(window, "ollama");
  });
  bindCommand(window, "test-local-connection", () => {
    void testProviderConnection(window, "ollama");
  });
  bindCommand(window, "test-embedding-service", () => {
    void testEmbeddingService(window);
  });
  bindCommand(window, "start-indexing", () => {
    void addon.api.backgroundIndexer
      .indexAllLibraryItems()
      .then(
        (stats: {
          newlyIndexed: number;
          alreadyIndexed: number;
          total: number;
        }) => {
          if (stats.newlyIndexed === 0 && stats.total > 0) {
            window.alert(
              "Alle unterstützten Dokumente sind bereits indexiert.",
            );
          } else if (stats.total === 0) {
            window.alert(
              "Keine unterstützten Dokumente (PDFs) in der Bibliothek gefunden.",
            );
          }
        },
      )
      .catch((err: any) => {
        window.alert(`Indexierung fehlgeschlagen: ${err}`);
      });
  });
  bindCommand(window, "open-index-manager", () => {
    openIndexManager(window);
  });
  bindCommand(window, "reset-preferences", () => {
    resetPreferences(window);
  });
}

function bindCommand(
  window: Window,
  name: string,
  handler: (event: Event) => void,
) {
  getElement(window, name)?.addEventListener("command", handler);
}

function syncRuntimeSettings(window: Window) {
  const nextSettings = readSettingsFromFields(window);
  const semanticSearchWasEnabled = addon.data.settings.embeddingSearchEnabled;

  Object.assign(addon.data.settings, nextSettings);
  if (semanticSearchWasEnabled && !nextSettings.embeddingSearchEnabled) {
    addon.api.backgroundIndexer.abort();
  }
  configureProvidersFromSettings();
  void import("../ui/assistantChatController").then(
    ({ handleSetupRelevantSettingsChanged }) => {
      handleSetupRelevantSettingsChanged();
    },
  );
}

function readSettingsFromFields(window: Window): PluginSettings {
  const provider = addon.data.settings.provider || DEFAULT_SETTINGS.provider;
  const contextRouterProvider = readProviderValue(
    window,
    "context-router-provider",
    "ollama",
  );

  return {
    provider,
    apiKey: readTextValue(window, "api-key", ""),
    baseUrl: readTextValue(window, "base-url", KISSKI_DEFAULT_BASE_URL),
    model: readTextValue(window, "model", KISSKI_DEFAULT_MODEL),
    sendPaperContextToKisski: readBooleanValue(
      window,
      "send-paper-context-to-kisski",
      true,
    ),
    contextRouterProvider,
    embeddingSearchEnabled: readBooleanValue(
      window,
      "embedding-search-enabled",
      true,
    ),
    embeddingModel: EMBEDDING_DEFAULT_MODEL,
    maxItems: readNumberValue(window, "max-items", 200, 1, 1000),
    metadataFieldSelection:
      addon.data.settings.metadataFieldSelection ||
      DEFAULT_METADATA_FIELD_SELECTION,
    ollamaBaseUrl: readTextValue(
      window,
      "ollama-base-url",
      OLLAMA_DEFAULT_BASE_URL,
    ),
    ollamaModel: readTextValue(window, "ollama-model", OLLAMA_DEFAULT_MODEL),
    autoDeleteOldChats: readBooleanValue(window, "auto-delete-old-chats", true),
    chunkTargetTokens:
      addon.data.settings.chunkTargetTokens ||
      DEFAULT_SETTINGS.chunkTargetTokens,
    chunkOverlapTokens:
      addon.data.settings.chunkOverlapTokens ||
      DEFAULT_SETTINGS.chunkOverlapTokens,
    chunkCount: addon.data.settings.chunkCount || DEFAULT_SETTINGS.chunkCount,
  };
}

function configureProvidersFromSettings() {
  const settings = addon.data.settings;

  addon.api.ai.setActiveProvider(settings.provider);
  addon.api.ai.configureProvider("kisski", {
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl || undefined,
    model: settings.model || undefined,
  });
  addon.api.ai.configureProvider("ollama", {
    baseUrl: settings.ollamaBaseUrl || undefined,
    model: settings.ollamaModel || undefined,
  });
  addon.api.configureEmbeddings();
}

function migrateHiddenPreferences() {
  const storedEmbeddingModel = getPluginPreference("embeddingModel");
  if (storedEmbeddingModel !== EMBEDDING_DEFAULT_MODEL) {
    setPluginPreference("embeddingModel", EMBEDDING_DEFAULT_MODEL);
    addon.data.settings.embeddingModel = EMBEDDING_DEFAULT_MODEL;
  }
}

async function loadModels(window: Window, provider: LLMProvider) {
  const status = getProviderStatusElement(window, provider);
  const button = getElement<HTMLButtonElement>(
    window,
    provider === "kisski" ? "load-cloud-models" : "load-local-models",
  );

  syncRuntimeSettings(window);
  const selectedModel = getConfiguredModel(provider);
  setButtonBusy(button, true);
  setModelSelectBusy(window, provider, true);
  setStatus(
    status,
    provider === "kisski"
      ? "Cloud-Modelle werden geladen..."
      : "Lokale Modelle werden geladen...",
    "loading",
  );

  try {
    const models = normalizeModelOptions(
      await addon.api.ai.listModels(provider),
      provider,
    );
    const update = setModelSelectOptions(
      window,
      provider,
      models,
      selectedModel,
      models.length ? "loaded" : "empty",
    );

    if (!models.length) {
      setStatus(
        status,
        `${getModelProviderLabel(provider)}: Keine Modelle gefunden.${
          selectedModel ? " Gespeichertes Modell bleibt ausgewählt." : ""
        }`,
        "warning",
      );
      return;
    }

    if (!update.selectedAvailable) {
      setStatus(
        status,
        `${models.length} ${
          models.length === 1 ? "Modell" : "Modelle"
        } geladen. Das gespeicherte Modell ist nicht in der Liste.`,
        "warning",
      );
      return;
    }

    setStatus(
      status,
      `${models.length} ${models.length === 1 ? "Modell" : "Modelle"} geladen.`,
      "success",
    );
  } catch (error) {
    setStatus(
      status,
      `Modelle konnten nicht geladen werden: ${getErrorMessage(error)}`,
      "error",
    );
    setModelSelectOptions(window, provider, [], selectedModel, "error");
  } finally {
    setButtonBusy(button, false);
    setModelSelectBusy(window, provider, false);
  }
}

async function testProviderConnection(window: Window, provider: LLMProvider) {
  const status = getProviderStatusElement(window, provider);
  const button = getElement<HTMLButtonElement>(
    window,
    provider === "kisski" ? "test-cloud-connection" : "test-local-connection",
  );

  syncRuntimeSettings(window);
  setButtonBusy(button, true);
  setStatus(
    status,
    provider === "kisski"
      ? "Cloud-Verbindung wird geprüft..."
      : "Ollama-Verbindung wird geprüft...",
    "loading",
  );

  try {
    const result = await addon.api.checkProviderConnection(provider);
    setStatus(
      status,
      formatProviderConnectionResult(result),
      result.ok ? "success" : "error",
    );
  } catch (error) {
    setStatus(
      status,
      `Verbindungstest fehlgeschlagen: ${getErrorMessage(error)}`,
      "error",
    );
  } finally {
    setButtonBusy(button, false);
  }
}

async function testEmbeddingService(window: Window) {
  const status = getElement<HTMLElement>(window, "embedding-service-status");
  const button = getElement<HTMLButtonElement>(
    window,
    "test-embedding-service",
  );

  syncRuntimeSettings(window);
  setButtonBusy(button, true);
  setStatus(status, "Embedding-Verbindung wird geprüft...", "loading");

  try {
    const result = await addon.api.checkEmbeddingConnection();
    setStatus(
      status,
      formatEmbeddingConnectionResult(result),
      result.ok ? "success" : "error",
    );
  } catch (error) {
    setStatus(
      status,
      `Embedding-Test fehlgeschlagen: ${getErrorMessage(error)}`,
      "error",
    );
  } finally {
    setButtonBusy(button, false);
  }
}

function openIndexManager(window: Window) {
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

  window.openDialog(url, "_blank", features, {
    addonInstance: config.addonInstance,
    owner: window,
  });
}

function resetPreferences(window: Window) {
  const status = getElement<HTMLElement>(window, "reset-status");
  const confirmed = window.confirm(
    "Alle ZAIA-Einstellungen werden auf Standardwerte zurückgesetzt. Der KISSKI API-Key wird dabei entfernt. Fortfahren?",
  );
  if (!confirmed) return;

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS) as Array<
    [keyof PluginSettings, PreferenceValue]
  >) {
    setPluginPreference(key, value);
  }

  Object.assign(addon.data.settings, DEFAULT_SETTINGS);
  applySettingsToFields(window, addon.data.settings);
  configureProvidersFromSettings();
  setStatus(status, "Standardwerte wurden wiederhergestellt.", "success");
}

function applySettingsToFields(window: Window, settings: PluginSettings) {
  setModelSelectOptions(window, "kisski", [], settings.model, "idle");
  setModelSelectOptions(window, "ollama", [], settings.ollamaModel, "idle");

  for (const [key, fieldName] of Object.entries(
    PREFERENCE_FIELD_NAMES,
  ) as Array<[keyof PluginSettings, string]>) {
    setFieldValue(window, fieldName, settings[key] as PreferenceValue);
  }
}

function setFieldValue(window: Window, name: string, value: PreferenceValue) {
  const element = getElement<HTMLInputElement | HTMLSelectElement>(
    window,
    name,
  );
  if (!element) return;

  if (
    element instanceof window.HTMLInputElement &&
    element.type === "checkbox"
  ) {
    element.checked = Boolean(value);
    return;
  }

  element.value = String(value);
}

function readTextValue(window: Window, name: string, fallback: string) {
  const element = getElement<HTMLInputElement | HTMLSelectElement>(
    window,
    name,
  );
  return element ? element.value.trim() : fallback;
}

function readBooleanValue(window: Window, name: string, fallback: boolean) {
  return getElement<HTMLInputElement>(window, name)?.checked ?? fallback;
}

function readNumberValue(
  window: Window,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const rawValue = getElement<HTMLInputElement>(window, name)?.value ?? "";
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue)) return fallback;
  return Math.min(max, Math.max(min, parsedValue));
}

function readProviderValue(
  window: Window,
  name: string,
  fallback: LLMProvider,
): LLMProvider {
  const value = getElement<HTMLSelectElement>(window, name)?.value;
  return value === "ollama" || value === "kisski" ? value : fallback;
}

function normalizeModelOptions(
  models: unknown,
  provider: LLMProvider,
): ModelOption[] {
  if (!Array.isArray(models)) return [];

  const seen = new Set<string>();
  const options: ModelOption[] = [];

  for (const model of models) {
    const record = model as { id?: unknown; name?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    if (provider === "ollama" && isLocalEmbeddingModel(id)) continue;

    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : id;

    seen.add(id);
    options.push({ id, name });
  }

  return options.sort((first, second) =>
    first.name.localeCompare(second.name, undefined, { sensitivity: "base" }),
  );
}

function setModelSelectOptions(
  window: Window,
  provider: LLMProvider,
  models: ModelOption[],
  selectedModel: string,
  state: ModelSelectState,
): ModelSelectUpdate {
  const select = getModelSelect(window, provider);
  const selectedValue = selectedModel.trim();
  if (!select) {
    return { selectedAvailable: false };
  }

  const selectedAvailable = models.some((model) => model.id === selectedValue);
  const options = [
    createModelPlaceholderOption(
      window,
      getModelPlaceholderText(provider, state),
      !selectedValue,
    ),
  ];

  if (selectedValue && !selectedAvailable) {
    options.push(
      createModelOption(
        window,
        selectedValue,
        `${selectedValue} (gespeichert)`,
        true,
      ),
    );
  }

  options.push(
    ...models.map((model) =>
      createModelOption(
        window,
        model.id,
        formatModelOptionLabel(model),
        model.id === selectedValue,
      ),
    ),
  );

  select.replaceChildren(...options);
  select.value = selectedValue;
  select.disabled = !selectedValue && !models.length;
  select.dataset.state = state;

  return {
    selectedAvailable: !selectedValue || selectedAvailable,
  };
}

function createModelPlaceholderOption(
  window: Window,
  label: string,
  selected: boolean,
) {
  const option = createModelOption(window, "", label, selected);
  option.disabled = true;
  return option;
}

function createModelOption(
  window: Window,
  value: string,
  label: string,
  selected: boolean,
) {
  const option = window.document.createElementNS(
    HTML_NS,
    "option",
  ) as HTMLOptionElement;
  option.value = value;
  option.textContent = label;
  option.selected = selected;
  return option;
}

function formatModelOptionLabel(model: ModelOption) {
  return model.name === model.id ? model.id : `${model.name} (${model.id})`;
}

function isLocalEmbeddingModel(model: string) {
  const value = model.trim().toLowerCase();
  if (!value) return false;

  return (
    value === REQUIRED_EMBEDDING_MODEL.toLowerCase() ||
    /(^|[-_/.:])embed(?:ding)?($|[-_/.:])/i.test(value)
  );
}

function formatProviderConnectionResult(result: ProviderConnectionResult) {
  const providerLabel = result.provider === "ollama" ? "Ollama" : "Cloud";
  const model = result.model ? ` (${result.model})` : "";

  if (result.ok) {
    return `${providerLabel}-Verbindung ist bereit${model}.`;
  }

  switch (result.issue) {
    case "api-key-missing":
      return "API-Key fehlt.";
    case "base-url-missing":
      return "Base URL fehlt.";
    case "model-missing":
      return "Modell fehlt.";
    case "model-not-available":
      return `Cloud ist erreichbar, aber das Modell ${result.model ?? ""} ist nicht verfügbar.`;
    case "model-not-installed":
      return `Ollama ist erreichbar, aber das Modell ${result.model ?? ""} ist nicht installiert.`;
    case "provider-unreachable":
      return `${providerLabel} ist nicht erreichbar.`;
    case "invalid-response":
      return `${providerLabel} hat eine unerwartete Antwort gesendet.`;
    case "ollama-not-installed":
      return "Ollama ist nicht installiert.";
    case "ollama-start-failed":
      return "Ollama konnte nicht im Hintergrund gestartet werden.";
    case "ollama-startup-timeout":
      return "Ollama wurde gestartet, ist aber noch nicht erreichbar.";
    default:
      return result.error || result.message || "Verbindung ist nicht bereit.";
  }
}

function formatEmbeddingConnectionResult(result: EmbeddingConnectionResult) {
  const model = result.model ?? REQUIRED_EMBEDDING_MODEL;

  if (result.status === "disabled") {
    return "Semantische Suche ist deaktiviert; Ollama wird dafür nicht verwendet.";
  }

  if (result.ok) {
    return `Embedding-Verbindung ist bereit (${model}).`;
  }

  switch (result.issue) {
    case "base-url-missing":
      return "Embedding Base URL fehlt.";
    case "model-missing":
    case "model-not-installed":
      return `Das benötigte Embedding-Modell ${model} ist in Ollama nicht installiert.`;
    case "provider-unreachable":
      return "Ollama ist für Embeddings nicht erreichbar.";
    case "invalid-response":
      return "Der Embedding-Dienst hat eine unerwartete Antwort gesendet.";
    case "ollama-not-installed":
      return "Ollama ist nicht installiert.";
    case "ollama-start-failed":
      return "Ollama konnte nicht im Hintergrund gestartet werden.";
    case "ollama-startup-timeout":
      return "Ollama wurde gestartet, ist aber noch nicht erreichbar.";
    default:
      return (
        result.error ||
        result.message ||
        "Embedding-Verbindung ist nicht bereit."
      );
  }
}

function getModelSelect(window: Window, provider: LLMProvider) {
  return getElement<HTMLSelectElement>(window, getModelFieldName(provider));
}

function getModelFieldName(provider: LLMProvider) {
  return provider === "ollama" ? "ollama-model" : "model";
}

function getConfiguredModel(provider: LLMProvider) {
  return provider === "ollama"
    ? addon.data.settings.ollamaModel
    : addon.data.settings.model;
}

function getModelProviderLabel(provider: LLMProvider) {
  return provider === "ollama" ? "Ollama" : "Cloud";
}

function getModelPlaceholderText(
  provider: LLMProvider,
  state: ModelSelectState,
) {
  switch (state) {
    case "loaded":
      return "Modell auswählen";
    case "empty":
      return "Keine Modelle gefunden";
    case "error":
      return "Modelle konnten nicht geladen werden";
    default:
      return provider === "ollama"
        ? "Lokale Modelle laden, um auszuwählen"
        : "Cloud-Modelle laden, um auszuwählen";
  }
}

function getProviderStatusElement(window: Window, provider: LLMProvider) {
  return getElement<HTMLElement>(
    window,
    provider === "ollama" ? "local-status" : "cloud-status",
  );
}

function setButtonBusy(button: HTMLButtonElement | null, busy: boolean) {
  if (button) button.disabled = busy;
}

function setModelSelectBusy(
  window: Window,
  provider: LLMProvider,
  busy: boolean,
) {
  const select = getModelSelect(window, provider);
  if (!select) return;

  select.disabled = busy || (!select.value && select.options.length <= 1);
  select.setAttribute("aria-busy", String(busy));
}

function setStatus(
  element: HTMLElement | null,
  message: string,
  state?: StatusState,
) {
  if (!element) return;

  element.textContent = message;
  if (state) {
    element.dataset.state = state;
  } else {
    delete element.dataset.state;
  }
}

function getElement<T extends Element = Element>(window: Window, name: string) {
  return window.document.querySelector<T>(
    `#zotero-prefpane-${config.addonRef}-${name}`,
  );
}

function getPluginPreference(key: keyof PluginSettings) {
  try {
    return Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
  } catch {
    return undefined;
  }
}

function setPluginPreference(
  key: keyof PluginSettings,
  value: PreferenceValue,
) {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, value, true);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
