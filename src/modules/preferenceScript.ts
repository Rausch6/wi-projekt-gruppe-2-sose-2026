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
import { openIndexManagerWindow } from "../ui/indexManagerLauncher";

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
  initialIndexPromptShown: false,
  chunkTargetTokens: 1024,
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

/**
 * Initializes the preference window, migrates hidden values, and binds UI events.
 *
 * @param window - Preference window to initialize.
 * @returns Promise that resolves when preference scripts are registered.
 */
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

/**
 * Requests that the semantic search preference receives focus when preferences open.
 *
 * @returns Nothing.
 */
export function requestSemanticSearchPreferenceFocus() {
  semanticSearchFocusRequested = true;
  const window = addon.data.prefs?.window;
  if (window && !window.closed) applyRequestedPreferenceFocus(window);
}

/**
 * Applies a pending semantic search focus request to the given window.
 *
 * @param window - Preference window containing the semantic search field.
 * @returns Nothing.
 */
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

/**
 * Binds preference field and command events in the preference window.
 *
 * @param window - Preference window whose controls should be wired.
 * @returns Nothing.
 */
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
  bindCommand(window, "open-index-manager", () => {
    openIndexManagerWindow(window);
  });
  bindCommand(window, "reset-preferences", () => {
    resetPreferences(window);
  });

  const clampChunkLimit = (fieldName: string, prefName: keyof PluginSettings) => {
    const input = getElement<HTMLInputElement>(window, fieldName);
    if (input) {
      input.addEventListener("change", () => {
        const val = parseInt(input.value, 10);
        if (val > 8192) {
          input.value = "8192";
          setPluginPreference(prefName, 8192);
        }
      });
    }
  };
  clampChunkLimit("chunk-target-tokens", "chunkTargetTokens");
  clampChunkLimit("chunk-overlap-tokens", "chunkOverlapTokens");
}

/**
 * Binds a command handler to a preference control.
 *
 * @param window - Preference window containing the command element.
 * @param name - Preference element suffix to bind.
 * @param handler - Event handler invoked for the command.
 * @returns Nothing.
 */
function bindCommand(
  window: Window,
  name: string,
  handler: (event: Event) => void,
) {
  getElement(window, name)?.addEventListener("command", handler);
}

/**
 * Synchronizes preference fields into runtime settings and provider configuration.
 *
 * @param window - Preference window whose fields should be read.
 * @returns Nothing.
 */
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

/**
 * Reads plugin settings from the preference window fields.
 *
 * @param window - Preference window whose fields should be read.
 * @returns Complete plugin settings object built from current field values.
 */
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
    initialIndexPromptShown:
      addon.data.settings.initialIndexPromptShown ??
      DEFAULT_SETTINGS.initialIndexPromptShown,
    chunkTargetTokens:
      addon.data.settings.chunkTargetTokens ||
      DEFAULT_SETTINGS.chunkTargetTokens,
    chunkOverlapTokens:
      addon.data.settings.chunkOverlapTokens ||
      DEFAULT_SETTINGS.chunkOverlapTokens,
    chunkCount: addon.data.settings.chunkCount || DEFAULT_SETTINGS.chunkCount,
  };
}

/**
 * Applies runtime settings to the active provider, configured providers, and embeddings.
 *
 * @returns Nothing.
 */
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

/**
 * Migrates hidden preferences that are not directly exposed as editable fields.
 *
 * @returns Nothing.
 */
function migrateHiddenPreferences() {
  const storedEmbeddingModel = getPluginPreference("embeddingModel");
  if (storedEmbeddingModel !== EMBEDDING_DEFAULT_MODEL) {
    setPluginPreference("embeddingModel", EMBEDDING_DEFAULT_MODEL);
    addon.data.settings.embeddingModel = EMBEDDING_DEFAULT_MODEL;
  }
}

/**
 * Loads available models for a provider and updates the matching select field.
 *
 * @param window - Preference window containing model controls.
 * @param provider - Provider whose models should be loaded.
 * @returns Promise that resolves after the model list and status have been updated.
 */
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

/**
 * Tests the selected provider connection and updates the related status element.
 *
 * @param window - Preference window containing provider status controls.
 * @param provider - Provider whose connection should be tested.
 * @returns Promise that resolves after the connection test is complete.
 */
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

/**
 * Tests the embedding service connection and updates its status element.
 *
 * @param window - Preference window containing embedding service controls.
 * @returns Promise that resolves after the embedding test is complete.
 */
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

/**
 * Resets all plugin preferences to their default values after confirmation.
 *
 * @param window - Preference window used for confirmation and field updates.
 * @returns Nothing.
 */
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

/**
 * Writes plugin settings into preference fields.
 *
 * @param window - Preference window containing the fields.
 * @param settings - Settings whose values should be displayed.
 * @returns Nothing.
 */
function applySettingsToFields(window: Window, settings: PluginSettings) {
  setModelSelectOptions(window, "kisski", [], settings.model, "idle");
  setModelSelectOptions(window, "ollama", [], settings.ollamaModel, "idle");

  for (const [key, fieldName] of Object.entries(
    PREFERENCE_FIELD_NAMES,
  ) as Array<[keyof PluginSettings, string]>) {
    setFieldValue(window, fieldName, settings[key] as PreferenceValue);
  }
}

/**
 * Writes a single value to a preference field.
 *
 * @param window - Preference window containing the field.
 * @param name - Preference element suffix.
 * @param value - Value to write into the field.
 * @returns Nothing.
 */
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

/**
 * Reads and trims a text-like preference value.
 *
 * @param window - Preference window containing the field.
 * @param name - Preference element suffix.
 * @param fallback - Value returned when the field is missing.
 * @returns Trimmed field value or fallback.
 */
function readTextValue(window: Window, name: string, fallback: string) {
  const element = getElement<HTMLInputElement | HTMLSelectElement>(
    window,
    name,
  );
  return element ? element.value.trim() : fallback;
}

/**
 * Reads a checkbox preference value.
 *
 * @param window - Preference window containing the checkbox.
 * @param name - Preference element suffix.
 * @param fallback - Value returned when the checkbox is missing.
 * @returns Checkbox state or fallback.
 */
function readBooleanValue(window: Window, name: string, fallback: boolean) {
  return getElement<HTMLInputElement>(window, name)?.checked ?? fallback;
}

/**
 * Reads a numeric preference value constrained to a range.
 *
 * @param window - Preference window containing the number field.
 * @param name - Preference element suffix.
 * @param fallback - Value returned when parsing fails.
 * @param min - Minimum accepted value.
 * @param max - Maximum accepted value.
 * @returns Parsed number clamped to the configured range.
 */
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

/**
 * Reads a provider selection from a preference select field.
 *
 * @param window - Preference window containing the select field.
 * @param name - Preference element suffix.
 * @param fallback - Provider returned when the field is missing or invalid.
 * @returns Selected provider or fallback.
 */
function readProviderValue(
  window: Window,
  name: string,
  fallback: LLMProvider,
): LLMProvider {
  const value = getElement<HTMLSelectElement>(window, name)?.value;
  return value === "ollama" || value === "kisski" ? value : fallback;
}

/**
 * Normalizes provider model records into sorted select options.
 *
 * @param models - Raw model records returned by the provider API.
 * @param provider - Provider whose model records are being normalized.
 * @returns Sorted and deduplicated model options.
 */
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

/**
 * Replaces the model select options for a provider.
 *
 * @param window - Preference window containing the select field.
 * @param provider - Provider whose select field should be updated.
 * @param models - Model options to display.
 * @param selectedModel - Currently configured model value.
 * @param state - Loading state represented by the select field.
 * @returns Update metadata describing whether the selected model was available.
 */
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

/**
 * Creates the disabled placeholder option for a model select field.
 *
 * @param window - Preference window used to create DOM nodes.
 * @param label - Placeholder label.
 * @param selected - Whether the placeholder should be selected.
 * @returns Placeholder option element.
 */
function createModelPlaceholderOption(
  window: Window,
  label: string,
  selected: boolean,
) {
  const option = createModelOption(window, "", label, selected);
  option.disabled = true;
  return option;
}

/**
 * Creates a selectable model option.
 *
 * @param window - Preference window used to create DOM nodes.
 * @param value - Option value.
 * @param label - Option label.
 * @param selected - Whether the option should be selected.
 * @returns Model option element.
 */
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

/**
 * Formats a model option for display.
 *
 * @param model - Model option to format.
 * @returns Display label for the option.
 */
function formatModelOptionLabel(model: ModelOption) {
  return model.name === model.id ? model.id : `${model.name} (${model.id})`;
}

/**
 * Checks whether a model ID represents a local embedding model.
 *
 * @param model - Model identifier to inspect.
 * @returns True when the model appears to be an embedding model.
 */
function isLocalEmbeddingModel(model: string) {
  const value = model.trim().toLowerCase();
  if (!value) return false;

  return (
    value === REQUIRED_EMBEDDING_MODEL.toLowerCase() ||
    /(^|[-_/.:])embed(?:ding)?($|[-_/.:])/i.test(value)
  );
}

/**
 * Formats a provider connection result for display in preferences.
 *
 * @param result - Provider connection result to format.
 * @returns Human-readable provider connection status.
 */
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

/**
 * Formats an embedding connection result for display in preferences.
 *
 * @param result - Embedding connection result to format.
 * @returns Human-readable embedding connection status.
 */
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

/**
 * Gets the model select element for a provider.
 *
 * @param window - Preference window containing the select element.
 * @param provider - Provider whose model field should be returned.
 * @returns Model select element, or null when it is missing.
 */
function getModelSelect(window: Window, provider: LLMProvider) {
  return getElement<HTMLSelectElement>(window, getModelFieldName(provider));
}

/**
 * Resolves the preference field name for a provider's model setting.
 *
 * @param provider - Provider whose model field name should be returned.
 * @returns Preference element suffix for the provider model.
 */
function getModelFieldName(provider: LLMProvider) {
  return provider === "ollama" ? "ollama-model" : "model";
}

/**
 * Reads the currently configured model for a provider.
 *
 * @param provider - Provider whose configured model should be read.
 * @returns Configured model name.
 */
function getConfiguredModel(provider: LLMProvider) {
  return provider === "ollama"
    ? addon.data.settings.ollamaModel
    : addon.data.settings.model;
}

/**
 * Formats the provider name used in preference status messages.
 *
 * @param provider - Provider whose label should be returned.
 * @returns Human-readable provider label.
 */
function getModelProviderLabel(provider: LLMProvider) {
  return provider === "ollama" ? "Ollama" : "Cloud";
}

/**
 * Builds placeholder text for a model select field.
 *
 * @param provider - Provider whose placeholder should be built.
 * @param state - Current model select state.
 * @returns Placeholder text for the select field.
 */
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

/**
 * Gets the provider status element for the selected provider.
 *
 * @param window - Preference window containing status elements.
 * @param provider - Provider whose status element should be returned.
 * @returns Status element, or null when it is missing.
 */
function getProviderStatusElement(window: Window, provider: LLMProvider) {
  return getElement<HTMLElement>(
    window,
    provider === "ollama" ? "local-status" : "cloud-status",
  );
}

/**
 * Toggles the disabled state of a button while async work is running.
 *
 * @param button - Button to update.
 * @param busy - Whether the button should be disabled.
 * @returns Nothing.
 */
function setButtonBusy(button: HTMLButtonElement | null, busy: boolean) {
  if (button) button.disabled = busy;
}

/**
 * Toggles busy state for a provider model select field.
 *
 * @param window - Preference window containing the select field.
 * @param provider - Provider whose select field should be updated.
 * @param busy - Whether the select field is currently busy.
 * @returns Nothing.
 */
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

/**
 * Writes a message and optional state to a status element.
 *
 * @param element - Status element to update.
 * @param message - Text to display.
 * @param state - Optional status state stored in the dataset.
 * @returns Nothing.
 */
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

/**
 * Finds a preference element by generated ZAIA preference ID.
 *
 * @param window - Preference window to search.
 * @param name - Preference element suffix.
 * @returns Matching element, or null when it is missing.
 */
function getElement<T extends Element = Element>(window: Window, name: string) {
  return window.document.querySelector<T>(
    `#zotero-prefpane-${config.addonRef}-${name}`,
  );
}

/**
 * Reads a plugin preference value safely.
 *
 * @param key - Plugin setting key to read.
 * @returns Stored preference value, or undefined when reading fails.
 */
function getPluginPreference(key: keyof PluginSettings) {
  try {
    return Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
  } catch {
    return undefined;
  }
}

/**
 * Stores a plugin preference value.
 *
 * @param key - Plugin setting key to write.
 * @param value - Preference value to store.
 * @returns Nothing.
 */
function setPluginPreference(
  key: keyof PluginSettings,
  value: PreferenceValue,
) {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, value, true);
}

/**
 * Converts an unknown thrown value into a message string.
 *
 * @param error - Error-like value to format.
 * @returns Error message string.
 */
function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
