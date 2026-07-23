import { ChatRepository } from "../core/ChatRepository";
import { ItemManager } from "../core/ItemManager";
import {
  LibraryScopeManager,
  type RagItemCandidate,
} from "../core/LibraryScopeManager";
import {
  PaperContextService,
  type PaperReference,
} from "../core/PaperContextService";
import {
  decidePromptContextRoute,
  type PromptContextRouteDecision,
  type PromptContextRouterCandidate,
} from "../core/PromptContextRouter";
import {
  getMetadataFieldSelectionLabel,
  getMetadataFieldsForSelection,
  normalizeMetadataFieldSelection,
  type MetadataFieldSelection,
} from "../core/MetadataFieldSelection";
import { CreateChatInput, StoredChat } from "../core/chatTypes";
import { renderMarkdownContent } from "./markdownRenderer";
import type { LLMProvider } from "../addon";
import { REQUIRED_EMBEDDING_MODEL } from "../ai/EmbeddingProvider.js";
import { OLLAMA_DEFAULT_MODEL } from "../ai/providers/OllamaProvider.js";
import { KISSKI_MODEL_OPTIONS } from "../ai/providers/KisskiProvider.js";
import {
  createCheckingProviderConnectionResult,
  createProviderConnectionResult,
  type ProviderConnectionResult,
} from "../ai/providerConnectionStatus";
import {
  createCheckingEmbeddingConnectionResult,
  type EmbeddingConnectionResult,
} from "../ai/embeddingConnectionStatus";
import { getString } from "../utils/locale";
import {
  deriveSetupReadiness,
  type SetupMilestone,
  type SetupReadiness,
} from "../core/SetupReadiness";
import {
  openPreferencesPane,
  openSemanticSearchPreference,
} from "../modules/preferences";
import {
  LOCAL_OLLAMA_MODEL_INSTALLED_EVENT,
  LOCAL_OLLAMA_MODELS_CHANGED_EVENT,
  formatProgressStatus,
  getFriendlyErrorMessage,
  isAbortError,
  openLocalOllamaModelWindow,
  type LocalModelProgress,
} from "./localOllamaModelWindow";
import { createWindowAbortController } from "../utils/AbortController";
import { getSelectableLocalModelValues } from "./localOllamaModels";
import { vectorStore } from "../core/OramaService";
import { openIndexManagerWindow } from "./indexManagerLauncher";
import {
  getUnindexedPaperContextCount,
  getUnindexedPaperContextWarning,
} from "./paperContextIndexStatus";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_GENERATED_TITLE_LENGTH = 80;
const TITLE_GENERATION_SYSTEM_PROMPT =
  "Erstelle einen knappen, natürlichen Chat-Titel auf der Sprache der ersten Nachricht des Nutzers.\n\n" +
  "Leite den Titel aus der ersten Nutzernachricht ab. Erfasse das zentrale Anliegen oder Thema, nicht zwingend den Satzanfang oder einzelne Schlüsselwörter.\n\n" +
  "Der Titel soll folgendermaßen wirken: kurz, präzise, thematisch, als Tab- oder Listenlabel geeignet.\n\n" +
  "Regeln:\n\n" +
  "* 2 bis 6 Wörter\n" +
  "* Keine ganzen Sätze\n" +
  "* Keine Frageform\n" +
  "* Keine Einleitung\n" +
  "* Keine Anführungszeichen\n" +
  "* Kein Punkt am Ende\n" +
  "* Keine Ich-Form\n" +
  "* Keine Höflichkeits- oder Füllwörter wie bitte, gerade, kannst du, ich, mein\n" +
  "* Keine Formulierungen wie „Hilfe bei“, „Frage zu“ oder „Anfrage über“, außer sie sind inhaltlich notwendig\n" +
  "* Verwende möglichst konkrete Substantive oder kurze Nominalgruppen\n" +
  "* Bei technischen Fragen nenne das konkrete Thema, Tool oder Problem\n" +
  "* Bei Schreibaufgaben nenne Textart und Ziel, zum Beispiel „Bewerbung optimieren“ oder „E-Mail formulieren“\n" +
  "* Bei Smalltalk abstrahiere sinnvoll, zum Beispiel „Begrüßung“, „Vorstellung“ oder „Namensfrage“\n\n" +
  "Gib ausschließlich den Titel zurück.";

type ChatRole = "user" | "assistant" | "system" | "error";
type RequestMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type AIUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

type AIStreamEvent = {
  type?: unknown;
  content?: unknown;
  usage?: AIUsage | null;
};

type AIChatResult = {
  content?: unknown;
  usage?: AIUsage | null;
};

/**
 * Represents a chat message rendered in the assistant UI.
 */
export type AssistantChatMessage = {
  id: number;
  role: ChatRole;
  content: string;
  tokenUsage?: AIUsage;
};

type PendingSimulationPrompt = {
  id: number;
  content: string;
};

type ActiveAssistantResponse = {
  prompt: string;
  activity: string;
  phase: "waiting" | "reasoning" | "content";
  assistantMessage: AssistantChatMessage | null;
  pendingContent: string;
};

type ActiveChatResolution = {
  chatID: string;
  shouldGenerateTitle: boolean;
};

type PaperContextEntry = PaperReference & {
  title: string;
  firstCreator: string;
  year: string;
  source: "automatic" | "manual";
};

type PaperLibraryOption = PaperContextEntry & {
  libraryName: string;
  searchText: string;
};

type ModelOption = {
  id: string;
  name: string;
  ownedBy?: string;
};

type ModelLoadState = {
  status: "idle" | "loading" | "loaded" | "error";
  message?: string;
  requestID?: number;
};

type SidebarView = "chat" | "about";

type SetupModelDownloadTarget = "local-model" | "embedding";
type SetupModelDownloadState = {
  status: "downloading" | "error";
  percent: number | null;
  statusText: string;
  controller?: AbortController;
};

const hosts = new Set<HTMLElement>();
const messages: AssistantChatMessage[] = [];
const chatSummaries: StoredChat[] = [];
const pendingSimulationPrompts: PendingSimulationPrompt[] = [];
const pendingGeneratedTitleChatIDs = new Set<string>();
const modelDropdownDocuments = new WeakSet<Document>();
const metadataPopoverDocuments = new WeakSet<Document>();
const paperContextSelectionWindows = new WeakSet<Window>();
const manualPaperContextEntries = new Map<string, PaperContextEntry>();
let paperLibraryOptions: PaperLibraryOption[] = [];
let paperLibraryLoadState: "idle" | "loading" | "loaded" | "error" = "idle";
let paperLibraryLoadError = "";
let paperLibrarySearchValue = "";
let paperContextSelectionPollID: number | null = null;
let lastAutomaticPaperContextSignature = "";
const modelOptionsByProvider = new Map<LLMProvider, ModelOption[]>([
  ["kisski", normalizeModelOptions(KISSKI_MODEL_OPTIONS)],
]);
const modelLoadStates = new Map<LLMProvider, ModelLoadState>();
const providerConnectionRequestIDs = new Map<LLMProvider, number>();
const localModelInstallEventWindows = new WeakSet<Window>();
const sidebarViews = new WeakMap<HTMLElement, SidebarView>();
const setupModelDownloads = new Map<
  SetupModelDownloadTarget,
  SetupModelDownloadState
>();

let nextMessageID = 1;
let nextModelLoadRequestID = 1;
let nextProviderConnectionRequestID = 1;
let nextEmbeddingConnectionRequestID = 1;
let activeChatID: string | null = null;
let showAllChats = false;
let chatSummariesLoaded = false;
let simulationEnabled = false;
let requestRunning = false;
let activeChatRequestID = 0;
let activeChatCancelRequested = false;
let modelPickerExpanded = false;
let activeAssistantResponse: ActiveAssistantResponse | null = null;
let ollamaSetupLaunchRunning = false;
let ollamaSetupStatusText = "";
let ollamaStartRunning = false;
let ollamaTerminateRunning = false;
let lastPromptContextRouteDebug: PromptContextRouteDebug | null = null;
let lastAssistantRequestDebug: AssistantRequestDebug | null = null;
let setupStalled = false;
let setupStallTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let setupWasVisible = false;

const SETUP_STALL_TIMEOUT_MS = 3_000;

/**
 * Captures the last prompt routing decision for diagnostics.
 */
export type PromptContextRouteDebug = {
  prompt: string;
  provider: LLMProvider;
  model: string;
  status: "routed" | "skipped" | "fallback";
  decision: PromptContextRouteDecision;
  candidateCount: number;
  selectedItemIDs: number[];
  contextMode: string;
  routerUsesChatHistory: false;
  routerMessageCount: number;
  createdAt: string;
  error?: string;
};

/**
 * Captures the last assistant request payload for diagnostics.
 */
export type AssistantRequestDebug = {
  provider: LLMProvider;
  model: string;
  transport: "stream" | "buffered";
  messageCount: number;
  messages: RequestMessage[];
  createdAt: string;
};

/**
 * Binds assistant chat behavior to a rendered sidebar host.
 *
 * @param host - Sidebar host element containing the assistant UI.
 * @returns Nothing.
 */
export function bindAssistantChat(host: HTMLElement) {
  hosts.add(host);

  const textarea = host.querySelector<HTMLTextAreaElement>(".zai-input");
  const sendButton = host.querySelector<HTMLButtonElement>(".zai-send-button");
  const chatList = host.querySelector<HTMLElement>(".zai-chat-list");
  const seeAllButton = host.querySelector<HTMLButtonElement>(".zai-see-all");
  const backButton = host.querySelector<HTMLButtonElement>(
    ".zai-chat-back-button",
  );
  const favoriteButton = host.querySelector<HTMLButtonElement>(
    ".zai-chat-favorite-button",
  );
  const deleteButton = host.querySelector<HTMLButtonElement>(
    ".zai-chat-delete-button",
  );
  const viewTargetButtons = Array.from(
    host.querySelectorAll("[data-view-target]"),
  ) as HTMLButtonElement[];
  const modelDropdown = host.querySelector<HTMLElement>(
    ".zai-model-select-wrap",
  );
  const modelButton =
    host.querySelector<HTMLButtonElement>(".zai-model-select");
  const modelPickerToggle = host.querySelector<HTMLButtonElement>(
    ".zai-model-picker-toggle",
  );
  const metadataControl = host.querySelector<HTMLElement>(
    ".zai-metadata-control",
  );
  const metadataButton = host.querySelector<HTMLButtonElement>(
    ".zai-metadata-button",
  );
  const metadataPopover = host.querySelector<HTMLElement>(
    ".zai-metadata-popover",
  );
  const terminateOllamaButton = host.querySelector<HTMLButtonElement>(
    ".zai-ollama-terminate-button",
  );
  const metadataCheckboxes = Array.from(
    host.querySelectorAll<HTMLInputElement>(".zai-metadata-checkbox[value]"),
  ) as HTMLInputElement[];
  const paperLibrarySearch = host.querySelector<HTMLInputElement>(
    ".zai-paper-library-search",
  );
  const paperContextList = host.querySelector<HTMLElement>(
    ".zai-paper-context-list",
  );
  const manualPaperContextList = host.querySelector<HTMLElement>(
    ".zai-paper-manual-context-list",
  );
  const paperLibraryResults = host.querySelector<HTMLElement>(
    ".zai-paper-library-results",
  );
  const providerButtons = Array.from(
    host.querySelectorAll(".zai-provider-toggle-button[data-provider]"),
  ) as HTMLButtonElement[];
  const setupTimeline = host.querySelector<HTMLElement>(".zai-setup-timeline");
  const ownerWindow = host.ownerDocument?.defaultView ?? null;
  const openIndexManagerButton = host.querySelector<HTMLButtonElement>(
    ".zai-paper-context-index-manager-button",
  );

  syncModelPicker(host);
  syncMetadataFieldControls(host);
  syncPaperContextControls(host);
  registerPaperContextSelectionWindow(ownerWindow);
  ownerWindow?.setTimeout(() => {
    lastAutomaticPaperContextSignature = getAutomaticPaperContextSignature();
    syncPaperContextControls(host);
  }, 0);
  ensureLocalModelInstallEventHandler(ownerWindow);
  ensureModelDropdownOutsideHandler(host.ownerDocument);
  void ensureModelOptionsLoaded(getActiveProvider());
  void revalidateCurrentReadiness(false);
  if (!activeChatID) invalidateChatSummaries();
  renderHost(host);
  void refreshChatSummaries(true).catch((error) => {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  });

  const sendCurrentPrompt = () => {
    hosts.add(host);
    const prompt = textarea?.value.trim() ?? "";
    if (!prompt || requestRunning || !isChatReady()) return;

    if (textarea) textarea.value = "";
    void sendChatPrompt(prompt).catch(() => {});
  };

  sendButton?.addEventListener("click", () => {
    if (requestRunning) {
      cancelActiveAssistantResponse();
      return;
    }

    sendCurrentPrompt();
  });
  chatList?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      ".zai-chat-entry[data-chat-id]",
    );
    const chatID = button?.dataset.chatId;
    if (!chatID || requestRunning) return;

    void loadChat(chatID).catch((error) => {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      void refreshChatSummaries(true).catch((refreshError) => {
        Zotero.logError(
          refreshError instanceof Error
            ? refreshError
            : new Error(String(refreshError)),
        );
      });
    });
  });
  seeAllButton?.addEventListener("click", () => {
    void (async () => {
      await refreshChatSummaries(false);
      showAllChats = chatSummaries.length > 3 ? !showAllChats : false;
      renderAllHosts();
    })().catch((error) => {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  backButton?.addEventListener("click", () => {
    if (getSidebarView(host) === "about") {
      setSidebarView(host, "chat");
      return;
    }
    if (!requestRunning) returnToWelcome();
  });
  favoriteButton?.addEventListener("click", () => {
    const chatID = activeChatID;
    if (!chatID || requestRunning) return;

    const nextFavorite = !getActiveChatSummary()?.isFavorite;
    void setChatFavorite(chatID, nextFavorite).catch((error) => {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  deleteButton?.addEventListener("click", () => {
    const chatID = activeChatID;
    if (!chatID || requestRunning || !confirmDeleteActiveChat(host)) return;

    void deleteChat(chatID).catch((error) => {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  for (const viewTargetButton of viewTargetButtons) {
    viewTargetButton.addEventListener("click", () => {
      setSidebarView(host, getSidebarViewTarget(viewTargetButton));
    });
  }
  textarea?.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      sendCurrentPrompt();
    }
  });
  modelPickerToggle?.addEventListener("click", () => {
    hosts.add(host);
    setModelPickerExpanded(!modelPickerExpanded);
  });
  for (const providerButton of providerButtons) {
    providerButton.addEventListener("click", () => {
      hosts.add(host);
      setActiveProvider(getProviderButtonValue(providerButton));
    });
  }
  setupTimeline?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      "button[data-action]",
    );
    if (!button || !setupTimeline.contains(button)) return;

    const action = button.dataset.action;
    if (action === "open-preferences") {
      openPreferencesPane();
    } else if (action === "open-semantic-settings") {
      openSemanticSearchPreference();
    } else if (action === "check-readiness") {
      ollamaSetupStatusText = "";
      void revalidateCurrentReadiness(true);
    } else if (action === "launch-required-setup") {
      void launchOllamaSetup();
    } else if (action === "start-ollama") {
      void startOllama();
    } else if (action === "install-default-local-model") {
      if (ownerWindow) {
        void pullSetupModel("local-model", OLLAMA_DEFAULT_MODEL, ownerWindow);
      }
    } else if (action === "install-embedding-model") {
      if (ownerWindow) {
        void pullSetupModel("embedding", REQUIRED_EMBEDDING_MODEL, ownerWindow);
      }
    } else if (action === "cancel-local-model-download") {
      cancelSetupModelDownload("local-model");
    } else if (action === "cancel-embedding-download") {
      cancelSetupModelDownload("embedding");
    } else if (action === "open-local-model-window") {
      const owner = ownerWindow as unknown as
        | _ZoteroTypes.MainWindow
        | undefined;
      if (owner) openLocalOllamaModelWindow(owner);
    }
  });
  modelButton?.addEventListener("click", () => {
    if (!modelDropdown) return;

    hosts.add(host);
    void ensureModelOptionsLoaded(getActiveProvider());
    toggleModelDropdown(modelDropdown);
  });
  modelDropdown?.addEventListener("click", (event) => {
    const addButton = (
      event.target as Element | null
    )?.closest<HTMLButtonElement>(
      '.zai-model-select-add-button[data-action="add-local-model"]',
    );
    if (addButton && modelDropdown.contains(addButton)) {
      const owner = ownerWindow as unknown as
        | _ZoteroTypes.MainWindow
        | undefined;

      closeModelDropdown(modelDropdown);
      if (owner) openLocalOllamaModelWindow(owner);
      event.preventDefault();
      return;
    }

    const optionButton = (
      event.target as Element | null
    )?.closest<HTMLButtonElement>(".zai-model-select-option[data-model-value]");
    if (!optionButton || !modelDropdown.contains(optionButton)) return;

    const model = optionButton.dataset.modelValue;
    if (!model) return;

    selectModelDropdownValue(modelDropdown, model);
  });
  modelDropdown?.addEventListener("keydown", (event) => {
    handleModelDropdownKeydown(event as KeyboardEvent, modelDropdown);
  });
  metadataButton?.addEventListener("click", () => {
    if (!metadataControl) return;

    hosts.add(host);
    syncPaperContextControls(host);
    void ensurePaperLibraryOptionsLoaded();
    toggleMetadataPopover(metadataControl);
  });
  terminateOllamaButton?.addEventListener("click", () => {
    if (ollamaTerminateRunning || !confirmTerminateOllama(host)) return;
    void terminateOllamaCompletely();
  });
  metadataPopover?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape" && metadataControl) {
      closeMetadataPopover(metadataControl);
      metadataButton?.focus();
    }
  });
  metadataPopover?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  for (const checkbox of metadataCheckboxes) {
    checkbox.addEventListener("change", () => {
      hosts.add(host);
      saveMetadataFieldSelection(metadataCheckboxes, checkbox);
    });
  }
  paperLibrarySearch?.addEventListener("input", () => {
    hosts.add(host);
    paperLibrarySearchValue = paperLibrarySearch.value;
    syncAllPaperContextControls();
    void ensurePaperLibraryOptionsLoaded();
  });
  paperLibrarySearch?.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "Enter") {
      keyboardEvent.preventDefault();
      hosts.add(host);
      addBestMatchingPaperToManualContext();
    }
  });
  paperLibraryResults?.addEventListener("click", (event) => {
    const addButton = (
      event.target as Element | null
    )?.closest<HTMLButtonElement>(
      ".zai-paper-library-result-add-button[data-context-key]",
    );
    const key = addButton?.dataset.contextKey;
    if (!key) return;

    const option = paperLibraryOptions.find(
      (entry) => getPaperContextKey(entry) === key,
    );
    if (!option) return;

    hosts.add(host);
    addPaperLibraryOptionToManualContext(option);
  });
  paperContextList?.addEventListener("click", (event) => {
    const removeButton = (
      event.target as Element | null
    )?.closest<HTMLButtonElement>(
      ".zai-paper-context-remove-button[data-context-key]",
    );
    const key = removeButton?.dataset.contextKey;
    if (!key) return;

    const entry = getAutomaticPaperContextEntries().find(
      (entry) => getPaperContextKey(entry) === key,
    );
    if (!entry) return;

    hosts.add(host);
    void removeAutomaticPaperContextEntry(entry);
  });
  manualPaperContextList?.addEventListener("click", (event) => {
    const removeButton = (
      event.target as Element | null
    )?.closest<HTMLButtonElement>(
      ".zai-paper-context-remove-button[data-context-key]",
    );
    const key = removeButton?.dataset.contextKey;
    if (!key) return;

    hosts.add(host);
    manualPaperContextEntries.delete(key);
    syncAllPaperContextControls();
  });
  openIndexManagerButton?.addEventListener("click", () => {
    if (ownerWindow) openIndexManagerWindow(ownerWindow);
  });
  if (metadataControl?.ownerDocument) {
    ensureMetadataPopoverOutsideHandler(metadataControl.ownerDocument);
  }
}

/**
 * Gets g et si de ba rv ie w.
 *
 * @param host - Parameter used by getSidebarView.
 * @returns Result produced by getSidebarView.
 */
function getSidebarView(host: HTMLElement): SidebarView {
  return sidebarViews.get(host) ?? "chat";
}

/**
 * Gets g et si de ba rv ie wt ar ge t.
 *
 * @param button - Parameter used by getSidebarViewTarget.
 * @returns Result produced by getSidebarViewTarget.
 */
function getSidebarViewTarget(button: HTMLButtonElement): SidebarView {
  return button.dataset.viewTarget === "about" ? "about" : "chat";
}

/**
 * Sets s et si de ba rv ie w.
 *
 * @param host - Parameter used by setSidebarView.
 * @param view - Parameter used by setSidebarView.
 * @returns Result produced by setSidebarView.
 */
function setSidebarView(host: HTMLElement, view: SidebarView) {
  hosts.add(host);
  sidebarViews.set(host, view);
  renderHost(host);
}

/**
 * Ensures e ns ur el oc al mo de li ns ta ll ev en th an dl er.
 *
 * @param win - Parameter used by ensureLocalModelInstallEventHandler.
 * @returns Result produced by ensureLocalModelInstallEventHandler.
 */
function ensureLocalModelInstallEventHandler(win: Window | null) {
  if (!win || localModelInstallEventWindows.has(win)) return;

  localModelInstallEventWindows.add(win);
  win.addEventListener(LOCAL_OLLAMA_MODEL_INSTALLED_EVENT, (event) => {
    const detail = (event as CustomEvent<{ model?: unknown }>).detail;
    const model = typeof detail?.model === "string" ? detail.model.trim() : "";
    if (!model) return;

    void useInstalledLocalModel(model);
  });
  win.addEventListener(LOCAL_OLLAMA_MODELS_CHANGED_EVENT, () => {
    modelLoadStates.delete("ollama");
    modelOptionsByProvider.delete("ollama");
    delete addon.data.runtime.providerConnections.ollama;
    void revalidateCurrentReadiness(true);
  });
}

/**
 * Wechselt nach der Installation eines lokalen Modells automatisch zu Ollama,
 * speichert Provider und Modell und synchronisiert anschließend Verbindung,
 * Modelloptionen und alle sichtbaren Provider-Toggles.
 *
 * @param model - Neu installiertes und auszuwählendes Ollama-Modell.
 */
async function useInstalledLocalModel(model: string) {
  addon.data.settings.provider = "ollama";
  savePluginPreference("provider", "ollama");
  setProviderModel("ollama", model);

  await ensureModelOptionsLoaded("ollama", true);
  await checkProviderConnection("ollama", true);
  syncAllModelPickers();
}

/**
 * Initializes chat persistence and resets the active chat view.
 *
 * @returns Promise that resolves after chat summaries are loaded.
 */
export async function initializeChatPersistence() {
  await refreshChatSummaries(false);
  activeChatID = null;
  showAllChats = false;
  resetMessages();
  renderAllHosts();
}

/**
 * Registers a window whose Zotero selection can affect paper context controls.
 *
 * @param win - Window to register, or null when unavailable.
 * @returns Nothing.
 */
export function registerPaperContextSelectionWindow(win: Window | null) {
  ensurePaperContextSelectionPolling(win);
  ensurePaperContextSelectionEventHandlers(win);
  win?.setTimeout(refreshPaperContextControls, 0);
}

/**
 * Refreshes paper context controls across all assistant hosts.
 *
 * @returns Nothing.
 */
export function refreshPaperContextControls() {
  lastAutomaticPaperContextSignature = getAutomaticPaperContextSignature();
  syncAllPaperContextControls();
}

/**
 * Sends a user prompt through the active assistant chat flow.
 *
 * @param prompt - User prompt to submit.
 * @returns Promise resolving to the user message or assistant response.
 */
export async function sendChatPrompt(prompt: string) {
  const content = prompt.trim();
  if (!content) {
    throw new Error("Der Prompt darf nicht leer sein.");
  }
  await revalidateCurrentReadiness(true);
  if (!isChatReady()) {
    throw new Error(getChatReadinessErrorText());
  }

  const chat = await ensureActiveChat(content);
  const chatID = chat.chatID;
  const shouldGenerateTitle = chat.shouldGenerateTitle && !simulationEnabled;
  if (shouldGenerateTitle) {
    pendingGeneratedTitleChatIDs.add(chatID);
  }
  const userMessage = appendMessage("user", content);
  try {
    await persistChatMessage(chatID, userMessage);
  } catch (error) {
    if (shouldGenerateTitle) {
      pendingGeneratedTitleChatIDs.delete(chatID);
      renderAllHosts();
    }
    throw error;
  }

  if (simulationEnabled) {
    recordPromptContextRouteSkipped(content, "simulation");
    pendingSimulationPrompts.push({
      id: userMessage.id,
      content: userMessage.content,
    });
    logSimulationPrompt(userMessage);
    renderAllHosts();
    return userMessage;
  }

  const requestID = ++activeChatRequestID;
  activeChatCancelRequested = false;
  requestRunning = true;
  renderAllHosts();

  if (shouldGenerateTitle) {
    void tryGenerateChatTitle(chatID, content);
  }

  activeAssistantResponse = {
    prompt: content,
    activity: deriveActivityMessage(content, "waiting"),
    phase: "waiting",
    assistantMessage: null,
    pendingContent: "",
  };
  renderAllHosts();

  try {
    const requestMessages = await createRequestMessages(content);
    Zotero.debug(
      `[assistantChatController] Sende Anfrage an LLM. Anzahl Nachrichten: ${requestMessages.length}.`,
    );
    const systemMsg = requestMessages.find((m) => m.role === "system");
    if (systemMsg) {
      Zotero.debug(
        `[assistantChatController] System-Context Vorschau:\n${systemMsg.content.substring(0, 500)}...`,
      );
    }

    const assistantMessage = await requestAssistantResponse(
      requestMessages,
      requestID,
    );

    if (!assistantMessage) {
      return userMessage;
    }

    if (!assistantMessage.content.trim()) {
      throw new Error("ZAIA hat keine Textantwort zurückgegeben.");
    }

    await persistChatMessage(chatID, assistantMessage);
    await refreshChatSummaries(false);
    return assistantMessage;
  } catch (error) {
    if (isActiveChatRequestCancelled(requestID)) {
      return userMessage;
    }

    finalizeActiveAssistantMessage();
    const message = error instanceof Error ? error.message : String(error);
    requestRunning = false;
    activeAssistantResponse = null;
    appendMessage("error", `Anfrage fehlgeschlagen: ${message}`);
    throw error;
  } finally {
    if (requestID === activeChatRequestID) {
      requestRunning = false;
      activeChatCancelRequested = false;
      activeAssistantResponse = null;
      renderAllHosts();
    }
  }
}

/**
 * Returns a snapshot of the currently rendered chat messages.
 *
 * @returns Assistant chat messages in display order.
 */
export function getChatMessages() {
  return messages.map((message) => ({ ...message }));
}

/**
 * Gets the active persisted chat identifier.
 *
 * @returns Active chat ID, or null when no chat is active.
 */
export function getActiveChatID() {
  return activeChatID;
}

/**
 * Lists persisted chat summaries.
 *
 * @returns Promise resolving to chat summaries.
 */
export async function listChats() {
  await refreshChatSummaries(false);
  return chatSummaries.map((chat) => ({ ...chat }));
}

/**
 * Creates a new persisted chat and makes it active.
 *
 * @param input - Optional metadata for the created chat.
 * @returns Promise resolving to the created chat.
 */
export async function createChat(input: CreateChatInput = {}) {
  if (requestRunning) {
    throw new Error(
      "Während ZAIA antwortet kann kein neuer Chat erstellt werden.",
    );
  }

  const chat = await ChatRepository.createChat({
    ...getSelectedItemChatInput(),
    ...input,
  });
  activeChatID = chat.id;
  showAllChats = false;
  resetMessages();
  await refreshChatSummaries(false);
  renderAllHosts();

  return chat;
}

/**
 * Loads a persisted chat into the assistant UI.
 *
 * @param chatID - Chat identifier to load.
 * @returns Promise resolving to the loaded chat with messages.
 */
export async function loadChat(chatID: string) {
  if (requestRunning) {
    throw new Error(
      "Während ZAIA antwortet kann kein anderer Chat geladen werden.",
    );
  }

  const chat = await ChatRepository.getChatWithMessages(chatID);
  if (!chat) {
    throw new Error(`Chat nicht gefunden: ${chatID}`);
  }

  activeChatID = chat.id;
  showAllChats = false;
  resetMessages();
  for (const message of chat.messages) {
    messages.push({
      id: nextMessageID++,
      role: message.role,
      content: message.content,
      tokenUsage: message.tokenUsage,
    });
  }
  pendingSimulationPrompts.length = 0;
  activeAssistantResponse = null;
  renderAllHosts();

  return chat;
}

/**
 * Deletes a persisted chat and clears it from the active view when needed.
 *
 * @param chatID - Chat identifier to delete.
 * @returns Promise that resolves after deletion.
 */
export async function deleteChat(chatID: string) {
  if (requestRunning) {
    throw new Error("Während ZAIA antwortet kann kein Chat gelöscht werden.");
  }

  await ChatRepository.deleteChat(chatID);
  pendingGeneratedTitleChatIDs.delete(chatID);
  showAllChats = false;
  await refreshChatSummaries(false);

  if (activeChatID === chatID) {
    activeChatID = null;
    showAllChats = false;
    resetMessages();
  }

  renderAllHosts();
}

/**
 * Updates the favorite state of a persisted chat.
 *
 * @param chatID - Chat identifier to update.
 * @param isFavorite - Whether the chat should be marked as favorite.
 * @returns Promise that resolves after the favorite state is saved.
 */
export async function setChatFavorite(chatID: string, isFavorite: boolean) {
  if (requestRunning) {
    throw new Error(
      "Während ZAIA antwortet kann kein Chat favorisiert werden.",
    );
  }

  await ChatRepository.updateChatFavorite(chatID, isFavorite);
  await refreshChatSummaries(false);
  renderAllHosts();
}

/**
 * Clears the active chat and returns to the welcome view.
 *
 * @returns Nothing.
 */
export function clearChat() {
  returnToWelcome();
}

/**
 * Creates a new chat and focuses the assistant composer.
 *
 * @returns Promise resolving to the created chat.
 */
export async function createChatAndFocusComposer() {
  const chat = await createChat();
  focusAssistantComposer();
  return chat;
}

/**
 * Toggles the favorite state of the active chat.
 *
 * @returns Promise resolving to the new favorite state.
 */
export async function toggleActiveChatFavorite() {
  const chatID = activeChatID;
  if (!chatID) {
    throw new Error("Es ist kein ZAIA-Chat aktiv.");
  }

  const nextFavorite = !getActiveChatSummary()?.isFavorite;
  await setChatFavorite(chatID, nextFavorite);
  return nextFavorite;
}

/**
 * Focuses the assistant composer in the preferred host.
 *
 * @param owner - Optional owner window used to choose a host.
 * @returns True when the composer was focused.
 */
export function focusAssistantComposer(owner?: Window | null) {
  const host = getPreferredAssistantHost(owner);
  const textarea = host?.querySelector<HTMLTextAreaElement>(".zai-input");
  textarea?.focus();
  return Boolean(textarea);
}

/**
 * Focuses the model selection control in the preferred host.
 *
 * @param owner - Optional owner window used to choose a host.
 * @returns True when the model selection control was focused.
 */
export function focusModelSelection(owner?: Window | null) {
  const host = getPreferredAssistantHost(owner);
  if (!host) return false;

  setModelPickerExpanded(true);
  void ensureModelOptionsLoaded(getActiveProvider());

  const dropdown = host.querySelector<HTMLElement>(".zai-model-select-wrap");
  if (dropdown) {
    openModelDropdown(dropdown);
    dropdown.querySelector<HTMLButtonElement>(".zai-model-select")?.focus();
    return true;
  }

  return false;
}

/**
 * Opens the context popover in the preferred host.
 *
 * @param owner - Optional owner window used to choose a host.
 * @returns True when the context popover was opened.
 */
export function openContextWindow(owner?: Window | null) {
  const host = getPreferredAssistantHost(owner);
  if (!host || !isAssistantHostReadyForPopover(host)) return false;

  const metadataControl = host.querySelector<HTMLElement>(
    ".zai-metadata-control",
  );
  if (!metadataControl || !isElementReadyForPopover(metadataControl)) {
    return false;
  }

  syncPaperContextControls(host);
  void ensurePaperLibraryOptionsLoaded();
  openMetadataPopover(metadataControl);
  return true;
}

/**
 * Returns to r et ur nt ow el co me.
 * @returns Result produced by returnToWelcome.
 */
function returnToWelcome() {
  activeChatID = null;
  showAllChats = false;
  invalidateChatSummaries();
  resetMessages();
  pendingSimulationPrompts.length = 0;
  activeAssistantResponse = null;
  renderAllHosts();
  void refreshChatSummaries(true).catch((error) => {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  });
}

/**
 * Cancels c an ce la ct iv ea ss is ta nt re sp on se.
 * @returns Result produced by cancelActiveAssistantResponse.
 */
function cancelActiveAssistantResponse() {
  if (!requestRunning || activeChatCancelRequested) return;

  activeChatCancelRequested = true;
  finalizeActiveAssistantMessage();
  renderAllHosts();
}

/**
 * Checks whether i sa ct iv ec ha tr eq ue st ca nc el le d.
 *
 * @param requestID - Parameter used by isActiveChatRequestCancelled.
 * @returns Result produced by isActiveChatRequestCancelled.
 */
function isActiveChatRequestCancelled(requestID: number) {
  return requestID === activeChatRequestID && activeChatCancelRequested;
}

/**
 * Refreshes r ef re sh ch at su mm ar ie s.
 *
 * @param render - Parameter used by refreshChatSummaries.
 * @returns Result produced by refreshChatSummaries.
 */
async function refreshChatSummaries(render = true) {
  try {
    const chats = await ChatRepository.listChats();
    chatSummaries.splice(0, chatSummaries.length, ...chats);
    chatSummariesLoaded = true;
  } catch (error) {
    invalidateChatSummaries();
    chatSummariesLoaded = true;
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }

  if (render) renderAllHosts();
}

/**
 * Handles i nv al id at ec ha ts um ma ri es.
 * @returns Result produced by invalidateChatSummaries.
 */
function invalidateChatSummaries() {
  chatSummariesLoaded = false;
  chatSummaries.length = 0;
}

/**
 * Requests r eq ue st as si st an tr es po ns e.
 *
 * @param requestMessages - Parameter used by requestAssistantResponse.
 * @param requestID - Parameter used by requestAssistantResponse.
 * @returns Result produced by requestAssistantResponse.
 */
async function requestAssistantResponse(
  requestMessages: RequestMessage[],
  requestID: number,
) {
  if (typeof addon.api.ai.chatStream === "function") {
    try {
      return await requestStreamingAssistantResponse(
        requestMessages,
        requestID,
      );
    } catch (error) {
      if (
        !activeAssistantResponse?.assistantMessage &&
        shouldFallbackToBufferedChat(error)
      ) {
        return requestBufferedAssistantResponse(requestMessages, requestID);
      }
      throw error;
    }
  }

  return requestBufferedAssistantResponse(requestMessages, requestID);
}

/**
 * Requests r eq ue st st re am in ga ss is ta nt re sp on se.
 *
 * @param requestMessages - Parameter used by requestStreamingAssistantResponse.
 * @param requestID - Parameter used by requestStreamingAssistantResponse.
 * @returns Result produced by requestStreamingAssistantResponse.
 */
async function requestStreamingAssistantResponse(
  requestMessages: RequestMessage[],
  requestID: number,
) {
  let assistantMessage: AssistantChatMessage | null = null;
  recordAssistantRequestDebug(requestMessages, "stream");

  for await (const event of addon.api.ai.chatStream(requestMessages, {
    providerId: getActiveProvider(),
    model: getActiveModel(),
  }) as AsyncIterable<AIStreamEvent>) {
    if (isActiveChatRequestCancelled(requestID)) break;
    if (!event || typeof event !== "object") continue;

    if (event.type === "reasoning") {
      updateActiveActivity("reasoning");
      continue;
    }

    if (
      event.type === "content" &&
      typeof event.content === "string" &&
      event.content
    ) {
      const updatedMessage = appendAssistantDelta(event.content);
      if (updatedMessage) assistantMessage = updatedMessage;
      continue;
    }

    if (event.type === "done") {
      if (event.usage && assistantMessage) {
        assistantMessage.tokenUsage =
          event.usage as AssistantChatMessage["tokenUsage"];
      }
      break;
    }
  }

  const finalMessage = finalizeActiveAssistantMessage() ?? assistantMessage;
  if (isActiveChatRequestCancelled(requestID)) return finalMessage;

  return finalMessage ?? failNoAnswer();
}

/**
 * Requests r eq ue st bu ff er ed as si st an tr es po ns e.
 *
 * @param requestMessages - Parameter used by requestBufferedAssistantResponse.
 * @param requestID - Parameter used by requestBufferedAssistantResponse.
 * @returns Result produced by requestBufferedAssistantResponse.
 */
async function requestBufferedAssistantResponse(
  requestMessages: RequestMessage[],
  requestID: number,
) {
  recordAssistantRequestDebug(requestMessages, "buffered");
  const result = (await addon.api.ai.chat(requestMessages, {
    providerId: getActiveProvider(),
    model: getActiveModel(),
  })) as AIChatResult;

  if (isActiveChatRequestCancelled(requestID)) return null;

  if (typeof result?.content !== "string" || !result.content.trim()) {
    throw new Error("ZAIA hat keine Textantwort zurückgegeben.");
  }

  const assistantMessage = appendAssistantDelta(result.content.trim());
  if (assistantMessage && "usage" in result && result.usage) {
    assistantMessage.tokenUsage =
      result.usage as AssistantChatMessage["tokenUsage"];
  }
  return finalizeActiveAssistantMessage() ?? assistantMessage ?? failNoAnswer();
}

/**
 * Liest den aktuell gespeicherten Chat-Provider und normalisiert unbekannte
 * Werte auf den Cloud-Provider.
 *
 * @returns Aktive technische Provider-ID.
 */
function getActiveProvider(): LLMProvider {
  return addon.data.settings.provider === "ollama" ? "ollama" : "kisski";
}

/**
 * Checks whether i sa ct iv ep ro vi de rr ea dy.
 * @returns Result produced by isActiveProviderReady.
 */
function isActiveProviderReady() {
  return isProviderConnectionReady(
    addon.data.runtime.providerConnections[getActiveProvider()],
  );
}

/**
 * Checks whether i se mb ed di ng re ad y.
 * @returns Result produced by isEmbeddingReady.
 */
function isEmbeddingReady() {
  return (
    !addon.data.settings.embeddingSearchEnabled ||
    isEmbeddingConnectionReady(addon.data.runtime.embeddingConnection)
  );
}

/**
 * Checks whether i sc ha tr ea dy.
 * @returns Result produced by isChatReady.
 */
function isChatReady() {
  return getCurrentSetupReadiness().ready;
}

/**
 * Ermittelt den aktuellen Einrichtungsstand aus Provider-, Ollama- und
 * Embedding-Status für die Setup-Anzeige der Sidebar.
 *
 * @returns Zusammengefasster Setup-Status mit den erforderlichen Meilensteinen.
 */
function getCurrentSetupReadiness(): SetupReadiness {
  const provider = getActiveProvider();
  return deriveSetupReadiness(
    addon.data.settings,
    addon.data.runtime.providerConnections[provider],
    addon.data.runtime.embeddingConnection,
  );
}

/**
 * Gets g et ch at re ad in es se rr or te xt.
 * @returns Result produced by getChatReadinessErrorText.
 */
function getChatReadinessErrorText() {
  if (addon.data.settings.embeddingSearchEnabled && !isEmbeddingReady()) {
    return getString("sidebar-active-embedding-not-connected-error");
  }
  return getString("sidebar-active-provider-not-connected-error");
}

/**
 * Liest das persistent geladene Chatmodell des angegebenen Providers. Ein
 * versehentlich als Chatmodell gespeichertes Embedding-Modell wird bei Ollama
 * durch das vorgesehene lokale Standardmodell ersetzt.
 *
 * @param provider - Provider, dessen ausgewähltes Modell benötigt wird.
 * @returns Aktuell verwendete Modell-ID.
 */
function getActiveModel(provider: LLMProvider = getActiveProvider()) {
  if (provider !== "ollama") return addon.data.settings.model;

  const model = addon.data.settings.ollamaModel;
  return isLocalEmbeddingModel(model) ? OLLAMA_DEFAULT_MODEL : model;
}

/**
 * Gets g et se le ct ed me ta da ta fi el ds.
 * @returns Result produced by getSelectedMetadataFields.
 */
function getSelectedMetadataFields() {
  return getMetadataFieldsForSelection(
    addon.data.settings.metadataFieldSelection,
  );
}

/**
 * Creates c re at er eq ue st me ss ag es.
 *
 * @param prompt - Parameter used by createRequestMessages.
 * @returns Result produced by createRequestMessages.
 */
async function createRequestMessages(prompt: string) {
  const requestMessages: RequestMessage[] = [];
  const paperContext = await createPaperContextMessage(prompt);

  if (paperContext) {
    requestMessages.push({
      role: "system",
      content: paperContext,
    });
  }

  for (const message of messages) {
    if (
      (message.role === "user" || message.role === "assistant") &&
      message.content.trim()
    ) {
      requestMessages.push({
        role: message.role,
        content: message.content,
      });
    }
  }

  return requestMessages;
}

/**
 * Creates c re at ep ap er co nt ex tm es sa ge.
 *
 * @param prompt - Parameter used by createPaperContextMessage.
 * @returns Result produced by createPaperContextMessage.
 */
async function createPaperContextMessage(prompt: string) {
  const provider = addon.data.settings.provider;
  const shouldIncludePaper =
    provider === "ollama" ||
    (provider === "kisski" && addon.data.settings.sendPaperContextToKisski);

  if (!shouldIncludePaper) {
    recordPromptContextRouteSkipped(
      prompt,
      "paper-context-disabled-for-provider",
    );
    return null;
  }

  const reference = await getActivePaperReference();
  const forcedReferences = getForcedPaperContextReferences();
  if (forcedReferences.length) {
    const attachedContext = await buildAttachedPaperContext(
      prompt,
      forcedReferences,
    );
    if (attachedContext) return attachedContext;
  }

  const candidates = await getPromptRouterCandidates();

  try {
    const routerProvider = getEffectiveContextRouterProvider();
    const decision = await decidePromptContextRoute({
      provider: routerProvider,
      model: getRouterModel(routerProvider),
      prompt,
      candidates: candidates.map(toPromptRouterCandidate),
      metadataFields: getSelectedMetadataFields(),
      chat: (messages, options) => {
        configureProviderForRouting(options.providerId);
        return addon.api.ai.chat(messages, options) as Promise<{
          content?: unknown;
        }>;
      },
    });

    Zotero.debug(
      `[PromptContextRouter] Route=${decision.route}, Grund=${decision.reason || "keine Angabe"}`,
    );

    const routedContext = await buildContextFromRouteDecision(
      decision,
      prompt,
      candidates,
      reference,
    );
    recordPromptContextRouteDebug({
      prompt,
      provider: routerProvider,
      model: getRouterModel(routerProvider),
      decision,
      candidates,
      contextMode: getContextMode(decision, routedContext),
    });

    if (routedContext !== undefined) return routedContext;
  } catch (error) {
    Zotero.debug(
      `[PromptContextRouter] Entscheidung fehlgeschlagen, nutze bisherigen Kontextpfad: ${error}`,
    );
    recordPromptContextRouteFallback(prompt, error);
  }

  return createLegacyPaperContextMessage(prompt, reference);
}

/**
 * Creates c re at el eg ac yp ap er co nt ex tm es sa ge.
 *
 * @param prompt - Parameter used by createLegacyPaperContextMessage.
 * @param reference - Parameter used by createLegacyPaperContextMessage.
 * @returns Result produced by createLegacyPaperContextMessage.
 */
async function createLegacyPaperContextMessage(
  prompt: string,
  reference: PaperReference | null,
) {
  if (!reference) {
    const globalContext = await PaperContextService.buildGlobalContext(prompt);
    return globalContext;
  }

  const context = await PaperContextService.buildContext(reference, prompt);
  if (!context) {
    throw new Error(
      "ZAIA konnte keinen relevanten Kontext für diese Anfrage in dem gewählten Paper finden. Dies passiert, wenn das PDF keinen auslesbaren Text hat (OCR fehlt) oder wenn das Paper nicht in der Vektor-Datenbank gefunden wurde.",
    );
  }

  return context.systemMessage;
}

/**
 * Builds b ui ld co nt ex tf ro mr ou te de ci si on.
 *
 * @param decision - Parameter used by buildContextFromRouteDecision.
 * @param prompt - Parameter used by buildContextFromRouteDecision.
 * @param candidates - Parameter used by buildContextFromRouteDecision.
 * @param reference - Parameter used by buildContextFromRouteDecision.
 * @returns Result produced by buildContextFromRouteDecision.
 */
async function buildContextFromRouteDecision(
  decision: PromptContextRouteDecision,
  prompt: string,
  candidates: RagItemCandidate[],
  reference: PaperReference | null,
): Promise<string | null | undefined> {
  switch (decision.route) {
    case "none":
      return null;

    case "metadata":
      return buildMetadataContext(candidates, getSelectedMetadataFields());

    case "single_paper":
      return buildSinglePaperContext(decision, prompt, reference);

    case "filtered_papers": {
      const itemIDs = filterCandidateItemIDs(decision, candidates);
      const contextItemIDs = itemIDs.length
        ? itemIDs
        : decision.contentFocus === "abstracts"
          ? candidates.map((candidate) => candidate.itemID)
          : [];
      if (!contextItemIDs.length) return buildMetadataContext(candidates);
      return PaperContextService.buildVectorContextForItems(
        prompt,
        contextItemIDs,
        "Relevante AuszÃ¼ge aus den gefilterten Papern:",
      );
    }

    case "all_papers":
      return PaperContextService.buildVectorContextForItems(
        prompt,
        candidates.map((candidate) => candidate.itemID),
        "Relevante AuszÃ¼ge aus allen Papern:",
      );

    default:
      return undefined;
  }
}

/**
 * Builds b ui ld at ta ch ed pa pe rc on te xt.
 *
 * @param prompt - Parameter used by buildAttachedPaperContext.
 * @param references - Parameter used by buildAttachedPaperContext.
 * @returns Result produced by buildAttachedPaperContext.
 */
async function buildAttachedPaperContext(
  prompt: string,
  references: PaperReference[],
) {
  const itemIDs = references
    .map((reference) => reference.itemID)
    .filter((itemID): itemID is number => typeof itemID === "number");

  if (itemIDs.length) {
    return PaperContextService.buildVectorContextForItems(
      prompt,
      itemIDs,
      "Relevante Auszüge aus den angehängten Papern:",
    );
  }

  if (references.length === 1) {
    const context = await PaperContextService.buildContext(
      references[0],
      prompt,
    );
    return context?.systemMessage ?? null;
  }

  return null;
}

/**
 * Builds b ui ld si ng le pa pe rc on te xt.
 *
 * @param decision - Parameter used by buildSinglePaperContext.
 * @param prompt - Parameter used by buildSinglePaperContext.
 * @param reference - Parameter used by buildSinglePaperContext.
 * @returns Result produced by buildSinglePaperContext.
 */
async function buildSinglePaperContext(
  decision: PromptContextRouteDecision,
  prompt: string,
  reference: PaperReference | null,
) {
  const decisionItemID = decision.itemID ?? decision.itemIDs?.[0];
  const itemID = shouldUseSelectedPaperForPrompt(prompt)
    ? (reference?.itemID ?? decisionItemID)
    : (decisionItemID ?? reference?.itemID);
  if (typeof itemID === "number" && Number.isFinite(itemID)) {
    const context = await PaperContextService.buildVectorContextForItems(
      prompt,
      [itemID],
      "Relevante AuszÃ¼ge aus dem ausgewÃ¤hlten Paper:",
    );
    if (context) return context;
  }

  if (!reference) return null;
  const context = await PaperContextService.buildContext(reference, prompt);
  return context?.systemMessage ?? null;
}

/**
 * Determines whether s ho ul du se se le ct ed pa pe rf or pr om pt.
 *
 * @param prompt - Parameter used by shouldUseSelectedPaperForPrompt.
 * @returns Result produced by shouldUseSelectedPaperForPrompt.
 */
function shouldUseSelectedPaperForPrompt(prompt: string) {
  const normalizedPrompt = prompt
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return (
    /\b(dieses|diese|diesem|diesen)\s+(paper|artikel|dokument|quelle|publikation)\b/.test(
      normalizedPrompt,
    ) ||
    /\b(ausgewaehlte[ns]?|ausgewahlte[ns]?|markierte[ns]?|aktuelle[ns]?)\s+(paper|artikel|dokument|quelle|publikation)\b/.test(
      normalizedPrompt,
    ) ||
    /\b(in|aus|zu)\s+(diesem|dieser|dieses)\s+(paper|artikel|dokument|quelle|publikation)\b/.test(
      normalizedPrompt,
    )
  );
}

/**
 * Gets g et pr om pt ro ut er ca nd id at es.
 * @returns Result produced by getPromptRouterCandidates.
 */
async function getPromptRouterCandidates() {
  const maxItems = clampCandidateLimit(addon.data.settings.maxItems);
  const candidates: RagItemCandidate[] = [];

  for (const scope of LibraryScopeManager.listLibraryScopes()) {
    if (candidates.length >= maxItems) break;

    const remaining = maxItems - candidates.length;
    const scopedCandidates = await LibraryScopeManager.listRagItemCandidates({
      libraryID: scope.libraryID,
      includeWithoutPdf: true,
      limit: remaining,
    });
    candidates.push(...scopedCandidates);
  }

  return candidates.sort(sortRagCandidatesByRecency);
}

/**
 * Sorts s or tr ag ca nd id at es by re ce nc y.
 *
 * @param first - Parameter used by sortRagCandidatesByRecency.
 * @param second - Parameter used by sortRagCandidatesByRecency.
 * @returns Result produced by sortRagCandidatesByRecency.
 */
function sortRagCandidatesByRecency(
  first: RagItemCandidate,
  second: RagItemCandidate,
) {
  return getCandidateTimestamp(second) - getCandidateTimestamp(first);
}

/**
 * Handles c la mp ca nd id at el im it.
 *
 * @param value - Parameter used by clampCandidateLimit.
 * @returns Result produced by clampCandidateLimit.
 */
function clampCandidateLimit(value: number) {
  if (!Number.isFinite(value)) return 200;
  return Math.min(1000, Math.max(1, Math.floor(value)));
}

/**
 * Gets g et ca nd id at et im es ta mp.
 *
 * @param candidate - Parameter used by getCandidateTimestamp.
 * @returns Result produced by getCandidateTimestamp.
 */
function getCandidateTimestamp(candidate: RagItemCandidate) {
  const parsed = Date.parse(
    candidate.dateModified || candidate.dateAdded || "",
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Handles t op ro mp tr ou te rc an di da te.
 *
 * @param candidate - Parameter used by toPromptRouterCandidate.
 * @returns Result produced by toPromptRouterCandidate.
 */
function toPromptRouterCandidate(
  candidate: RagItemCandidate,
): PromptContextRouterCandidate {
  return {
    itemID: candidate.itemID,
    title: candidate.title,
    firstCreator: candidate.creators,
    year: candidate.year,
    publicationDate: candidate.publicationDate,
    publicationTitle: candidate.publicationTitle,
    publisher: candidate.publisher,
    doi: candidate.doi,
    isbn: candidate.isbn,
    url: candidate.url,
    abstractNote: candidate.abstractNote,
    dateAdded: candidate.dateAdded,
    dateModified: candidate.dateModified,
    itemType: candidate.itemType,
    tags: candidate.tags,
    libraryName: candidate.library.name,
  };
}

/**
 * Builds b ui ld me ta da ta co nt ex t.
 *
 * @param candidates - Parameter used by buildMetadataContext.
 * @param fields - Parameter used by buildMetadataContext.
 * @returns Result produced by buildMetadataContext.
 */
function buildMetadataContext(
  candidates: RagItemCandidate[],
  fields: MetadataFieldSelection[] = getSelectedMetadataFields(),
) {
  if (!candidates.length) {
    return "Die Bibliothek des Nutzers enthÃ¤lt keine auswertbaren Paper-Metadaten.";
  }

  const lines = candidates.map((candidate) =>
    formatCandidateMetadata(candidate, fields),
  );

  return [
    "Du bist ein wissenschaftlicher KI-Assistent fÃ¼r Zotero.",
    "Nutze ausschlieÃŸlich die folgenden Paper-Metadaten, um die Nutzerfrage zu beantworten oder passende Paper vorzuschlagen.",
    "Falls in den Metadaten keine passende Information steht, sage das deutlich.",
    "Nenne in der Antwort keine Zotero-IDs, ausser der Nutzer fragt explizit danach. Verwende die vorhandenen bibliographischen Angaben.",
    "Antworte strukturiert und ueberschaubar.",
    "",
    "Paper-Metadaten:",
    "<paper-metadata>",
    lines.join("\n"),
    "</paper-metadata>",
  ].join("\n");
}

/**
 * Formats f or ma tc an di da te me ta da ta.
 *
 * @param candidate - Parameter used by formatCandidateMetadata.
 * @param fields - Parameter used by formatCandidateMetadata.
 * @returns Result produced by formatCandidateMetadata.
 */
function formatCandidateMetadata(
  candidate: RagItemCandidate,
  fields: MetadataFieldSelection[],
) {
  const lines = [
    `[PAPER Zotero-ID=${candidate.itemID}]`,
    `Titel: ${normalizeMetadataValue(candidate.title, "Ohne Titel")}`,
  ];

  if (fields.includes("creators")) {
    lines.push(
      `Autorenschaft: ${normalizeMetadataValue(candidate.creators, "Unbekannte Autorenschaft")}`,
    );
  }
  if (fields.includes("publicationDate")) {
    lines.push(
      `Veröffentlichungsdatum: ${normalizeMetadataValue(candidate.publicationDate, "Unbekannt")}`,
    );
  }
  if (fields.includes("tags")) {
    lines.push(
      `Tags: ${candidate.tags.length ? candidate.tags.map((tag) => normalizeMetadataValue(tag)).join(", ") : "Keine Tags"}`,
    );
  }

  return [...lines, "[/PAPER]"].join("\n");
}

/**
 * Normalizes n or ma li ze me ta da ta va lu e.
 *
 * @param value - Parameter used by normalizeMetadataValue.
 * @param fallback - Parameter used by normalizeMetadataValue.
 * @returns Result produced by normalizeMetadataValue.
 */
function normalizeMetadataValue(value: unknown, fallback = "") {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

/**
 * Filters f il te rc an di da te it em id s.
 *
 * @param decision - Parameter used by filterCandidateItemIDs.
 * @param candidates - Parameter used by filterCandidateItemIDs.
 * @returns Result produced by filterCandidateItemIDs.
 */
function filterCandidateItemIDs(
  decision: PromptContextRouteDecision,
  candidates: RagItemCandidate[],
) {
  const explicitIDs = decision.itemIDs?.filter(Number.isFinite) ?? [];
  if (explicitIDs.length) return explicitIDs;

  const tag = normalizeFilterText(decision.tag);
  const property = decision.property;
  const value = normalizeFilterText(decision.value);

  return candidates
    .filter((candidate) => {
      if (tag) {
        return candidate.tags.some((candidateTag) =>
          normalizeFilterText(candidateTag).includes(tag),
        );
      }

      if (!property || !value) return false;
      if (property === "tag") {
        return candidate.tags.some((candidateTag) =>
          normalizeFilterText(candidateTag).includes(value),
        );
      }

      const candidateValue =
        property === "firstCreator"
          ? candidate.creators
          : String(candidate[property] ?? "");
      return normalizeFilterText(candidateValue).includes(value);
    })
    .map((candidate) => candidate.itemID);
}

/**
 * Normalizes n or ma li ze fi lt er te xt.
 *
 * @param value - Parameter used by normalizeFilterText.
 * @returns Result produced by normalizeFilterText.
 */
function normalizeFilterText(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Records r ec or dp ro mp tc on te xt ro ut ed eb ug.
 *
 * @param provider - Parameter used by recordPromptContextRouteDebug.
 * @param model - Parameter used by recordPromptContextRouteDebug.
 * @param decision - Parameter used by recordPromptContextRouteDebug.
 * @param candidates - Parameter used by recordPromptContextRouteDebug.
 * @param contextMode - Parameter used by recordPromptContextRouteDebug.
 * @returns Result produced by recordPromptContextRouteDebug.
 */
function recordPromptContextRouteDebug({
  prompt,
  provider,
  model,
  decision,
  candidates,
  contextMode,
}: {
  prompt: string;
  provider: LLMProvider;
  model: string;
  decision: PromptContextRouteDecision;
  candidates: RagItemCandidate[];
  contextMode: string;
}) {
  lastPromptContextRouteDebug = {
    prompt,
    provider,
    model,
    status: "routed",
    decision,
    candidateCount: candidates.length,
    selectedItemIDs: getDecisionItemIDs(decision, candidates),
    contextMode,
    routerUsesChatHistory: false,
    routerMessageCount: 2,
    createdAt: new Date().toISOString(),
  };

  Zotero.debug(
    `[PromptContextRouter] Debug: ${JSON.stringify(lastPromptContextRouteDebug)}`,
  );
}

/**
 * Records r ec or dp ro mp tc on te xt ro ut es ki pp ed.
 *
 * @param prompt - Parameter used by recordPromptContextRouteSkipped.
 * @param reason - Parameter used by recordPromptContextRouteSkipped.
 * @returns Result produced by recordPromptContextRouteSkipped.
 */
function recordPromptContextRouteSkipped(prompt: string, reason: string) {
  lastPromptContextRouteDebug = {
    prompt,
    provider: getEffectiveContextRouterProvider(),
    model: getRouterModel(getEffectiveContextRouterProvider()),
    status: "skipped",
    decision: {
      route: "none",
      reason,
      confidence: 1,
      requestedFields: [],
    },
    candidateCount: 0,
    selectedItemIDs: [],
    contextMode: "skipped",
    routerUsesChatHistory: false,
    routerMessageCount: 0,
    createdAt: new Date().toISOString(),
  };

  Zotero.debug(
    `[PromptContextRouter] Debug: ${JSON.stringify(lastPromptContextRouteDebug)}`,
  );
}

/**
 * Records r ec or dp ro mp tc on te xt ro ut ef al lb ac k.
 *
 * @param prompt - Parameter used by recordPromptContextRouteFallback.
 * @param error - Parameter used by recordPromptContextRouteFallback.
 * @returns Result produced by recordPromptContextRouteFallback.
 */
function recordPromptContextRouteFallback(prompt: string, error: unknown) {
  lastPromptContextRouteDebug = {
    prompt,
    provider: getEffectiveContextRouterProvider(),
    model: getRouterModel(getEffectiveContextRouterProvider()),
    status: "fallback",
    decision: {
      route: "metadata",
      reason: "Routerentscheidung fehlgeschlagen; Legacy-Kontextpfad genutzt.",
      confidence: 0,
      requestedFields: [],
    },
    candidateCount: 0,
    selectedItemIDs: [],
    contextMode: "fallback",
    routerUsesChatHistory: false,
    routerMessageCount: 0,
    createdAt: new Date().toISOString(),
    error: String(error),
  };

  Zotero.debug(
    `[PromptContextRouter] Debug: ${JSON.stringify(lastPromptContextRouteDebug)}`,
  );
}

/**
 * Gets g et co nt ex tm od e.
 *
 * @param decision - Parameter used by getContextMode.
 * @param context - Parameter used by getContextMode.
 * @returns Result produced by getContextMode.
 */
function getContextMode(
  decision: PromptContextRouteDecision,
  context: string | null | undefined,
) {
  if (context === undefined) return "fallback";
  if (context === null) return "no-context";
  return decision.route;
}

/**
 * Gets g et de ci si on it em id s.
 *
 * @param decision - Parameter used by getDecisionItemIDs.
 * @param candidates - Parameter used by getDecisionItemIDs.
 * @returns Result produced by getDecisionItemIDs.
 */
function getDecisionItemIDs(
  decision: PromptContextRouteDecision,
  candidates: RagItemCandidate[],
) {
  if (decision.route === "single_paper") {
    const itemID = decision.itemID ?? decision.itemIDs?.[0];
    return typeof itemID === "number" && Number.isFinite(itemID)
      ? [itemID]
      : [];
  }

  if (decision.route === "filtered_papers") {
    const itemIDs = filterCandidateItemIDs(decision, candidates);
    if (itemIDs.length) return itemIDs;
    if (decision.contentFocus === "abstracts") {
      return candidates.map((candidate) => candidate.itemID);
    }
    return [];
  }

  if (decision.route === "all_papers") {
    return candidates.map((candidate) => candidate.itemID);
  }

  return [];
}

/**
 * Returns the last captured prompt context routing debug payload.
 *
 * @returns Last prompt context debug payload, or null when none exists.
 */
export function getLastPromptContextRouteDebug() {
  return lastPromptContextRouteDebug
    ? {
        ...lastPromptContextRouteDebug,
        decision: { ...lastPromptContextRouteDebug.decision },
        selectedItemIDs: [...lastPromptContextRouteDebug.selectedItemIDs],
        error: lastPromptContextRouteDebug.error,
      }
    : null;
}

/**
 * Formats the last prompt context routing debug payload as JSON.
 *
 * @returns Human-readable debug string.
 */
export function formatLastPromptContextRouteDebug() {
  const debug = getLastPromptContextRouteDebug();
  if (!debug) return "Noch keine Prompt-Kontext-Entscheidung vorhanden.";

  return JSON.stringify(debug, null, 2);
}

/**
 * Records r ec or da ss is ta nt re qu es td eb ug.
 *
 * @param requestMessages - Parameter used by recordAssistantRequestDebug.
 * @param transport - Parameter used by recordAssistantRequestDebug.
 * @returns Result produced by recordAssistantRequestDebug.
 */
function recordAssistantRequestDebug(
  requestMessages: RequestMessage[],
  transport: AssistantRequestDebug["transport"],
) {
  lastAssistantRequestDebug = {
    provider: getActiveProvider(),
    model: getActiveModel(),
    transport,
    messageCount: requestMessages.length,
    messages: requestMessages.map((message) => ({ ...message })),
    createdAt: new Date().toISOString(),
  };

  Zotero.debug(
    `[assistantChatController] Finaler KI-Request gespeichert (${transport}, ${requestMessages.length} Nachrichten).`,
  );
}

/**
 * Returns the last captured assistant request debug payload.
 *
 * @returns Last assistant request debug payload, or null when none exists.
 */
export function getLastAssistantRequestDebug() {
  return lastAssistantRequestDebug
    ? {
        ...lastAssistantRequestDebug,
        messages: lastAssistantRequestDebug.messages.map((message) => ({
          ...message,
        })),
      }
    : null;
}

/**
 * Formats the last assistant request debug payload as JSON.
 *
 * @returns Human-readable debug string.
 */
export function formatLastAssistantRequestDebug() {
  const debug = getLastAssistantRequestDebug();
  if (!debug) return "Noch kein KI-Request vorhanden.";

  return JSON.stringify(debug, null, 2);
}

/**
 * Handles c on fi gu re pr ov id er fo rr ou ti ng.
 *
 * @param provider - Parameter used by configureProviderForRouting.
 * @returns Result produced by configureProviderForRouting.
 */
function configureProviderForRouting(provider: LLMProvider) {
  addon.api.ai.configureProvider(
    provider,
    provider === "ollama"
      ? {
          baseUrl: addon.data.settings.ollamaBaseUrl,
          model: getRouterModel(provider),
        }
      : {
          apiKey: addon.data.settings.apiKey,
          baseUrl: addon.data.settings.baseUrl,
          model: getRouterModel(provider),
        },
  );
}

/**
 * Gets g et ef fe ct iv ec on te xt ro ut er pr ov id er.
 * @returns Result produced by getEffectiveContextRouterProvider.
 */
function getEffectiveContextRouterProvider(): LLMProvider {
  return addon.data.settings.contextRouterProvider;
}

/**
 * Gets g et ro ut er mo de l.
 *
 * @param provider - Parameter used by getRouterModel.
 * @returns Result produced by getRouterModel.
 */
function getRouterModel(provider: LLMProvider) {
  if (provider === "ollama") {
    const model = addon.data.settings.ollamaModel;
    return isLocalEmbeddingModel(model) ? OLLAMA_DEFAULT_MODEL : model;
  }

  return addon.data.settings.model;
}

/**
 * Gets g et ac ti ve pa pe rr ef er en ce.
 * @returns Result produced by getActivePaperReference.
 */
async function getActivePaperReference(): Promise<PaperReference | null> {
  const selectedItem = await ItemManager.getSelectedRegularItem();
  if (selectedItem) {
    Zotero.debug(
      `[assistantChatController] Paper-Referenz erkannt (On-the-fly markiert): ItemKey ${selectedItem.key}`,
    );
    return {
      libraryID: selectedItem.libraryID,
      itemKey: selectedItem.key,
      itemID: selectedItem.id,
    };
  }

  const chat = getActiveChatSummary();
  if (chat?.zoteroLibraryID && chat.zoteroItemKey) {
    Zotero.debug(
      `[assistantChatController] Paper-Referenz erkannt (Aus Chat-Verlauf): ItemKey ${chat.zoteroItemKey}`,
    );
    return {
      libraryID: chat.zoteroLibraryID,
      itemKey: chat.zoteroItemKey,
    };
  }

  Zotero.debug(
    `[assistantChatController] Kein Paper markiert -> Bibliotheksweite Suche`,
  );
  return null;
}

/**
 * Appends a pp en da ss is ta nt de lt a.
 *
 * @param delta - Parameter used by appendAssistantDelta.
 * @returns Result produced by appendAssistantDelta.
 */
function appendAssistantDelta(delta: string): AssistantChatMessage | null {
  const activeResponse = activeAssistantResponse;
  if (!activeResponse) {
    return appendMessage("assistant", delta);
  }

  activeResponse.phase = "content";
  activeResponse.activity = deriveActivityMessage(
    activeResponse.prompt,
    "content",
  );
  activeResponse.pendingContent += delta;

  if (!activeResponse.assistantMessage) {
    if (!activeResponse.pendingContent.trim()) {
      renderAllHosts();
      return null;
    }

    const message = {
      id: nextMessageID++,
      role: "assistant",
      content: activeResponse.pendingContent.trimStart(),
    } satisfies AssistantChatMessage;
    activeResponse.assistantMessage = message;
    messages.push(message);
    renderAllHosts();
    return message;
  }

  activeResponse.assistantMessage.content += delta;
  renderAllHosts();
  return activeResponse.assistantMessage;
}

/**
 * Handles f in al iz ea ct iv ea ss is ta nt me ss ag e.
 * @returns Result produced by finalizeActiveAssistantMessage.
 */
function finalizeActiveAssistantMessage() {
  const message = activeAssistantResponse?.assistantMessage;
  if (!message) return null;

  const finalContent = message.content.trim();
  if (!finalContent) {
    const index = messages.findIndex((entry) => entry.id === message.id);
    if (index >= 0) messages.splice(index, 1);
    renderAllHosts();
    return null;
  }

  if (message.content !== finalContent) {
    message.content = finalContent;
    renderAllHosts();
  }

  return message;
}

/**
 * Handles u pd at ea ct iv ea ct iv it y.
 *
 * @param phase - Parameter used by updateActiveActivity.
 * @returns Result produced by updateActiveActivity.
 */
function updateActiveActivity(phase: ActiveAssistantResponse["phase"]) {
  const activeResponse = activeAssistantResponse;
  if (!activeResponse || activeResponse.assistantMessage?.content.trim()) {
    return;
  }

  const nextActivity = deriveActivityMessage(activeResponse.prompt, phase);
  if (activeResponse.activity === nextActivity) return;

  activeResponse.phase = phase;
  activeResponse.activity = nextActivity;
  renderAllHosts();
}

/**
 * Gets g et vi si bl ea ct iv it y.
 * @returns Result produced by getVisibleActivity.
 */
function getVisibleActivity() {
  const activeResponse = activeAssistantResponse;
  if (
    !requestRunning ||
    activeChatCancelRequested ||
    !activeResponse ||
    activeResponse.assistantMessage?.content.trim()
  ) {
    return null;
  }

  return activeResponse.activity;
}

/**
 * Checks whether h as re al ch at me ss ag es.
 * @returns Result produced by hasRealChatMessages.
 */
function hasRealChatMessages() {
  return messages.some(
    (message) =>
      message.role === "user" ||
      (message.role === "assistant" && message.content.trim()),
  );
}

/**
 * Derives d er iv ea ct iv it ym es sa ge.
 *
 * @param prompt - Parameter used by deriveActivityMessage.
 * @param phase - Parameter used by deriveActivityMessage.
 * @returns Result produced by deriveActivityMessage.
 */
function deriveActivityMessage(
  prompt: string,
  phase: ActiveAssistantResponse["phase"],
) {
  if (phase === "content") return "Formuliere Antwort...";
  if (phase === "reasoning") return "Denke nach...";

  const normalizedPrompt = prompt.toLowerCase();

  if (
    /(übersetz|uebersetz|\btranslate\b|\btranslation\b)/.test(normalizedPrompt)
  ) {
    return "Übersetze...";
  }
  if (
    /(zusammenfass|fasse zusammen|\bsummary\b|\bsummarize\b|\babstract\b)/.test(
      normalizedPrompt,
    )
  ) {
    return "Fasse zusammen...";
  }
  if (
    /\b(code|typescript|javascript|python|java|klasse|funktion|bug|stack trace|fehlermeldung)\b/.test(
      normalizedPrompt,
    )
  ) {
    return "Analysiere Code...";
  }
  if (
    /(vergleich|vergleiche|\bcompare\b|unterschied|gegenüber|gegenueber)/.test(
      normalizedPrompt,
    )
  ) {
    return "Vergleiche Inhalte...";
  }
  if (
    /(rechne|berechne|kalkulier|\bcalculate\b|mathe|gleichung|formel)/.test(
      normalizedPrompt,
    )
  ) {
    return "Berechne...";
  }
  if (
    /(argument|bewerte|bewertung|kritik|position|these)/.test(normalizedPrompt)
  ) {
    return "Bewerte Argumente...";
  }
  if (/(lösungsweg|loesungsweg|beweis|herleitung)/.test(normalizedPrompt)) {
    return "Prüfe den Lösungsweg...";
  }
  if (/(\bplan\b|plane|struktur|entwurf|konzept)/.test(normalizedPrompt)) {
    return "Plane Antwort...";
  }

  return "Denke nach...";
}

/**
 * Determines whether s ho ul df al lb ac kt ob uf fe re dc ha t.
 *
 * @param error - Parameter used by shouldFallbackToBufferedChat.
 * @returns Result produced by shouldFallbackToBufferedChat.
 */
function shouldFallbackToBufferedChat(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /stream|sse|event-stream|unsupported|not supported|chatStream/i.test(
    message,
  );
}

/**
 * Throws the failure for f ai ln oa ns we r.
 * @returns Result produced by failNoAnswer.
 */
function failNoAnswer(): never {
  throw new Error("ZAIA hat keine Textantwort zurückgegeben.");
}

/**
 * Appends a pp en dm es sa ge.
 *
 * @param role - Parameter used by appendMessage.
 * @param content - Parameter used by appendMessage.
 * @param tokenUsage - Parameter used by appendMessage.
 * @returns Result produced by appendMessage.
 */
function appendMessage(
  role: ChatRole,
  content: string,
  tokenUsage?: AssistantChatMessage["tokenUsage"],
) {
  const message = {
    id: nextMessageID++,
    role,
    content,
    tokenUsage,
  } satisfies AssistantChatMessage;

  messages.push(message);
  renderAllHosts();
  return message;
}

/**
 * Ensures e ns ur ea ct iv ec ha t.
 *
 * @param firstPrompt - Parameter used by ensureActiveChat.
 * @returns Result produced by ensureActiveChat.
 */
async function ensureActiveChat(
  firstPrompt: string,
): Promise<ActiveChatResolution> {
  if (activeChatID) {
    const activeSummary = chatSummaries.find(
      (chat) => chat.id === activeChatID,
    );
    const needsInitialTitle = !hasRealChatMessages() && !activeSummary?.title;

    if (needsInitialTitle) {
      await ChatRepository.updateChatTitle(
        activeChatID,
        deriveChatTitle(firstPrompt),
      );
      await refreshChatSummaries(false);
    }

    return {
      chatID: activeChatID,
      shouldGenerateTitle: needsInitialTitle,
    };
  }

  const chat = await ChatRepository.createChat({
    ...getSelectedItemChatInput(),
    title: deriveChatTitle(firstPrompt),
  });
  activeChatID = chat.id;
  showAllChats = false;
  await refreshChatSummaries(false);

  return {
    chatID: chat.id,
    shouldGenerateTitle: true,
  };
}

/**
 * Handles t ry ge ne ra te ch at ti tl e.
 *
 * @param chatID - Parameter used by tryGenerateChatTitle.
 * @param firstPrompt - Parameter used by tryGenerateChatTitle.
 * @returns Result produced by tryGenerateChatTitle.
 */
async function tryGenerateChatTitle(chatID: string, firstPrompt: string) {
  try {
    await generateChatTitle(chatID, firstPrompt);
  } catch (error) {
    Zotero.debug(`ZAIA: Chat-Titel konnte nicht generiert werden: ${error}`);
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  } finally {
    pendingGeneratedTitleChatIDs.delete(chatID);
    renderAllHosts();
  }
}

/**
 * Handles g en er at ec ha tt it le.
 *
 * @param chatID - Parameter used by generateChatTitle.
 * @param firstPrompt - Parameter used by generateChatTitle.
 * @returns Result produced by generateChatTitle.
 */
async function generateChatTitle(chatID: string, firstPrompt: string) {
  const content = await requestGeneratedTitleContent([
    {
      role: "system",
      content: TITLE_GENERATION_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: firstPrompt,
    },
  ]);
  const title = normalizeGeneratedChatTitle(content);

  if (!title) return;

  await ChatRepository.updateChatTitle(chatID, title);
  await refreshChatSummaries(true);
}

/**
 * Requests r eq ue st ge ne ra te dt it le co nt en t.
 *
 * @param requestMessages - Parameter used by requestGeneratedTitleContent.
 * @returns Result produced by requestGeneratedTitleContent.
 */
async function requestGeneratedTitleContent(
  requestMessages: Array<{ role: "system" | "user"; content: string }>,
) {
  const options = {
    providerId: addon.data.settings.provider,
    model: getActiveModel(),
    temperature: 0.2,
  };

  if (typeof addon.api.ai.chatStream === "function") {
    try {
      let content = "";
      for await (const event of addon.api.ai.chatStream(
        requestMessages,
        options,
      ) as AsyncIterable<{ type?: unknown; content?: unknown }>) {
        if (
          event?.type === "content" &&
          typeof event.content === "string" &&
          event.content
        ) {
          content += event.content;
        }
        if (event?.type === "done") break;
      }

      if (content.trim()) return content;
    } catch (error) {
      if (!shouldFallbackToBufferedChat(error)) throw error;
    }
  }

  const result = (await addon.api.ai.chat(requestMessages, options)) as {
    content?: unknown;
  };
  if (typeof result?.content === "string" && result.content.trim()) {
    return result.content;
  }

  throw new Error("ZAIA konnte keinen Chat-Titel generieren.");
}

/**
 * Normalizes n or ma li ze ge ne ra te dc ha tt it le.
 *
 * @param content - Parameter used by normalizeGeneratedChatTitle.
 * @returns Result produced by normalizeGeneratedChatTitle.
 */
function normalizeGeneratedChatTitle(content: unknown) {
  if (typeof content !== "string") return "";

  const firstLine = content.trim().split(/\r?\n/)[0] ?? "";
  const title = firstLine
    .replace(/^\s*(titel|title)\s*:\s*/i, "")
    .replace(/^["'`“”„‚‘]+|["'`“”„‚‘]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .trim();

  if (title.length <= MAX_GENERATED_TITLE_LENGTH) return title;

  return `${title.slice(0, MAX_GENERATED_TITLE_LENGTH - 3).trim()}...`;
}

/**
 * Persists p er si st ch at me ss ag e.
 *
 * @param chatID - Parameter used by persistChatMessage.
 * @param message - Parameter used by persistChatMessage.
 * @returns Result produced by persistChatMessage.
 */
async function persistChatMessage(
  chatID: string,
  message: AssistantChatMessage,
) {
  if (message.role !== "user" && message.role !== "assistant") {
    return;
  }

  const position = messages.filter(
    (entry) => entry.role === "user" || entry.role === "assistant",
  ).length;

  await ChatRepository.appendMessage({
    chatId: chatID,
    role: message.role,
    content: message.content,
    position: Math.max(0, position - 1),
    tokenUsage: message.tokenUsage,
  });
}

/**
 * Resets r es et me ss ag es.
 * @returns Result produced by resetMessages.
 */
function resetMessages() {
  messages.length = 0;
  nextMessageID = 1;
}

/**
 * Gets g et pr ef er re da ss is ta nt ho st.
 *
 * @param owner - Parameter used by getPreferredAssistantHost.
 * @returns Result produced by getPreferredAssistantHost.
 */
function getPreferredAssistantHost(owner?: Window | null) {
  const connectedHosts = [...hosts].filter((host) => {
    if (!host.isConnected) {
      hosts.delete(host);
      return false;
    }

    return true;
  });

  if (owner) {
    const ownedHost = connectedHosts.find(
      (host) => host.ownerDocument.defaultView === owner,
    );
    if (ownedHost) return ownedHost;

    const containedHost = connectedHosts.find((host) =>
      owner.document.contains(host),
    );
    if (containedHost) return containedHost;

    const documentHost = owner.document.querySelector<HTMLElement>(
      ".zotero-ai-assistant-host",
    );
    if (documentHost) {
      hosts.add(documentHost);
      return documentHost;
    }
  }

  return connectedHosts[0] ?? null;
}

/**
 * Checks whether i sa ss is ta nt ho st re ad yf or po po ve r.
 *
 * @param host - Parameter used by isAssistantHostReadyForPopover.
 * @returns Result produced by isAssistantHostReadyForPopover.
 */
function isAssistantHostReadyForPopover(host: HTMLElement) {
  if (host.hidden || host.getAttribute("aria-hidden") === "true") {
    return false;
  }

  return isElementReadyForPopover(host);
}

/**
 * Checks whether i se le me nt re ad yf or po po ve r.
 *
 * @param element - Parameter used by isElementReadyForPopover.
 * @returns Result produced by isElementReadyForPopover.
 */
function isElementReadyForPopover(element: HTMLElement) {
  const win = element.ownerDocument.defaultView;
  const style = win?.getComputedStyle(element);
  if (!style || style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Gets g et se le ct ed it em ch at in pu t.
 * @returns Result produced by getSelectedItemChatInput.
 */
function getSelectedItemChatInput(): CreateChatInput {
  try {
    const item = ItemManager.filterItems()[0];
    if (!item) return {};

    return {
      zoteroLibraryID: item.libraryID,
      zoteroItemKey: item.key,
    };
  } catch (error) {
    Zotero.debug(
      `ZAIA: Zotero-Item-Kontext konnte nicht gelesen werden: ${error}`,
    );
    return {};
  }
}

/**
 * Derives d er iv ec ha tt it le.
 *
 * @param prompt - Parameter used by deriveChatTitle.
 * @returns Result produced by deriveChatTitle.
 */
function deriveChatTitle(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= 60) return normalized;

  return `${normalized.slice(0, 57)}...`;
}

/**
 * Renders r en de ra ll ho st s.
 * @returns Result produced by renderAllHosts.
 */
function renderAllHosts() {
  for (const host of [...hosts]) {
    if (!host.isConnected) {
      hosts.delete(host);
      continue;
    }
    renderHost(host);
  }
}

/**
 * A settings change (e.g. a Base-URL edit) can leave the active provider
 * stuck in "checking" for a while (Ollama auto-start retries for up to
 * ~20s). Milestones only turn actionable once that resolves, which would
 * otherwise leave the welcome/chat view showing with a silently disabled
 * composer. After a short grace period (covers ordinary, fast rechecks
 * like a provider switch) this forces the setup view open so the user
 * isn't left staring at a dead end.
 */
/**
 * Erkennt, ob eine laufende Setup-Prüfung festhängt, und aktualisiert den dafür
 * verwendeten Zeitstempel.
 *
 * @param readiness - Aktuell berechneter Einrichtungsstand.
 * @returns Ob die Prüfung länger als zulässig unverändert läuft.
 */
function updateSetupStallState(
  chatReady: boolean,
  hasActionableMilestone: boolean,
) {
  if (chatReady || hasActionableMilestone) {
    setupStalled = false;
    if (setupStallTimeoutHandle !== null) {
      clearTimeout(setupStallTimeoutHandle);
      setupStallTimeoutHandle = null;
    }
    return;
  }

  if (setupStallTimeoutHandle !== null) return;
  setupStallTimeoutHandle = setTimeout(() => {
    setupStallTimeoutHandle = null;
    setupStalled = true;
    renderAllHosts();
  }, SETUP_STALL_TIMEOUT_MS);
}

/**
 * Renders r en de rh os t.
 *
 * @param host - Parameter used by renderHost.
 * @returns Result produced by renderHost.
 */
function renderHost(host: HTMLElement) {
  const main = host.querySelector<HTMLElement>(".zai-main");
  const top = host.querySelector<HTMLElement>(".zai-top");
  const welcome = host.querySelector<HTMLElement>(".zai-welcome");
  const modelPicker = host.querySelector<HTMLElement>(".zai-model-picker");
  const footer = host.querySelector<HTMLElement>(".zai-footer");
  const messageList = host.querySelector<HTMLElement>(".zai-messages");
  const chatList = host.querySelector<HTMLElement>(".zai-chat-list");
  const chatListActions = host.querySelector<HTMLElement>(
    ".zai-chat-list-actions",
  );
  const seeAll = host.querySelector<HTMLButtonElement>(".zai-see-all");
  const activeChatBar = host.querySelector<HTMLElement>(".zai-active-chat-bar");
  const activeChatTitle = host.querySelector<HTMLElement>(
    ".zai-active-chat-title",
  );
  const backButton = host.querySelector<HTMLButtonElement>(
    ".zai-chat-back-button",
  );
  const favoriteButton = host.querySelector<HTMLButtonElement>(
    ".zai-chat-favorite-button",
  );
  const deleteButton = host.querySelector<HTMLButtonElement>(
    ".zai-chat-delete-button",
  );
  const sendButton = host.querySelector<HTMLButtonElement>(".zai-send-button");
  const terminateOllamaButton = host.querySelector<HTMLButtonElement>(
    ".zai-ollama-terminate-button",
  );
  const textarea = host.querySelector<HTMLTextAreaElement>(".zai-input");
  const status = host.querySelector<HTMLElement>(".zai-chat-status");
  const aboutView = host.querySelector<HTMLElement>(".zai-about-view");
  const viewTargetButtons = Array.from(
    host.querySelectorAll("[data-view-target]"),
  ) as HTMLButtonElement[];

  if (!main || !messageList) return;

  const currentView = getSidebarView(host);
  const showAbout = currentView === "about";
  const readiness = getCurrentSetupReadiness();
  const hasActionableMilestone = readiness.milestones.some(
    (milestone) => milestone.state === "action" || milestone.state === "error",
  );
  const chatReady = readiness.ready;
  updateSetupStallState(chatReady, hasActionableMilestone);
  /**
   * Once the setup view is showing, keep it visible through transient
   * re-checking so provider switches do not flash the welcome screen.
   */
  const showSetup =
    hasActionableMilestone || setupStalled || (setupWasVisible && !chatReady);
  setupWasVisible = showSetup;
  const showWelcome = !activeChatID && !showSetup;
  const showChat = !showWelcome && !showSetup;
  top?.classList.toggle("zai-top-chat-active", showChat && !showAbout);
  top?.classList.toggle("zai-top-about-active", showAbout);
  main.classList.toggle(
    "zai-main-empty",
    !showAbout && (showWelcome || showSetup),
  );
  main.classList.toggle("zai-main-chat-active", showChat && !showAbout);
  main.classList.toggle("zai-main-about-active", showAbout);
  modelPicker?.toggleAttribute("hidden", showAbout);
  footer?.toggleAttribute("hidden", showAbout);
  welcome?.toggleAttribute("hidden", showAbout || !showWelcome);
  syncSetupTimeline(host, !showAbout && showSetup, readiness);
  messageList.toggleAttribute("hidden", showAbout || !showChat);
  aboutView?.toggleAttribute("hidden", !showAbout);
  for (const viewTargetButton of viewTargetButtons) {
    const isActive = getSidebarViewTarget(viewTargetButton) === currentView;
    viewTargetButton.classList.toggle(
      "zai-header-icon-button-active",
      isActive,
    );
    viewTargetButton.setAttribute("aria-current", isActive ? "page" : "false");
  }
  chatList?.toggleAttribute("hidden", showAbout || !showWelcome);
  const showSeeAll = showWelcome && chatSummaries.length > 3;
  chatListActions?.toggleAttribute("hidden", showAbout || !showSeeAll);
  seeAll?.toggleAttribute("hidden", showAbout || !showSeeAll);
  activeChatBar?.toggleAttribute("hidden", !showAbout && !showChat);

  if (activeChatTitle) {
    const title = showAbout ? "Über ZAIA" : getActiveChatTitle();
    activeChatTitle.textContent = title;
    activeChatTitle.classList.toggle(
      "zai-active-chat-title-pending",
      !showAbout &&
        Boolean(activeChatID && pendingGeneratedTitleChatIDs.has(activeChatID)),
    );
  }
  if (backButton) {
    backButton.disabled = !showAbout && requestRunning;
    backButton.setAttribute(
      "aria-label",
      showAbout ? "Zurück zum Chat" : "Zurück zur Startansicht",
    );
    backButton.setAttribute("title", showAbout ? "Zurück zum Chat" : "Zurück");
  }
  const activeChatSummary = getActiveChatSummary();
  const isActiveFavorite = Boolean(activeChatSummary?.isFavorite);
  if (favoriteButton) {
    const favoriteLabel = isActiveFavorite
      ? "Favorit entfernen"
      : "Chat favorisieren";
    favoriteButton.toggleAttribute("hidden", showAbout);
    favoriteButton.disabled = requestRunning || !activeChatID || showAbout;
    favoriteButton.setAttribute("aria-label", favoriteLabel);
    favoriteButton.setAttribute("aria-pressed", String(isActiveFavorite));
    favoriteButton.setAttribute("title", favoriteLabel);
  }
  if (deleteButton) {
    deleteButton.toggleAttribute("hidden", showAbout);
    deleteButton.disabled = requestRunning || !activeChatID || showAbout;
  }
  if (seeAll) {
    seeAll.textContent = showAllChats ? "Weniger anzeigen" : "Alle ansehen";
  }
  if (chatList && !showAbout && showWelcome) renderChatList(host, chatList);
  syncPaperContextControls(host);

  const renderedMessages = messages
    .map((message) => createMessageElement(host, message))
    .filter((element): element is HTMLElement => Boolean(element));
  messageList.replaceChildren(...renderedMessages);

  const activeActivity = getVisibleActivity();
  if (activeActivity) {
    messageList.append(createActivityElement(host, activeActivity));
  }

  if (sendButton) syncSendButton(sendButton, chatReady);
  if (terminateOllamaButton) {
    terminateOllamaButton.disabled = ollamaTerminateRunning;
  }
  if (textarea) textarea.disabled = requestRunning || !chatReady;

  if (status) {
    const statusText = getComposerStatusText(chatReady, readiness);
    status.textContent = statusText;
    status.toggleAttribute("hidden", !statusText);
    status.classList.toggle("zai-chat-status-simulation", simulationEnabled);
  }

  main.scrollTop = showWelcome || showAbout ? 0 : main.scrollHeight;
}

/**
 * Synchronisiert Sichtbarkeit, Meilensteine und Live-Status der Setup-Timeline
 * mit dem aktuellen Einrichtungsstand.
 *
 * @param host - Sidebar-Element, dessen Setup-Anzeige aktualisiert wird.
 * @param showSetup - Legt fest, ob die Setup-Timeline sichtbar ist.
 * @param readiness - Aktueller Einrichtungsstand.
 */
function syncSetupTimeline(
  host: HTMLElement,
  showSetup: boolean,
  readiness: SetupReadiness,
) {
  const setup = host.querySelector<HTMLElement>(".zai-setup-timeline");
  const list = setup?.querySelector<HTMLOListElement>(".zai-setup-milestones");
  const liveStatus = setup?.querySelector<HTMLElement>(
    ".zai-setup-live-status",
  );
  if (!setup || !list) return;

  setup.toggleAttribute("hidden", !showSetup);
  setup.dataset.provider = readiness.provider;
  if (!showSetup) return;

  syncProviderToggleButtons(host, readiness.provider);

  list.replaceChildren(
    ...readiness.milestones.map((milestone) =>
      createSetupMilestoneElement(
        host.ownerDocument,
        milestone,
        milestone.state === "action" || milestone.state === "error",
        readiness,
      ),
    ),
  );

  if (liveStatus) {
    const statusText = ollamaSetupLaunchRunning
      ? getString("sidebar-setup-external-running")
      : ollamaSetupStatusText;
    liveStatus.textContent = statusText;
    liveStatus.toggleAttribute("hidden", !statusText);
  }
}

/**
 * Erstellt die vollständige UI-Karte für einen Setup-Meilenstein einschließlich
 * Status, Fortschritt und verfügbarer Aktionen.
 *
 * @param doc - Dokument, in dem das Element erzeugt wird.
 * @param milestone - Darzustellender Setup-Meilenstein.
 * @param needsAttention - Markiert den Meilenstein als handlungsbedürftig.
 * @param readiness - Aktueller Einrichtungsstand.
 * @returns Fertiges Listenelement für die Setup-Timeline.
 */
function createSetupMilestoneElement(
  doc: Document,
  milestone: SetupMilestone,
  needsAttention: boolean,
  readiness: SetupReadiness,
) {
  const item = createControllerHtmlElement(doc, "li", "zai-setup-milestone");
  item.dataset.state = milestone.state;
  item.dataset.milestone = milestone.id;
  item.classList.toggle("zai-setup-milestone-attention", needsAttention);

  const marker = createControllerHtmlElement(
    doc,
    "span",
    "zai-setup-milestone-marker",
  );
  marker.setAttribute("aria-hidden", "true");
  marker.textContent = milestone.state === "complete" ? "✓" : "!";

  const card = createControllerHtmlElement(
    doc,
    "article",
    "zai-setup-step-card",
  );
  const copy = getSetupMilestoneCopy(milestone, readiness);
  const download = getSetupMilestoneDownload(milestone.id);
  const showDetails =
    needsAttention || milestone.state === "checking" || Boolean(download);
  item.classList.toggle("zai-setup-milestone-compact", !showDetails);
  const heading = createControllerHtmlElement(
    doc,
    "div",
    "zai-setup-step-heading",
  );
  const title = createControllerHtmlElement(
    doc,
    "h3",
    "zai-setup-step-title",
    copy.title,
  );
  const badge = createControllerHtmlElement(
    doc,
    "span",
    "zai-setup-step-badge",
    getMilestoneStateLabel(milestone.state),
  );
  heading.append(title, badge);
  card.append(heading);
  if (showDetails) {
    card.append(
      createControllerHtmlElement(
        doc,
        "p",
        "zai-setup-step-description",
        copy.description,
      ),
    );
  }

  const statusText = download ? download.statusText : copy.status;
  if (showDetails && statusText) {
    card.append(
      createControllerHtmlElement(
        doc,
        "p",
        "zai-setup-step-status",
        statusText,
      ),
    );
  }

  if (download?.status === "downloading") {
    const progress = createControllerHtmlElement(
      doc,
      "div",
      "zai-setup-step-progress",
    );
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    const fill = createControllerHtmlElement(
      doc,
      "span",
      "zai-setup-step-progress-fill",
    );
    if (download.percent !== null) {
      const value = Math.max(0, Math.min(100, Math.round(download.percent)));
      progress.setAttribute("aria-valuenow", String(value));
      fill.style.width = `${value}%`;
    }
    progress.append(fill);
    card.append(progress);
  }

  const actions = createSetupMilestoneActions(doc, milestone, readiness);
  if (actions.childElementCount) card.append(actions);
  item.append(marker, card);
  return item;
}

/**
 * Liefert den laufenden Modelldownload für einen downloadfähigen Meilenstein.
 *
 * @param milestoneId - Kennung des Setup-Meilensteins.
 * @returns Downloadstatus oder `undefined`, wenn kein Download zugeordnet ist.
 */
function getSetupMilestoneDownload(milestoneId: SetupMilestone["id"]) {
  return milestoneId === "local-model" || milestoneId === "embedding"
    ? setupModelDownloads.get(milestoneId)
    : undefined;
}

/**
 * Ermittelt Titel, Beschreibung und Statustext eines Setup-Meilensteins.
 *
 * @param milestone - Darzustellender Setup-Meilenstein.
 * @param readiness - Aktueller Einrichtungsstand.
 * @returns Lokalisierte Texte für die Setup-Karte.
 */
function getSetupMilestoneCopy(
  milestone: SetupMilestone,
  readiness: SetupReadiness,
) {
  const providerConnection =
    addon.data.runtime.providerConnections[readiness.provider];
  const embeddingConnection = addon.data.runtime.embeddingConnection;
  switch (milestone.id) {
    case "cloud-connection":
      return {
        title: getString("sidebar-milestone-cloud-connection-title"),
        description: getString(
          "sidebar-milestone-cloud-connection-description",
        ),
        status:
          milestone.state === "complete"
            ? getString("sidebar-milestone-cloud-connection-ready")
            : !addon.data.settings.apiKey.trim()
              ? getString("sidebar-cloud-api-key-missing")
              : getProviderConnectionStatusText("kisski", providerConnection),
      };
    case "ollama-installation":
      return {
        title: getString("sidebar-milestone-ollama-installation-title"),
        description: getString(
          "sidebar-milestone-ollama-installation-description",
        ),
        status: getOllamaInstallationStatusText(
          readiness.provider === "ollama" ? providerConnection : undefined,
          embeddingConnection,
        ),
      };
    case "ollama-service":
      return {
        title: getString("sidebar-milestone-ollama-service-title"),
        description: getString("sidebar-milestone-ollama-service-description"),
        status: getOllamaServiceStatusText(
          readiness.provider === "ollama" ? providerConnection : undefined,
          embeddingConnection,
        ),
      };
    case "local-model":
      return {
        title: getString("sidebar-milestone-local-model-title"),
        description: getString("sidebar-milestone-local-model-description", {
          args: { model: getActiveModel("ollama") },
        }),
        status:
          milestone.state === "complete"
            ? getString("sidebar-milestone-local-model-ready")
            : milestone.state === "pending"
              ? ""
              : getProviderConnectionStatusText("ollama", providerConnection),
      };
    case "embedding":
      return {
        title: getString("sidebar-milestone-embedding-title"),
        description: getString("sidebar-milestone-embedding-description", {
          args: { model: REQUIRED_EMBEDDING_MODEL },
        }),
        status:
          milestone.state === "complete"
            ? getString("sidebar-milestone-embedding-ready")
            : milestone.state === "pending"
              ? ""
              : getEmbeddingConnectionStatusText(embeddingConnection),
      };
  }
}

/**
 * Übersetzt den technischen Zustand eines Setup-Meilensteins in eine
 * lokalisierte UI-Beschriftung.
 *
 * @param state - Technischer Zustand des Meilensteins.
 * @returns Lokalisierte Zustandsbezeichnung.
 */
function getMilestoneStateLabel(state: SetupMilestone["state"]) {
  switch (state) {
    case "complete":
      return getString("sidebar-milestone-state-complete");
    case "checking":
      return getString("sidebar-milestone-state-checking");
    case "error":
      return getString("sidebar-milestone-state-error");
    case "action":
      return getString("sidebar-milestone-state-action");
    default:
      return getString("sidebar-milestone-state-pending");
  }
}

/**
 * Erzeugt die zum jeweiligen Setup-Meilenstein passenden Aktionsbuttons und
 * sperrt sie während laufender Installations- oder Startvorgänge.
 *
 * @param doc - Dokument, in dem die Buttons erzeugt werden.
 * @param milestone - Meilenstein, für den Aktionen angeboten werden.
 * @param readiness - Aktueller Einrichtungsstand.
 * @returns Container mit den verfügbaren Setup-Aktionen.
 */
function createSetupMilestoneActions(
  doc: Document,
  milestone: SetupMilestone,
  readiness: SetupReadiness,
) {
  const actions = createControllerHtmlElement(
    doc,
    "div",
    "zai-setup-step-actions",
  );
  const addAction = (action: string, label: string, secondary = false) => {
    const button = createHtmlButton(
      doc,
      `zai-setup-action${secondary ? " zai-setup-action-secondary" : ""}`,
      label,
    );
    button.dataset.action = action;
    actions.append(button);
  };

  const download = getSetupMilestoneDownload(milestone.id);
  if (download?.status === "downloading") {
    addAction(
      milestone.id === "local-model"
        ? "cancel-local-model-download"
        : "cancel-embedding-download",
      getString("sidebar-cancel-model-download"),
      true,
    );
    return actions;
  }

  if (milestone.state === "complete") {
    return actions;
  }
  if (milestone.state === "pending") {
    if (milestone.id === "embedding") {
      addAction(
        "open-semantic-settings",
        getString("sidebar-disable-semantic-search"),
        true,
      );
    }
    return actions;
  }

  const providerConnection =
    addon.data.runtime.providerConnections[readiness.provider];
  const embeddingConnection = addon.data.runtime.embeddingConnection;

  switch (milestone.id) {
    case "cloud-connection":
      if (!addon.data.settings.apiKey.trim()) {
        addAction("open-preferences", getString("sidebar-open-preferences"));
      } else {
        addAction("check-readiness", getString("sidebar-check-provider"));
        addAction(
          "open-preferences",
          getString("sidebar-open-preferences"),
          true,
        );
      }
      break;
    case "ollama-installation":
      if (
        providerConnection?.status === "missing-config" ||
        embeddingConnection.status === "missing-config"
      ) {
        addAction("open-preferences", getString("sidebar-open-preferences"));
      } else {
        addAction(
          "launch-required-setup",
          getString("sidebar-launch-ollama-setup"),
        );
      }
      break;
    case "ollama-service":
      addAction(
        "start-ollama",
        ollamaStartRunning
          ? getString("sidebar-starting-ollama")
          : getString("sidebar-start-ollama"),
      );
      addAction("check-readiness", getString("sidebar-check-provider"), true);
      break;
    case "local-model":
      addAction(
        getActiveModel("ollama") === OLLAMA_DEFAULT_MODEL
          ? "install-default-local-model"
          : "open-local-model-window",
        getActiveModel("ollama") === OLLAMA_DEFAULT_MODEL
          ? getString(
              download?.status === "error"
                ? "sidebar-retry-model-download"
                : "sidebar-install-default-local-model",
            )
          : getString("sidebar-open-local-model-window"),
      );
      addAction("check-readiness", getString("sidebar-check-provider"), true);
      break;
    case "embedding":
      addAction(
        "install-embedding-model",
        getString(
          download?.status === "error"
            ? "sidebar-retry-model-download"
            : "sidebar-install-embedding-model",
        ),
      );
      addAction(
        "open-semantic-settings",
        getString("sidebar-disable-semantic-search"),
        true,
      );
      break;
  }

  actions.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled =
      milestone.state === "checking" ||
      ollamaSetupLaunchRunning ||
      ollamaStartRunning;
  });
  return actions;
}

/**
 * Leitet aus Provider- und Embedding-Verbindung den Statustext der
 * Ollama-Installation ab.
 *
 * @param providerConnection - Aktueller Status des lokalen Chat-Providers.
 * @param embeddingConnection - Aktueller Status der Embedding-Verbindung.
 * @returns Lokalisierter Installationstext.
 */
function getOllamaInstallationStatusText(
  providerConnection: ProviderConnectionResult | undefined,
  embeddingConnection: EmbeddingConnectionResult,
) {
  const connections = [providerConnection, embeddingConnection];

  if (
    connections.some(
      (connection) => connection?.issue === "ollama-not-installed",
    )
  ) {
    return getString("sidebar-ollama-not-installed");
  }

  const active = providerConnection ?? embeddingConnection;
  if (active.status === "checking") {
    return getString("sidebar-checking-provider");
  }
  if (active.status === "missing-config") {
    if (active.issue === "base-url-missing") {
      return getString("sidebar-base-url-missing");
    }
    return getString("sidebar-local-config-incomplete");
  }
  if (active.status === "unknown" || active.status === "disabled") {
    return getString("sidebar-connection-not-checked");
  }
  return getString("sidebar-milestone-ollama-installation-ready");
}

/**
 * Leitet aus den Verbindungsdaten den Statustext des Ollama-Dienstes ab.
 *
 * @param providerConnection - Aktueller Status des lokalen Chat-Providers.
 * @param embeddingConnection - Aktueller Status der Embedding-Verbindung.
 * @returns Lokalisierter Dienststatus.
 */
function getOllamaServiceStatusText(
  providerConnection: ProviderConnectionResult | undefined,
  embeddingConnection: EmbeddingConnectionResult,
) {
  const connections = [providerConnection, embeddingConnection];

  if (
    connections.some(
      (connection) => connection?.issue === "ollama-not-installed",
    )
  ) {
    return "";
  }
  if (
    connections.some((connection) => connection?.issue === "ollama-not-running")
  ) {
    return getString("sidebar-ollama-not-running");
  }
  if (
    connections.some(
      (connection) => connection?.issue === "ollama-start-failed",
    )
  ) {
    return getString("sidebar-ollama-start-failed");
  }
  if (
    connections.some(
      (connection) => connection?.issue === "ollama-startup-timeout",
    )
  ) {
    return getString("sidebar-ollama-startup-timeout");
  }

  const active = providerConnection ?? embeddingConnection;
  if (active.status === "checking") {
    return getString("sidebar-checking-provider");
  }
  if (active.status === "ready" || active.status === "missing-model") {
    return getString("sidebar-milestone-ollama-service-ready");
  }
  if (active.status === "unknown" || active.status === "disabled") {
    return getString("sidebar-connection-not-checked");
  }
  return getString("sidebar-local-unreachable");
}

/**
 * Creates c re at eh tm lb ut to n.
 *
 * @param doc - Parameter used by createHtmlButton.
 * @param className - Parameter used by createHtmlButton.
 * @param text - Parameter used by createHtmlButton.
 * @returns Result produced by createHtmlButton.
 */
function createHtmlButton(doc: Document, className: string, text: string) {
  const button = createControllerHtmlElement(
    doc,
    "button",
    className,
    text,
  ) as HTMLButtonElement;
  button.type = "button";
  return button;
}

/**
 * Checks whether i sp ro vi de rc on ne ct io nr ea dy.
 *
 * @param connection - Parameter used by isProviderConnectionReady.
 * @returns Result produced by isProviderConnectionReady.
 */
function isProviderConnectionReady(
  connection: ProviderConnectionResult | undefined,
) {
  return connection?.status === "ready";
}

/**
 * Checks whether i se mb ed di ng co nn ec ti on re ad y.
 *
 * @param connection - Parameter used by isEmbeddingConnectionReady.
 * @returns Result produced by isEmbeddingConnectionReady.
 */
function isEmbeddingConnectionReady(connection: EmbeddingConnectionResult) {
  return connection.status === "ready";
}

/**
 * Gets g et co mp os er st at us te xt.
 *
 * @param providerReady - Parameter used by getComposerStatusText.
 * @param readiness - Parameter used by getComposerStatusText.
 * @returns Result produced by getComposerStatusText.
 */
function getComposerStatusText(
  providerReady: boolean,
  readiness?: SetupReadiness,
) {
  if (!providerReady) {
    const isChecking = readiness?.milestones.some(
      (milestone) => milestone.state === "checking",
    );
    return isChecking
      ? getString("sidebar-checking-provider")
      : getString("sidebar-provider-not-connected");
  }
  if (simulationEnabled) {
    return pendingSimulationPrompts.length
      ? `Simulation: ${pendingSimulationPrompts.length} Antwort(en) ausstehend`
      : "Simulation aktiv";
  }
  if (requestRunning && activeChatCancelRequested) return "Stoppe Antwort...";
  return requestRunning ? "ZAIA antwortet" : "";
}

/**
 * Synchronizes s yn cs en db ut to n.
 *
 * @param button - Parameter used by syncSendButton.
 * @param providerReady - Parameter used by syncSendButton.
 * @returns Result produced by syncSendButton.
 */
function syncSendButton(button: HTMLButtonElement, providerReady: boolean) {
  const doc = button.ownerDocument;
  const isStopping = requestRunning && activeChatCancelRequested;
  const label = isStopping
    ? "Antwort wird gestoppt"
    : requestRunning
      ? "Antwort stoppen"
      : "Nachricht senden";

  button.disabled = !providerReady || isStopping;
  button.classList.toggle("zai-send-button-stop", requestRunning);
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.replaceChildren(
    requestRunning ? createStopSquareIcon(doc) : createSendArrowIcon(doc),
  );
}

/**
 * Formatiert den Embedding-Verbindungsstatus für die Setup-Anzeige und
 * berücksichtigt dabei laufende Ollama-Installations- und Startvorgänge.
 *
 * @param connection - Aktueller Embedding-Verbindungsstatus.
 * @returns Lokalisierter Statustext oder ein leerer String bei Bereitschaft.
 */
function getEmbeddingConnectionStatusText(
  connection: EmbeddingConnectionResult,
) {
  if (ollamaStartRunning) return getString("sidebar-starting-ollama");
  if (ollamaSetupLaunchRunning) {
    return getString("sidebar-launching-ollama-setup");
  }
  if (connection.status === "unknown") {
    return getString("sidebar-embedding-connection-not-checked");
  }
  if (connection.status === "checking") {
    return getString("sidebar-checking-embedding");
  }
  if (connection.status === "ready") return "";

  if (connection.status === "missing-config") {
    if (connection.issue === "base-url-missing") {
      return getString("sidebar-embedding-base-url-missing");
    }
    if (connection.issue === "model-missing") {
      return getString("sidebar-embedding-model-missing");
    }
    return getString("sidebar-embedding-config-incomplete");
  }

  if (connection.status === "missing-model") {
    return getString("sidebar-embedding-model-not-installed", {
      args: { model: connection.model ?? REQUIRED_EMBEDDING_MODEL },
    });
  }

  if (connection.issue === "ollama-not-installed") {
    return getString("sidebar-ollama-not-installed");
  }
  if (connection.issue === "ollama-not-running") {
    return getString("sidebar-ollama-not-running");
  }
  if (connection.issue === "ollama-start-failed") {
    return getString("sidebar-ollama-start-failed");
  }
  if (connection.issue === "ollama-startup-timeout") {
    return getString("sidebar-ollama-startup-timeout");
  }

  if (connection.status === "unreachable") {
    return getString("sidebar-embedding-unreachable");
  }

  if (connection.issue === "invalid-response") {
    return getString("sidebar-embedding-invalid-response");
  }
  return getString("sidebar-embedding-check-failed");
}

/**
 * Formatiert den Provider-Verbindungsstatus für die Setup-Anzeige und blendet
 * für Ollama laufende Installations- oder Startvorgänge ein.
 *
 * @param provider - Provider, dessen Status dargestellt wird.
 * @param connection - Aktueller Verbindungsstatus des Providers.
 * @returns Lokalisierter Statustext oder ein leerer String bei Bereitschaft.
 */
function getProviderConnectionStatusText(
  provider: LLMProvider,
  connection: ProviderConnectionResult | undefined,
) {
  if (provider === "ollama" && ollamaStartRunning) {
    return getString("sidebar-starting-ollama");
  }
  if (provider === "ollama" && ollamaSetupLaunchRunning) {
    return getString("sidebar-launching-ollama-setup");
  }
  if (!connection) return getString("sidebar-connection-not-checked");
  if (connection.status === "checking") {
    return getString("sidebar-checking-provider");
  }
  if (connection.status === "ready") return "";

  if (connection.status === "missing-config") {
    if (connection.issue === "api-key-missing") {
      return getString("sidebar-cloud-api-key-missing");
    }
    if (connection.issue === "base-url-missing") {
      return getString("sidebar-base-url-missing");
    }
    if (connection.issue === "model-missing") {
      return getString("sidebar-model-missing");
    }
    return provider === "ollama"
      ? getString("sidebar-local-config-incomplete")
      : getString("sidebar-cloud-config-incomplete");
  }

  if (connection.status === "missing-model") {
    return provider === "ollama"
      ? getString("sidebar-local-model-not-installed", {
          args: { model: connection.model ?? "" },
        })
      : getString("sidebar-cloud-model-not-available", {
          args: { model: connection.model ?? "" },
        });
  }

  if (connection.status === "unreachable") {
    return provider === "ollama"
      ? getString("sidebar-local-unreachable")
      : getString("sidebar-cloud-unreachable");
  }

  if (connection.status === "error") {
    if (connection.issue === "unknown-error" && connection.message) {
      return connection.message;
    }
    return provider === "ollama"
      ? getString("sidebar-local-invalid-response")
      : getString("sidebar-cloud-invalid-response");
  }

  if (connection.message) return connection.message;

  return getString("sidebar-connection-check-failed");
}

/**
 * Creates c re at em es sa ge el em en t.
 *
 * @param host - Parameter used by createMessageElement.
 * @param message - Parameter used by createMessageElement.
 * @returns Result produced by createMessageElement.
 */
function createMessageElement(
  host: HTMLElement,
  message: AssistantChatMessage,
) {
  if (message.role === "assistant" && !message.content.trim()) {
    return null;
  }
  if (message.role === "system") {
    return null;
  }

  const doc = host.ownerDocument!;
  const row = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  const wrapper = doc.createElementNS(HTML_NS, "article") as HTMLElement;

  row.className = `zai-message-row zai-message-row-${message.role}`;
  wrapper.className = `zai-message zai-message-${message.role}`;

  const label = doc.createElementNS(HTML_NS, "strong") as HTMLElement;
  label.className = "zai-message-label";
  label.textContent =
    message.role === "user"
      ? "Du"
      : message.role === "assistant"
        ? "ZAIA"
        : "Fehler";

  const content = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  content.className = "zai-message-content";
  if (message.role === "assistant") {
    content.append(renderMarkdownContent(doc, message.content));
  } else {
    content.textContent = message.content;
  }

  wrapper.append(label, content, createMessageCopyActions(host, message));

  if (message.role === "assistant" && message.tokenUsage) {
    const { promptTokens, completionTokens, totalTokens } = message.tokenUsage;
    if (totalTokens != null) {
      const tokenInfo = doc.createElementNS(HTML_NS, "div") as HTMLElement;
      tokenInfo.className = "zai-message-tokens";
      tokenInfo.style.fontSize = "0.75em";
      tokenInfo.style.color = "var(--fill-quaternary)";
      tokenInfo.style.marginTop = "4px";
      tokenInfo.style.textAlign = "right";

      let text = `Tokens: ${totalTokens} Total`;
      if (promptTokens != null && completionTokens != null) {
        text = `Tokens: ${promptTokens} Prompt / ${completionTokens} Antwort (${totalTokens} Total)`;
      }
      tokenInfo.textContent = text;
      wrapper.append(tokenInfo);
    }
  }

  row.append(wrapper);
  return row;
}

/**
 * Creates c re at em es sa ge co py ac ti on s.
 *
 * @param host - Parameter used by createMessageCopyActions.
 * @param message - Parameter used by createMessageCopyActions.
 * @returns Result produced by createMessageCopyActions.
 */
function createMessageCopyActions(
  host: HTMLElement,
  message: AssistantChatMessage,
) {
  const doc = host.ownerDocument!;
  const actions = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  const copyButton = doc.createElementNS(
    HTML_NS,
    "button",
  ) as HTMLButtonElement;

  actions.className = "zai-message-actions";
  copyButton.className = "zai-chat-action-button zai-message-copy-button";
  copyButton.type = "button";
  copyButton.setAttribute("aria-label", "Nachricht kopieren");
  copyButton.setAttribute("title", "Nachricht kopieren");

  copyButton.append(createCopyIcon(doc));
  copyButton.addEventListener("click", (event) => {
    event.stopPropagation();
    void copyMessageToClipboard(host, message.content, copyButton);
  });

  actions.append(copyButton);
  return actions;
}

/**
 * Copies c op ym es sa ge to cl ip bo ar d.
 *
 * @param host - Parameter used by copyMessageToClipboard.
 * @param text - Parameter used by copyMessageToClipboard.
 * @param button - Parameter used by copyMessageToClipboard.
 * @returns Result produced by copyMessageToClipboard.
 */
async function copyMessageToClipboard(
  host: HTMLElement,
  text: string,
  button: HTMLButtonElement,
) {
  try {
    await writeTextToClipboard(host, text);
    setCopyButtonState(host, button, "Nachricht kopiert", true);
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    setCopyButtonState(
      host,
      button,
      "Nachricht konnte nicht kopiert werden",
      false,
    );
  }
}

/**
 * Handles w ri te te xt to cl ip bo ar d.
 *
 * @param host - Parameter used by writeTextToClipboard.
 * @param text - Parameter used by writeTextToClipboard.
 * @returns Result produced by writeTextToClipboard.
 */
async function writeTextToClipboard(host: HTMLElement, text: string) {
  const win = host.ownerDocument?.defaultView;
  const clipboard = win?.navigator?.clipboard;
  let clipboardError: unknown = null;

  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  if (copyTextWithClipboardHelper(text)) return;
  if (copyTextWithSelectionFallback(host, text)) return;

  throw clipboardError ?? new Error("Clipboard API nicht verfügbar.");
}

/**
 * Copies c op yt ex tw it hc li pb oa rd he lp er.
 *
 * @param text - Parameter used by copyTextWithClipboardHelper.
 * @returns Result produced by copyTextWithClipboardHelper.
 */
function copyTextWithClipboardHelper(text: string) {
  try {
    Components.classes["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Components.interfaces.nsIClipboardHelper)
      .copyString(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies c op yt ex tw it hs el ec ti on fa ll ba ck.
 *
 * @param host - Parameter used by copyTextWithSelectionFallback.
 * @param text - Parameter used by copyTextWithSelectionFallback.
 * @returns Result produced by copyTextWithSelectionFallback.
 */
function copyTextWithSelectionFallback(host: HTMLElement, text: string) {
  const doc = host.ownerDocument;
  const textarea = doc.createElementNS(
    HTML_NS,
    "textarea",
  ) as HTMLTextAreaElement;

  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  textarea.style.position = "fixed";
  textarea.style.top = "0";

  host.append(textarea);
  textarea.focus();
  textarea.select();

  try {
    return typeof doc.execCommand === "function" && doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/**
 * Sets s et co py bu tt on st at e.
 *
 * @param host - Parameter used by setCopyButtonState.
 * @param button - Parameter used by setCopyButtonState.
 * @param ariaLabel - Parameter used by setCopyButtonState.
 * @param copied - Parameter used by setCopyButtonState.
 * @returns Result produced by setCopyButtonState.
 */
function setCopyButtonState(
  host: HTMLElement,
  button: HTMLButtonElement,
  ariaLabel: string,
  copied: boolean,
) {
  const win = host.ownerDocument.defaultView;
  const actions = button.closest(".zai-message-actions");

  actions?.classList.add("zai-message-actions-active");
  button.classList.add("zai-message-copy-button-active");
  button.classList.toggle("zai-message-copy-button-copied", copied);
  button.setAttribute("aria-label", ariaLabel);
  button.setAttribute("title", ariaLabel);
  if (copied) {
    button.replaceChildren(createCheckIcon(button.ownerDocument));
  }

  win?.setTimeout(() => {
    if (!button.isConnected) return;

    button.classList.remove("zai-message-copy-button-active");
    button.classList.remove("zai-message-copy-button-copied");
    actions?.classList.remove("zai-message-actions-active");
    button.setAttribute("aria-label", "Nachricht kopieren");
    button.setAttribute("title", "Nachricht kopieren");
    button.replaceChildren(createCopyIcon(button.ownerDocument));
  }, 1200);
}

/**
 * Creates c re at ec op yi co n.
 *
 * @param doc - Parameter used by createCopyIcon.
 * @returns Result produced by createCopyIcon.
 */
function createCopyIcon(doc: Document) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  const rectBack = doc.createElementNS(SVG_NS, "rect");
  const rectFront = doc.createElementNS(SVG_NS, "rect");

  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  rectBack.setAttribute("x", "8");
  rectBack.setAttribute("y", "7");
  rectBack.setAttribute("width", "10");
  rectBack.setAttribute("height", "12");
  rectBack.setAttribute("rx", "2");
  rectFront.setAttribute("x", "5");
  rectFront.setAttribute("y", "4");
  rectFront.setAttribute("width", "10");
  rectFront.setAttribute("height", "12");
  rectFront.setAttribute("rx", "2");
  svg.append(rectBack, rectFront);

  return svg;
}

/**
 * Creates c re at ec he ck ic on.
 *
 * @param doc - Parameter used by createCheckIcon.
 * @returns Result produced by createCheckIcon.
 */
function createCheckIcon(doc: Document) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  const path = doc.createElementNS(SVG_NS, "path");

  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", "M5 12.5l4.3 4.2L19 7.3");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);

  return svg;
}

/**
 * Creates c re at es en da rr ow ic on.
 *
 * @param doc - Parameter used by createSendArrowIcon.
 * @returns Result produced by createSendArrowIcon.
 */
function createSendArrowIcon(doc: Document) {
  const svg = createIconSvg(doc, "20");
  const line = doc.createElementNS(SVG_NS, "path");
  const arrow = doc.createElementNS(SVG_NS, "path");

  line.setAttribute("d", "M12 19V5");
  arrow.setAttribute("d", "m5 12 7-7 7 7");
  svg.append(line, arrow);

  return svg;
}

/**
 * Creates c re at es to ps qu ar ei co n.
 *
 * @param doc - Parameter used by createStopSquareIcon.
 * @returns Result produced by createStopSquareIcon.
 */
function createStopSquareIcon(doc: Document) {
  const svg = createIconSvg(doc, "22");
  const square = doc.createElementNS(SVG_NS, "rect");

  square.setAttribute("x", "6");
  square.setAttribute("y", "6");
  square.setAttribute("width", "12");
  square.setAttribute("height", "12");
  square.setAttribute("rx", "1.5");
  svg.append(square);

  return svg;
}

/**
 * Creates c re at ei co ns vg.
 *
 * @param doc - Parameter used by createIconSvg.
 * @param size - Parameter used by createIconSvg.
 * @returns Result produced by createIconSvg.
 */
function createIconSvg(doc: Document, size: string) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  return svg;
}

/**
 * Creates c re at ea ct iv it ye le me nt.
 *
 * @param host - Parameter used by createActivityElement.
 * @param text - Parameter used by createActivityElement.
 * @returns Result produced by createActivityElement.
 */
function createActivityElement(host: HTMLElement, text: string) {
  const element = host.ownerDocument!.createElementNS(
    HTML_NS,
    "div",
  ) as HTMLElement;
  element.className = "zai-activity-line";
  element.textContent = text;
  return element;
}

/**
 * Renders r en de rc ha tl is t.
 *
 * @param host - Parameter used by renderChatList.
 * @param chatList - Parameter used by renderChatList.
 * @returns Result produced by renderChatList.
 */
function renderChatList(host: HTMLElement, chatList: HTMLElement) {
  const doc = host.ownerDocument!;
  if (!chatSummariesLoaded) {
    chatList.replaceChildren();
    return;
  }

  const visibleChats = showAllChats ? chatSummaries : chatSummaries.slice(0, 3);
  const entries = visibleChats.map((chat) => {
    const entry = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
    const title = chat.title || "Unbenannter Chat";
    const chatTitle = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    const chatTime = doc.createElementNS(HTML_NS, "span") as HTMLElement;

    entry.type = "button";
    entry.className = "zai-chat-entry";
    entry.dataset.chatId = chat.id;
    entry.classList.toggle("zai-chat-entry-active", chat.id === activeChatID);

    chatTitle.className = "zai-chat-entry-title";
    chatTitle.textContent = title;
    chatTime.className = "zai-chat-entry-time";
    chatTime.textContent = formatRelativeTime(chat.updatedAt);
    entry.append(chatTitle, chatTime);

    return entry;
  });

  chatList.replaceChildren(...entries);
}

/**
 * Gets g et ac ti ve ch at ti tl e.
 * @returns Result produced by getActiveChatTitle.
 */
function getActiveChatTitle() {
  const chat = getActiveChatSummary();
  return chat?.title || "Unbenannter Chat";
}

/**
 * Gets g et ac ti ve ch at su mm ar y.
 * @returns Result produced by getActiveChatSummary.
 */
function getActiveChatSummary() {
  if (!activeChatID) return null;

  return chatSummaries.find((entry) => entry.id === activeChatID) ?? null;
}

/**
 * Confirms c on fi rm de le te ac ti ve ch at.
 *
 * @param host - Parameter used by confirmDeleteActiveChat.
 * @returns Result produced by confirmDeleteActiveChat.
 */
function confirmDeleteActiveChat(host: HTMLElement) {
  const win = host.ownerDocument?.defaultView;
  if (typeof win?.confirm !== "function") return true;

  return win.confirm(`Chat "${getActiveChatTitle()}" wirklich löschen?`);
}

/**
 * Formats f or ma tr el at iv et im e.
 *
 * @param value - Parameter used by formatRelativeTime.
 * @returns Result produced by formatRelativeTime.
 */
function formatRelativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";

  const elapsedMinutes = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 60_000),
  );
  if (elapsedMinutes < 1) return "jetzt";
  if (elapsedMinutes < 60) return `${elapsedMinutes} min`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} h`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays} t`;

  return `${Math.floor(elapsedDays / 7)} w`;
}

/**
 * Überträgt den aktiven Provider und dessen Modellzustand auf alle geöffneten
 * Sidebars, sodass mehrere Zotero-Fenster denselben Toggle-Zustand anzeigen.
 */
function syncAllModelPickers() {
  for (const host of [...hosts]) {
    syncModelPicker(host);
  }
}

/**
 * Synchronizes s yn ca ll me ta da ta fi el dc on tr ol s.
 * @returns Result produced by syncAllMetadataFieldControls.
 */
function syncAllMetadataFieldControls() {
  for (const host of [...hosts]) {
    syncMetadataFieldControls(host);
  }
}

/**
 * Synchronizes s yn ca ll pa pe rc on te xt co nt ro ls.
 * @returns Result produced by syncAllPaperContextControls.
 */
function syncAllPaperContextControls() {
  syncPaperContextBadges();
  for (const host of [...hosts]) {
    syncPaperContextControls(host);
  }
}

/**
 * Synchronizes s yn cp ap er co nt ex tb ad ge s.
 * @returns Result produced by syncPaperContextBadges.
 */
function syncPaperContextBadges() {
  const count = getVisiblePaperContextCount();
  const documents = new Set<Document>();
  for (const host of [...hosts]) {
    if (host.ownerDocument) documents.add(host.ownerDocument);
  }

  try {
    for (const win of Zotero.getMainWindows()) {
      if (win.document) documents.add(win.document);
    }
  } catch {}

  for (const doc of documents) {
    doc
      .querySelectorAll<HTMLElement>(".zai-context-count-badge")
      .forEach((badge) => {
        badge.textContent = String(count);
        badge.toggleAttribute("hidden", count === 0);
      });
  }
}

/**
 * Ensures e ns ur ep ap er co nt ex ts el ec ti on po ll in g.
 *
 * @param win - Parameter used by ensurePaperContextSelectionPolling.
 * @returns Result produced by ensurePaperContextSelectionPolling.
 */
function ensurePaperContextSelectionPolling(win: Window | null) {
  if (!win) return;
  if (paperContextSelectionPollID !== null) return;

  lastAutomaticPaperContextSignature = getAutomaticPaperContextSignature();
  paperContextSelectionPollID = win.setInterval(() => {
    const signature = getAutomaticPaperContextSignature();
    if (signature !== lastAutomaticPaperContextSignature) {
      lastAutomaticPaperContextSignature = signature;
    }
    syncAllPaperContextControls();
  }, 500);
}

/**
 * Ensures e ns ur ep ap er co nt ex ts el ec ti on ev en th an dl er s.
 *
 * @param win - Parameter used by ensurePaperContextSelectionEventHandlers.
 * @returns Result produced by ensurePaperContextSelectionEventHandlers.
 */
function ensurePaperContextSelectionEventHandlers(win: Window | null) {
  if (!win || paperContextSelectionWindows.has(win)) return;

  paperContextSelectionWindows.add(win);
  const scheduleRefresh = () => {
    win.setTimeout(() => {
      refreshPaperContextControls();
    }, 50);
  };

  win.document.addEventListener("mouseup", scheduleRefresh, true);
  win.document.addEventListener("keyup", scheduleRefresh, true);
  win.document.addEventListener("select", scheduleRefresh, true);
}

/**
 * Synchronisiert Modellbereich und Provider-Toggle einer Sidebar mit dem
 * aktuell aktiven Provider.
 *
 * @param host - Zu aktualisierende Sidebar.
 */
function syncModelPicker(host: HTMLElement) {
  const provider = getActiveProvider();
  const picker = host.querySelector<HTMLElement>(".zai-model-picker");
  if (picker) picker.dataset.provider = provider;
  syncModelPickerDisclosure(host, provider);
  syncProviderToggleButtons(host, provider);
  syncModelDropdown(
    host.querySelector<HTMLElement>(".zai-model-select-wrap"),
    provider,
  );
}

/**
 * Synchronizes s yn cm et ad at af ie ld co nt ro ls.
 *
 * @param host - Parameter used by syncMetadataFieldControls.
 * @returns Result produced by syncMetadataFieldControls.
 */
function syncMetadataFieldControls(host: HTMLElement) {
  const selection = normalizeMetadataFieldSelection(
    addon.data.settings.metadataFieldSelection,
  );
  const selectedFields = getMetadataFieldsForSelection(selection);

  host
    .querySelectorAll<HTMLInputElement>(".zai-metadata-checkbox[value]")
    .forEach((checkbox) => {
      checkbox.checked = selectedFields.includes(
        checkbox.value as MetadataFieldSelection,
      );
    });

  const label = getMetadataFieldSelectionLabel(selection);
  const button = host.querySelector<HTMLButtonElement>(".zai-metadata-button");
  const title = `Metadaten-Kontext: ${label}`;
  button?.setAttribute("aria-label", title);
  button?.setAttribute("title", title);
}

/**
 * Saves s av em et ad at af ie ld se le ct io n.
 *
 * @param checkboxes - Parameter used by saveMetadataFieldSelection.
 * @param changedCheckbox - Parameter used by saveMetadataFieldSelection.
 * @returns Result produced by saveMetadataFieldSelection.
 */
function saveMetadataFieldSelection(
  checkboxes: HTMLInputElement[],
  changedCheckbox: HTMLInputElement,
) {
  let selectedValue = checkboxes
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value)
    .join(",");

  if (!selectedValue) {
    changedCheckbox.checked = true;
    selectedValue = changedCheckbox.value || "title";
  }

  const selection = normalizeMetadataFieldSelection(selectedValue);
  addon.data.settings.metadataFieldSelection = selection;
  savePluginPreference("metadataFieldSelection", selection);
  syncAllMetadataFieldControls();
}

/**
 * Synchronizes s yn cp ap er co nt ex tc on tr ol s.
 *
 * @param host - Parameter used by syncPaperContextControls.
 * @returns Result produced by syncPaperContextControls.
 */
function syncPaperContextControls(host: HTMLElement) {
  const automaticEntries = getAutomaticPaperContextEntries();
  const manualEntries = getManualPaperContextEntries(automaticEntries);
  const count = automaticEntries.length + manualEntries.length;
  const countBadge = host.querySelector<HTMLElement>(
    ".zai-context-count-badge",
  );
  const list = host.querySelector<HTMLElement>(".zai-paper-context-list");
  const manualList = host.querySelector<HTMLElement>(
    ".zai-paper-manual-context-list",
  );
  const search = host.querySelector<HTMLInputElement>(
    ".zai-paper-library-search",
  );
  const results = host.querySelector<HTMLElement>(".zai-paper-library-results");

  syncPaperContextIndexWarning(host, [...automaticEntries, ...manualEntries]);

  if (countBadge) {
    countBadge.textContent = String(count);
    countBadge.toggleAttribute("hidden", count === 0);
  }

  if (search && search.value !== paperLibrarySearchValue) {
    search.value = paperLibrarySearchValue;
  }

  if (results) renderPaperLibraryResults(results);

  if (manualList) {
    renderPaperContextList(manualList, manualEntries, "");
  }

  if (list) {
    renderPaperContextList(list, automaticEntries, "Keine Paper ausgewählt");
  }
}

/**
 * Synchronizes s yn cp ap er co nt ex ti nd ex wa rn in g.
 *
 * @param host - Parameter used by syncPaperContextIndexWarning.
 * @param entries - Parameter used by syncPaperContextIndexWarning.
 * @returns Result produced by syncPaperContextIndexWarning.
 */
function syncPaperContextIndexWarning(
  host: HTMLElement,
  entries: PaperContextEntry[],
) {
  const banner = host.querySelector<HTMLElement>(
    ".zai-paper-context-index-warning",
  );
  const text = banner?.querySelector<HTMLElement>(
    ".zai-paper-context-index-warning-text",
  );
  if (!banner || !text) return;

  const unindexedCount = getUnindexedPaperContextCount(
    entries,
    vectorStore.getIndexedItemIds(),
  );
  banner.toggleAttribute("hidden", unindexedCount === 0);
  text.textContent = unindexedCount
    ? getUnindexedPaperContextWarning(unindexedCount)
    : "";
}

/**
 * Renders r en de rp ap er co nt ex tl is t.
 *
 * @param list - Parameter used by renderPaperContextList.
 * @param entries - Parameter used by renderPaperContextList.
 * @param emptyText - Parameter used by renderPaperContextList.
 * @returns Result produced by renderPaperContextList.
 */
function renderPaperContextList(
  list: HTMLElement,
  entries: PaperContextEntry[],
  emptyText: string,
) {
  const doc = list.ownerDocument;
  if (!entries.length) {
    if (!emptyText) {
      list.replaceChildren();
      return;
    }

    list.replaceChildren(
      createControllerHtmlElement(
        doc,
        "div",
        "zai-paper-context-empty",
        emptyText,
      ),
    );
    return;
  }

  list.replaceChildren(
    ...entries.map((entry) => createPaperContextRow(doc, entry)),
  );
}

/**
 * Renders r en de rp ap er li br ar yr es ul ts.
 *
 * @param container - Parameter used by renderPaperLibraryResults.
 * @returns Result produced by renderPaperLibraryResults.
 */
function renderPaperLibraryResults(container: HTMLElement) {
  const doc = container.ownerDocument;
  const hasSearch = Boolean(paperLibrarySearchValue.trim());
  if (!hasSearch) {
    container.replaceChildren();
    return;
  }

  if (paperLibraryLoadState === "loading") {
    container.replaceChildren(
      createControllerHtmlElement(
        doc,
        "div",
        "zai-paper-library-state",
        "Bibliothek wird geladen...",
      ),
    );
    return;
  }

  if (paperLibraryLoadState === "error") {
    container.replaceChildren(
      createControllerHtmlElement(
        doc,
        "div",
        "zai-paper-library-state zai-paper-library-state-error",
        paperLibraryLoadError || "Bibliothek konnte nicht geladen werden",
      ),
    );
    return;
  }

  const options = getFilteredPaperLibraryOptions();
  if (!options.length) {
    container.replaceChildren(
      createControllerHtmlElement(
        doc,
        "div",
        "zai-paper-library-state",
        "Keine passenden Paper gefunden",
      ),
    );
    return;
  }

  container.replaceChildren(
    ...options.map((option) => createPaperLibraryResultRow(doc, option)),
  );
}

/**
 * Creates c re at ep ap er co nt ex tr ow.
 *
 * @param doc - Parameter used by createPaperContextRow.
 * @param entry - Parameter used by createPaperContextRow.
 * @returns Result produced by createPaperContextRow.
 */
function createPaperContextRow(doc: Document, entry: PaperContextEntry) {
  const row = createControllerHtmlElement(
    doc,
    "div",
    `zai-paper-context-row zai-paper-context-row-${entry.source}`,
  );
  const text = createControllerHtmlElement(
    doc,
    "div",
    "zai-paper-context-text",
  );
  const title = createControllerHtmlElement(
    doc,
    "div",
    "zai-paper-context-item-title",
    entry.title || "Ohne Titel",
  );
  const meta = createControllerHtmlElement(
    doc,
    "div",
    "zai-paper-context-item-meta",
    getPaperContextMeta(entry),
  );
  text.append(title, meta);
  row.append(text);

  const removeButton = createControllerHtmlElement(
    doc,
    "button",
    "zai-paper-context-remove-button",
    "-",
  ) as HTMLButtonElement;
  removeButton.type = "button";
  removeButton.dataset.contextKey = getPaperContextKey(entry);
  removeButton.setAttribute("aria-label", `${entry.title} entfernen`);
  removeButton.title =
    entry.source === "automatic"
      ? "Paper aus Zotero-Auswahl entfernen"
      : "Paper entfernen";
  row.append(removeButton);

  return row;
}

/**
 * Creates c re at ep ap er li br ar yr es ul tr ow.
 *
 * @param doc - Parameter used by createPaperLibraryResultRow.
 * @param option - Parameter used by createPaperLibraryResultRow.
 * @returns Result produced by createPaperLibraryResultRow.
 */
function createPaperLibraryResultRow(
  doc: Document,
  option: PaperLibraryOption,
) {
  const row = createControllerHtmlElement(
    doc,
    "div",
    "zai-paper-library-result-row",
  );
  const text = createControllerHtmlElement(
    doc,
    "div",
    "zai-paper-library-result-text",
  );
  const title = createControllerHtmlElement(
    doc,
    "div",
    "zai-paper-library-result-title",
    option.title || "Ohne Titel",
  );
  const meta = createControllerHtmlElement(
    doc,
    "div",
    "zai-paper-library-result-meta",
    [option.firstCreator, option.year, option.libraryName]
      .filter(Boolean)
      .join(" · "),
  );
  const addButton = createControllerHtmlElement(
    doc,
    "button",
    "zai-paper-library-result-add-button",
    "+",
  ) as HTMLButtonElement;
  addButton.type = "button";
  addButton.dataset.contextKey = getPaperContextKey(option);
  addButton.setAttribute("aria-label", `${option.title} hinzufügen`);
  addButton.title = "Paper hinzufügen";

  text.append(title, meta);
  row.append(text, addButton);
  return row;
}

/**
 * Ensures e ns ur ep ap er li br ar yo pt io ns lo ad ed.
 *
 * @param force - Parameter used by ensurePaperLibraryOptionsLoaded.
 * @returns Result produced by ensurePaperLibraryOptionsLoaded.
 */
async function ensurePaperLibraryOptionsLoaded(force = false) {
  if (
    !force &&
    (paperLibraryLoadState === "loaded" || paperLibraryLoadState === "loading")
  ) {
    return;
  }

  paperLibraryLoadState = "loading";
  paperLibraryLoadError = "";
  syncAllPaperContextControls();

  try {
    const options: PaperLibraryOption[] = [];
    for (const scope of LibraryScopeManager.listLibraryScopes()) {
      const candidates = await LibraryScopeManager.listRagItemCandidates({
        libraryID: scope.libraryID,
        includeWithoutPdf: true,
      });
      options.push(...candidates.map(createPaperLibraryOption));
    }

    paperLibraryOptions = options.sort((first, second) =>
      first.title.localeCompare(second.title),
    );
    paperLibraryLoadState = "loaded";
  } catch (error) {
    paperLibraryOptions = [];
    paperLibraryLoadState = "error";
    paperLibraryLoadError =
      error instanceof Error
        ? error.message
        : "Bibliothek konnte nicht geladen werden";
  }

  syncAllPaperContextControls();
}

/**
 * Adds a dd be st ma tc hi ng pa pe rt om an ua lc on te xt.
 * @returns Result produced by addBestMatchingPaperToManualContext.
 */
function addBestMatchingPaperToManualContext() {
  const option = getBestMatchingPaperLibraryOption();
  if (!option) return;

  addPaperLibraryOptionToManualContext(option);
}

/**
 * Adds a dd pa pe rl ib ra ry op ti on to ma nu al co nt ex t.
 *
 * @param option - Parameter used by addPaperLibraryOptionToManualContext.
 * @returns Result produced by addPaperLibraryOptionToManualContext.
 */
function addPaperLibraryOptionToManualContext(option: PaperLibraryOption) {
  manualPaperContextEntries.set(getPaperContextKey(option), {
    libraryID: option.libraryID,
    itemKey: option.itemKey,
    itemID: option.itemID,
    title: option.title,
    firstCreator: option.firstCreator,
    year: option.year,
    source: "manual",
  });
  paperLibrarySearchValue = "";
  syncAllPaperContextControls();
}

/**
 * Removes r em ov ea ut om at ic pa pe rc on te xt en tr y.
 *
 * @param entry - Parameter used by removeAutomaticPaperContextEntry.
 * @returns Result produced by removeAutomaticPaperContextEntry.
 */
async function removeAutomaticPaperContextEntry(entry: PaperContextEntry) {
  const key = getPaperContextKey(entry);
  manualPaperContextEntries.delete(key);

  const removed = await ItemManager.removeItemFromSelection(entry);
  if (!removed) {
    Zotero.debug(
      `ZAIA: Automatischer Paper-Kontext konnte nicht entfernt werden: ${key}`,
    );
  }

  syncAllPaperContextControls();
}

/**
 * Gets g et be st ma tc hi ng pa pe rl ib ra ry op ti on.
 * @returns Result produced by getBestMatchingPaperLibraryOption.
 */
function getBestMatchingPaperLibraryOption() {
  return getFilteredPaperLibraryOptions()[0] ?? null;
}

/**
 * Creates c re at ep ap er li br ar yo pt io n.
 *
 * @param candidate - Parameter used by createPaperLibraryOption.
 * @returns Result produced by createPaperLibraryOption.
 */
function createPaperLibraryOption(
  candidate: RagItemCandidate,
): PaperLibraryOption {
  const option: PaperLibraryOption = {
    libraryID: candidate.library.libraryID,
    itemKey: candidate.itemKey,
    itemID: candidate.itemID,
    title: candidate.title,
    firstCreator: candidate.creators,
    year: candidate.year || candidate.publicationDate,
    source: "manual",
    libraryName: candidate.library.name,
    searchText: "",
  };
  option.searchText = [
    option.title,
    option.firstCreator,
    option.year,
    option.libraryName,
  ]
    .join(" ")
    .toLowerCase();
  return option;
}

/**
 * Gets g et fi lt er ed pa pe rl ib ra ry op ti on s.
 * @returns Result produced by getFilteredPaperLibraryOptions.
 */
function getFilteredPaperLibraryOptions() {
  const attachedKeys = new Set(
    getVisiblePaperContextEntries().map(getPaperContextKey),
  );
  const terms = paperLibrarySearchValue
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return paperLibraryOptions
    .filter((option) => !attachedKeys.has(getPaperContextKey(option)))
    .filter((option) => terms.every((term) => option.searchText.includes(term)))
    .slice(0, 8);
}

/**
 * Gets g et vi si bl ep ap er co nt ex te nt ri es.
 * @returns Result produced by getVisiblePaperContextEntries.
 */
function getVisiblePaperContextEntries() {
  const entries = new Map<string, PaperContextEntry>();

  for (const entry of getAutomaticPaperContextEntries()) {
    entries.set(getPaperContextKey(entry), entry);
  }

  for (const entry of manualPaperContextEntries.values()) {
    const key = getPaperContextKey(entry);
    if (!entries.has(key)) entries.set(key, entry);
  }

  return [...entries.values()];
}

/**
 * Gets g et vi si bl ep ap er co nt ex tc ou nt.
 * @returns Result produced by getVisiblePaperContextCount.
 */
function getVisiblePaperContextCount() {
  const automaticEntries = getAutomaticPaperContextEntries();
  return (
    automaticEntries.length +
    getManualPaperContextEntries(automaticEntries).length
  );
}

/**
 * Gets g et ma nu al pa pe rc on te xt en tr ie s.
 *
 * @param automaticEntries - Parameter used by getManualPaperContextEntries.
 * @returns Result produced by getManualPaperContextEntries.
 */
function getManualPaperContextEntries(automaticEntries: PaperContextEntry[]) {
  const automaticKeys = new Set(automaticEntries.map(getPaperContextKey));
  return [...manualPaperContextEntries.values()].filter(
    (entry) => !automaticKeys.has(getPaperContextKey(entry)),
  );
}

/**
 * Gets g et fo rc ed pa pe rc on te xt re fe re nc es.
 * @returns Result produced by getForcedPaperContextReferences.
 */
function getForcedPaperContextReferences() {
  const references = new Map<string, PaperReference>();

  for (const item of getSelectedContextItems()) {
    const entry = createPaperContextEntry(item, "automatic");
    references.set(getPaperContextKey(entry), {
      libraryID: entry.libraryID,
      itemKey: entry.itemKey,
      itemID: entry.itemID,
    });
  }

  for (const entry of manualPaperContextEntries.values()) {
    references.set(getPaperContextKey(entry), {
      libraryID: entry.libraryID,
      itemKey: entry.itemKey,
      itemID: entry.itemID,
    });
  }

  return [...references.values()];
}

/**
 * Gets g et au to ma ti cp ap er co nt ex te nt ri es.
 * @returns Result produced by getAutomaticPaperContextEntries.
 */
function getAutomaticPaperContextEntries() {
  return getSelectedContextItems().map((item) =>
    createPaperContextEntry(item, "automatic"),
  );
}

/**
 * Gets g et se le ct ed co nt ex ti te ms.
 * @returns Result produced by getSelectedContextItems.
 */
function getSelectedContextItems() {
  try {
    return ItemManager.filterItems();
  } catch (error) {
    Zotero.debug(
      `ZAIA: Paper-Kontext-Auswahl konnte nicht gelesen werden: ${error}`,
    );
    return [];
  }
}

/**
 * Gets g et au to ma ti cp ap er co nt ex ts ig na tu re.
 * @returns Result produced by getAutomaticPaperContextSignature.
 */
function getAutomaticPaperContextSignature() {
  return getAutomaticPaperContextEntries().map(getPaperContextKey).join("|");
}

/**
 * Creates c re at ep ap er co nt ex te nt ry.
 *
 * @param item - Parameter used by createPaperContextEntry.
 * @param source - Parameter used by createPaperContextEntry.
 * @returns Result produced by createPaperContextEntry.
 */
function createPaperContextEntry(
  item: Zotero.Item,
  source: PaperContextEntry["source"],
): PaperContextEntry {
  const data = ItemManager.extractItemData(item);
  return {
    libraryID: item.libraryID,
    itemKey: item.key,
    itemID: item.id,
    title: data.title,
    firstCreator: data.firstCreator,
    year: data.year,
    source,
  };
}

/**
 * Gets g et pa pe rc on te xt me ta.
 *
 * @param entry - Parameter used by getPaperContextMeta.
 * @returns Result produced by getPaperContextMeta.
 */
function getPaperContextMeta(entry: PaperContextEntry) {
  return [entry.firstCreator, entry.year].filter(Boolean).join(" · ");
}

/**
 * Gets g et pa pe rc on te xt ke y.
 *
 * @param reference - Parameter used by getPaperContextKey.
 * @returns Result produced by getPaperContextKey.
 */
function getPaperContextKey(reference: PaperReference) {
  return `${reference.libraryID}:${reference.itemKey}`;
}

/**
 * Creates c re at ec on tr ol le rh tm le le me nt.
 *
 * @param doc - Parameter used by createControllerHtmlElement.
 * @param tagName - Parameter used by createControllerHtmlElement.
 * @param className - Parameter used by createControllerHtmlElement.
 * @param text - Parameter used by createControllerHtmlElement.
 * @returns Result produced by createControllerHtmlElement.
 */
function createControllerHtmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tagName: K,
  className?: string,
  text?: string,
) {
  const element = doc.createElementNS(HTML_NS, tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

/**
 * Toggles t og gl em et ad at ap op ov er.
 *
 * @param control - Parameter used by toggleMetadataPopover.
 * @returns Result produced by toggleMetadataPopover.
 */
function toggleMetadataPopover(control: HTMLElement) {
  const open = !control.classList.contains("zai-metadata-control-open");
  if (open) {
    openMetadataPopover(control);
  } else {
    closeMetadataPopover(control);
  }
}

/**
 * Opens o pe nm et ad at ap op ov er.
 *
 * @param control - Parameter used by openMetadataPopover.
 * @returns Result produced by openMetadataPopover.
 */
function openMetadataPopover(control: HTMLElement) {
  closeOtherMetadataPopovers(control);
  const button = control.querySelector<HTMLButtonElement>(
    ".zai-metadata-button",
  );
  const popover = control.querySelector<HTMLElement>(".zai-metadata-popover");

  control.classList.add("zai-metadata-control-open");
  button?.setAttribute("aria-expanded", "true");
  popover?.removeAttribute("hidden");
}

/**
 * Closes c lo se me ta da ta po po ve r.
 *
 * @param control - Parameter used by closeMetadataPopover.
 * @returns Result produced by closeMetadataPopover.
 */
function closeMetadataPopover(control: HTMLElement) {
  const button = control.querySelector<HTMLButtonElement>(
    ".zai-metadata-button",
  );
  const popover = control.querySelector<HTMLElement>(".zai-metadata-popover");

  control.classList.remove("zai-metadata-control-open");
  button?.setAttribute("aria-expanded", "false");
  popover?.setAttribute("hidden", "");
}

/**
 * Closes c lo se ot he rm et ad at ap op ov er s.
 *
 * @param control - Parameter used by closeOtherMetadataPopovers.
 * @returns Result produced by closeOtherMetadataPopovers.
 */
function closeOtherMetadataPopovers(control: HTMLElement) {
  control.ownerDocument
    .querySelectorAll<HTMLElement>(".zai-metadata-control-open")
    .forEach((openControl) => {
      if (openControl !== control) {
        closeMetadataPopover(openControl);
      }
    });
}

/**
 * Ensures e ns ur em et ad at ap op ov er ou ts id eh an dl er.
 *
 * @param doc - Parameter used by ensureMetadataPopoverOutsideHandler.
 * @returns Result produced by ensureMetadataPopoverOutsideHandler.
 */
function ensureMetadataPopoverOutsideHandler(doc: Document) {
  if (metadataPopoverDocuments.has(doc)) return;

  metadataPopoverDocuments.add(doc);
  doc.addEventListener("click", (event) => {
    const target = event.target as Node | null;
    doc
      .querySelectorAll<HTMLElement>(".zai-metadata-control-open")
      .forEach((control) => {
        if (!target || !control.contains(target)) {
          closeMetadataPopover(control);
        }
      });
  });
}

/**
 * Synchronizes s yn cm od el pi ck er di sc lo su re.
 *
 * @param host - Parameter used by syncModelPickerDisclosure.
 * @param provider - Parameter used by syncModelPickerDisclosure.
 * @returns Result produced by syncModelPickerDisclosure.
 */
function syncModelPickerDisclosure(host: HTMLElement, provider: LLMProvider) {
  const picker = host.querySelector<HTMLElement>(".zai-model-picker");
  const toggle = host.querySelector<HTMLButtonElement>(
    ".zai-model-picker-toggle",
  );
  const content = host.querySelector<HTMLElement>(".zai-model-picker-content");
  const summary = host.querySelector<HTMLElement>(".zai-model-picker-summary");

  picker?.classList.toggle("zai-model-picker-collapsed", !modelPickerExpanded);
  toggle?.setAttribute("aria-expanded", String(modelPickerExpanded));
  content?.toggleAttribute("hidden", !modelPickerExpanded);

  if (summary) {
    if (modelPickerExpanded) {
      summary.textContent = "";
      summary.title = "";
      summary.hidden = true;
      return;
    }

    const model = getActiveModel(provider).trim() || "Modell auswählen";
    summary.textContent = `${getProviderLabel(provider)} · ${model}`;
    summary.title = summary.textContent;
    summary.hidden = false;
  }
}

/**
 * Sets s et mo de lp ic ke re xp an de d.
 *
 * @param expanded - Parameter used by setModelPickerExpanded.
 * @returns Result produced by setModelPickerExpanded.
 */
function setModelPickerExpanded(expanded: boolean) {
  modelPickerExpanded = expanded;
  if (!expanded) {
    for (const host of [...hosts]) {
      host
        .querySelectorAll<HTMLElement>(".zai-model-select-wrap-open")
        .forEach(closeModelDropdown);
    }
  }
  syncAllModelPickers();
}

/**
 * Aktualisiert in einer bereits gebundenen Sidebar die visuelle und
 * barrierefreie Auswahl des Provider-Toggles.
 *
 * @param host - Sidebar mit den Provider-Buttons.
 * @param provider - Provider, der als aktiv dargestellt werden soll.
 */
function syncProviderToggleButtons(host: HTMLElement, provider: LLMProvider) {
  host
    .querySelectorAll<HTMLButtonElement>(
      ".zai-provider-toggle-button[data-provider]",
    )
    .forEach((button) => {
      const isActive = getProviderButtonValue(button) === provider;
      button.classList.toggle("zai-provider-toggle-button-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
}

/**
 * Übersetzt den `data-provider`-Wert eines Buttons in eine gültige Provider-ID.
 *
 * @param button - Angeklickter Provider-Button.
 * @returns `ollama` für Lokal, andernfalls `kisski` für Cloud.
 */
function getProviderButtonValue(button: HTMLButtonElement): LLMProvider {
  return button.dataset.provider === "ollama" ? "ollama" : "kisski";
}

/**
 * Führt den eigentlichen Wechsel des LLM-Providers aus. Bei einer Änderung
 * werden Einstellung und Zotero-Präferenz gespeichert und Chat- sowie
 * Embedding-Konfiguration neu aufgebaut. Anschließend werden Modellanzeige und
 * Setup-Readiness für alle Sidebars aktualisiert.
 *
 * @param provider - Neu ausgewählter Cloud- oder Lokal-Provider.
 */
function setActiveProvider(provider: LLMProvider) {
  const currentProvider = getActiveProvider();
  if (provider !== currentProvider) {
    addon.data.settings.provider = provider;
    savePluginPreference("provider", provider);
    addon.api.configureAI();
    addon.api.configureEmbeddings();
  }

  /**
   * A click on the already active provider still refreshes UI, models, and
   * connection readiness so stale setup state is corrected.
   */
  syncAllModelPickers();
  void ensureModelOptionsLoaded(provider);
  void revalidateCurrentReadiness(true);
}

/**
 * Resets setup-relevant runtime state after preferences that affect readiness changed.
 *
 * @returns Nothing.
 */
export function handleSetupRelevantSettingsChanged() {
  nextProviderConnectionRequestID += 1;
  nextEmbeddingConnectionRequestID += 1;
  providerConnectionRequestIDs.clear();
  addon.data.runtime.providerConnections = {};
  addon.data.runtime.embeddingConnection = addon.data.settings
    .embeddingSearchEnabled
    ? ({
        status: "unknown",
        ok: false,
        checkedAt: new Date().toISOString(),
      } as EmbeddingConnectionResult)
    : ({
        status: "disabled",
        ok: true,
        checkedAt: new Date().toISOString(),
      } as EmbeddingConnectionResult);
  modelLoadStates.clear();
  modelOptionsByProvider.delete("ollama");
  addon.api.configureAI();
  addon.api.configureEmbeddings();
  renderAllHosts();
  void revalidateCurrentReadiness(true);
}

/**
 * Confirms c on fi rm te rm in at eo ll am a.
 *
 * @param host - Parameter used by confirmTerminateOllama.
 * @returns Result produced by confirmTerminateOllama.
 */
function confirmTerminateOllama(host: HTMLElement) {
  const win = host.ownerDocument.defaultView;
  if (!win) return false;

  return win.confirm(
    "Ollama vollständig beenden? Dadurch werden auch Ollama-Prozesse beendet, die nicht von ZAIA gestartet wurden.",
  );
}

/**
 * Terminates t er mi na te ol la ma co mp le te ly.
 * @returns Result produced by terminateOllamaCompletely.
 */
async function terminateOllamaCompletely() {
  ollamaTerminateRunning = true;
  renderAllHosts();

  try {
    await addon.api.terminateOllama();
    modelLoadStates.delete("ollama");
    modelOptionsByProvider.delete("ollama");
    delete addon.data.runtime.providerConnections.ollama;
    addon.data.runtime.embeddingConnection = addon.data.settings
      .embeddingSearchEnabled
      ? createCheckingEmbeddingConnectionResult()
      : addon.data.runtime.embeddingConnection;
    await Promise.all([
      checkProviderConnection("ollama", true),
      ...(addon.data.settings.embeddingSearchEnabled
        ? [checkEmbeddingConnection(true)]
        : []),
    ]);
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  } finally {
    ollamaTerminateRunning = false;
    renderAllHosts();
  }
}

/**
 * Prüft nach einem Providerwechsel die aktive Chat-Verbindung und bei Bedarf
 * zusätzlich Ollama-Embeddings. Danach werden Setup-Timeline, Toggle und
 * Composer anhand des neuen Readiness-Zustands neu gerendert.
 *
 * @param force - Erzwingt neue Prüfungen trotz vorhandener Statuswerte.
 * @returns Aktualisierter Einrichtungsstand des aktiven Providers.
 */
async function revalidateCurrentReadiness(force: boolean) {
  const provider = getActiveProvider();
  const tasks: Promise<unknown>[] = [checkProviderConnection(provider, force)];
  if (addon.data.settings.embeddingSearchEnabled) {
    tasks.push(checkEmbeddingConnection(force));
  } else {
    addon.data.runtime.embeddingConnection = {
      status: "disabled",
      ok: true,
      checkedAt: new Date().toISOString(),
      model: REQUIRED_EMBEDDING_MODEL,
    };
  }

  await Promise.all(tasks);
  renderAllHosts();
  return getCurrentSetupReadiness();
}

/**
 * Ensures e ns ur ep ro vi de rc on ne ct io nc he ck ed.
 *
 * @param provider - Parameter used by ensureProviderConnectionChecked.
 * @returns Result produced by ensureProviderConnectionChecked.
 */
function ensureProviderConnectionChecked(provider: LLMProvider) {
  const connection = addon.data.runtime.providerConnections[provider];
  if (connection) {
    renderAllHosts();
    return;
  }

  void checkProviderConnection(provider, false);
}

/**
 * Checks c he ck pr ov id er co nn ec ti on.
 *
 * @param provider - Parameter used by checkProviderConnection.
 * @param force - Parameter used by checkProviderConnection.
 * @returns Result produced by checkProviderConnection.
 */
async function checkProviderConnection(provider: LLMProvider, force: boolean) {
  const currentConnection = addon.data.runtime.providerConnections[provider];
  if (!force && currentConnection) return currentConnection;

  const requestID = nextProviderConnectionRequestID++;
  providerConnectionRequestIDs.set(provider, requestID);
  addon.data.runtime.providerConnections[provider] =
    createCheckingProviderConnectionResult(provider);
  renderAllHosts();

  try {
    const result = await addon.api.checkProviderConnection(provider);
    if (providerConnectionRequestIDs.get(provider) !== requestID) {
      void revalidateCurrentReadiness(true);
      return result;
    }

    addon.data.runtime.providerConnections[provider] = result;
    if (result.ok) {
      void ensureModelOptionsLoaded(provider, true);
    }
    return result;
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    return addon.data.runtime.providerConnections[provider];
  } finally {
    renderAllHosts();
  }
}

/**
 * Checks c he ck em be dd in gc on ne ct io n.
 *
 * @param force - Parameter used by checkEmbeddingConnection.
 * @returns Result produced by checkEmbeddingConnection.
 */
async function checkEmbeddingConnection(force: boolean) {
  const currentConnection = addon.data.runtime.embeddingConnection;
  if (!force && currentConnection.status !== "unknown") {
    return currentConnection;
  }

  const requestID = nextEmbeddingConnectionRequestID++;
  addon.data.runtime.embeddingConnection =
    createCheckingEmbeddingConnectionResult();
  renderAllHosts();

  try {
    const result = await addon.api.checkEmbeddingConnection();
    if (requestID !== nextEmbeddingConnectionRequestID - 1) {
      void revalidateCurrentReadiness(true);
      return result;
    }

    addon.data.runtime.embeddingConnection = result;
    return result;
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    return addon.data.runtime.embeddingConnection;
  } finally {
    renderAllHosts();
  }
}

/**
 * Startet über die öffentliche Addon-API das externe Ollama-Setup, verarbeitet
 * dessen Ergebnis und startet Ollama nach erfolgreicher Installation.
 * Mehrfachstarts werden verhindert und alle Sidebar-Ansichten aktualisiert.
 */
async function launchOllamaSetup() {
  if (ollamaSetupLaunchRunning) return;

  ollamaSetupLaunchRunning = true;
  ollamaSetupStatusText = "";
  renderAllHosts();

  try {
    const result = await addon.api.launchOllamaSetup();
    if (result.status === "cancelled") {
      ollamaSetupStatusText = getString("sidebar-ollama-setup-cancelled");
      return;
    }
    if (result.status === "error") {
      const message = getOllamaSetupErrorText(result.code);
      setOllamaSetupConnectionError(message);
      ollamaSetupStatusText = message;
      return;
    }

    ollamaSetupStatusText = getString("sidebar-ollama-setup-installed");
    await startOllama();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    const message = getString("sidebar-launch-ollama-setup-failed");
    setOllamaSetupConnectionError(
      message,
      error instanceof Error ? error.message : String(error),
    );
    ollamaSetupStatusText = message;
  } finally {
    ollamaSetupLaunchRunning = false;
    renderAllHosts();
  }
}

/**
 * Ordnet die technischen Ergebnis-Codes der Setup-Skripte verständlichen,
 * lokalisierten Fehlermeldungen zu.
 *
 * @param code - Von `setup-result.json` gelieferter Ergebnis-Code.
 * @returns Lokalisierte Fehlermeldung für die Sidebar.
 */
function getOllamaSetupErrorText(code: string) {
  if (code === "download-failed") {
    return getString("sidebar-ollama-setup-download-failed");
  }
  if (
    code === "invalid-signature" ||
    code === "unexpected-publisher" ||
    code === "not-notarized"
  ) {
    return getString("sidebar-ollama-setup-verification-failed");
  }
  return getString("sidebar-ollama-setup-install-failed");
}

/**
 * Überträgt einen Fehler des externen Setups in den Ollama-Verbindungsstatus,
 * damit die Setup-Timeline ihn unmittelbar darstellen kann.
 *
 * @param message - Benutzerfreundliche Fehlermeldung.
 * @param error - Optionaler technischer Fehlertext für Diagnosezwecke.
 */
function setOllamaSetupConnectionError(message: string, error = message) {
  const currentConnection = addon.data.runtime.providerConnections.ollama;
  addon.data.runtime.providerConnections.ollama = {
    ...(currentConnection ??
      createProviderConnectionResult("ollama", "unreachable", {
        issue: "ollama-not-installed",
      })),
    error,
    message,
  };
}

/**
 * Startet den Ollama-Dienst nach der Installation oder über die Setup-Aktion
 * und prüft anschließend alle davon abhängigen Verbindungen erneut.
 */
async function startOllama() {
  if (ollamaStartRunning) return;

  ollamaStartRunning = true;
  renderAllHosts();

  try {
    await addon.api.startOllama();
    await refreshOllamaDependentConnections();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    const currentConnection = addon.data.runtime.providerConnections.ollama;
    addon.data.runtime.providerConnections.ollama = {
      ...(currentConnection ??
        createProviderConnectionResult("ollama", "error")),
      status: "error",
      ok: false,
      issue: "ollama-start-failed",
      error: error instanceof Error ? error.message : String(error),
      message: getString("sidebar-start-ollama-failed"),
    };
  } finally {
    ollamaStartRunning = false;
    renderAllHosts();
  }
}

/**
 * Wartet auf die Ollama-Verbindung und aktualisiert danach zusätzlich den
 * Embedding-Status der Setup-Timeline.
 */
async function refreshOllamaDependentConnections() {
  await waitForOllamaConnection();
  await checkEmbeddingConnection(true);
}

/**
 * Lädt ein Modell direkt aus der Setup-Karte der Sidebar herunter. Der Download
 * verwendet `pullModel` mit Fortschrittsmeldungen und nicht das externe
 * Installationsskript.
 *
 * @param target - Setup-Bereich, dem der Download zugeordnet wird.
 * @param model - Name des herunterzuladenden Ollama-Modells.
 * @param win - Fenster für Fortschritts- und Installationsereignisse.
 */
async function pullSetupModel(
  target: SetupModelDownloadTarget,
  model: string,
  win: Window,
) {
  if (setupModelDownloads.get(target)?.status === "downloading") return;

  const provider = addon.api.ai.getProvider("ollama");
  if (typeof provider.pullModel !== "function") return;

  /**
   * The controller must come from the same window as fetch because Gecko
   * rejects AbortSignal instances created in a different global.
   */
  const controller = createWindowAbortController(win);
  setupModelDownloads.set(target, {
    status: "downloading",
    percent: null,
    statusText: getString("sidebar-setup-model-download-starting"),
    controller,
  });
  renderAllHosts();

  let lastProgressRenderAt = 0;
  try {
    await provider.pullModel(model, {
      inactivityTimeout: 120_000,
      signal: controller.signal,
      onProgress: (progress: LocalModelProgress) => {
        try {
          if (setupModelDownloads.get(target)?.controller !== controller)
            return;
          setupModelDownloads.set(target, {
            status: "downloading",
            percent: progress.percent,
            statusText: formatProgressStatus(progress),
            controller,
          });
          /**
           * Ollama can stream progress many times per second; throttling
           * renders keeps the response reader from being blocked by UI work.
           */
          const now = Date.now();
          if (!progress.done && now - lastProgressRenderAt < 300) {
            return;
          }
          lastProgressRenderAt = now;
          renderAllHosts();
        } catch (renderError) {
          /**
           * Progress UI failures must not bubble into the model stream reader,
           * where they would be treated as download failures.
           */
          Zotero.logError(
            renderError instanceof Error
              ? renderError
              : new Error(String(renderError)),
          );
        }
      },
    });
    if (setupModelDownloads.get(target)?.controller !== controller) return;

    setupModelDownloads.delete(target);
    modelLoadStates.delete("ollama");
    modelOptionsByProvider.delete("ollama");
    delete addon.data.runtime.providerConnections.ollama;
    await revalidateCurrentReadiness(true);
  } catch (error) {
    if (setupModelDownloads.get(target)?.controller !== controller) return;

    if (isAbortError(error)) {
      setupModelDownloads.delete(target);
      renderAllHosts();
      return;
    }

    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    /**
     * Provider response errors can wrap the actionable failure in `cause`;
     * logging it preserves root-cause detail in Zotero's error console.
     */
    const cause =
      error && typeof error === "object" && "cause" in error
        ? (error as { cause?: unknown }).cause
        : undefined;
    if (cause instanceof Error) Zotero.logError(cause);

    setupModelDownloads.set(target, {
      status: "error",
      percent: null,
      statusText: getFriendlyErrorMessage(error),
    });
    renderAllHosts();
  }
}

/**
 * Bricht einen aus der Setup-Timeline gestarteten Modelldownload ab.
 *
 * @param target - Setup-Bereich des abzubrechenden Downloads.
 */
function cancelSetupModelDownload(target: SetupModelDownloadTarget) {
  const state = setupModelDownloads.get(target);
  if (state?.status !== "downloading") return;

  state.controller?.abort();
  setupModelDownloads.set(target, {
    status: "downloading",
    percent: state.percent,
    statusText: getString("sidebar-setup-model-download-cancelling"),
    controller: state.controller,
  });
  renderAllHosts();
}

/**
 * Waits for w ai tf or ol la ma co nn ec ti on.
 * @returns Result produced by waitForOllamaConnection.
 */
async function waitForOllamaConnection() {
  const timeoutAt = Date.now() + 12_000;
  let result: ProviderConnectionResult | undefined;

  do {
    result = await checkProviderConnection("ollama", true);
    if (result && result.status !== "unreachable") return result;
    await delay(1_000);
  } while (Date.now() < timeoutAt);

  return result;
}

/**
 * Delays execution for the requested duration.
 *
 * @param ms - Parameter used by delay.
 * @returns Result produced by delay.
 */
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lädt die Modelloptionen des ausgewählten Providers und synchronisiert während
 * Lade-, Erfolgs- und Fehlerzustand alle Modellanzeigen. Für den aktiven
 * Provider wird zuvor dessen aktuelle Laufzeitkonfiguration übernommen.
 *
 * @param provider - Provider, dessen Modelle geladen werden sollen.
 * @param force - Ignoriert einen bereits vorhandenen Ladezustand.
 */
async function ensureModelOptionsLoaded(provider: LLMProvider, force = false) {
  const state = modelLoadStates.get(provider);
  if (!force) {
    if (state?.status === "loading") return;
    if (state?.status === "loaded" && modelOptionsByProvider.has(provider)) {
      return;
    }
  }

  const requestID = nextModelLoadRequestID++;
  modelLoadStates.set(provider, { status: "loading", requestID });
  syncAllModelPickers();

  try {
    if (provider === getActiveProvider()) {
      addon.api.configureAI();
      addon.api.configureEmbeddings();
    }
    const models = normalizeModelOptions(
      await addon.api.ai.listModels(provider),
      provider,
    );
    if (modelLoadStates.get(provider)?.requestID !== requestID) return;

    modelOptionsByProvider.set(provider, models);
    modelLoadStates.set(provider, { status: "loaded" });
  } catch (error) {
    if (modelLoadStates.get(provider)?.requestID !== requestID) return;

    const message = error instanceof Error ? error.message : String(error);
    if (provider === "kisski" && !modelOptionsByProvider.has(provider)) {
      modelOptionsByProvider.set(
        provider,
        normalizeModelOptions(KISSKI_MODEL_OPTIONS),
      );
    }
    modelLoadStates.set(provider, { status: "error", message });
  } finally {
    syncAllModelPickers();
  }
}

/**
 * Normalizes n or ma li ze mo de lo pt io ns.
 *
 * @param models - Parameter used by normalizeModelOptions.
 * @param provider - Parameter used by normalizeModelOptions.
 * @returns Result produced by normalizeModelOptions.
 */
function normalizeModelOptions(
  models: unknown,
  provider?: LLMProvider,
): ModelOption[] {
  if (!Array.isArray(models)) return [];

  const seen = new Set<string>();
  const options: ModelOption[] = [];

  for (const model of models) {
    const record = model as {
      id?: unknown;
      name?: unknown;
      ownedBy?: unknown;
    };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    if (provider === "ollama" && isLocalEmbeddingModel(id)) continue;

    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : id;
    const ownedBy =
      typeof record.ownedBy === "string" && record.ownedBy.trim()
        ? record.ownedBy.trim()
        : "";
    const option: ModelOption = { id, name };
    if (ownedBy) option.ownedBy = ownedBy;

    seen.add(id);
    options.push(option);
  }

  return sortModelOptions(options);
}

/**
 * Checks whether i sl oc al em be dd in gm od el.
 *
 * @param model - Parameter used by isLocalEmbeddingModel.
 * @returns Result produced by isLocalEmbeddingModel.
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
 * Baut die Modellauswahl für den aktiven Provider neu auf und markiert den
 * persistent gespeicherten Modellwert als ausgewählt.
 *
 * @param dropdown - Zu aktualisierendes Dropdown.
 * @param provider - Provider, dessen Modelle angezeigt werden.
 */
function syncModelDropdown(
  dropdown: HTMLElement | null,
  provider: LLMProvider = getActiveProvider(),
) {
  if (!dropdown) return;

  const value = getActiveModel(provider).trim();
  const options = dropdown.querySelector<HTMLElement>(
    ".zai-model-select-options",
  );
  if (!options) return;

  dropdown.dataset.provider = provider;
  const models = modelOptionsByProvider.get(provider) ?? [];
  const values = getModelDropdownValues(models, value, provider);
  const optionNodes = values.map((model) =>
    createModelDropdownOption(dropdown.ownerDocument, model, model === value),
  );
  const stateNode = createModelDropdownState(
    dropdown.ownerDocument,
    provider,
    models.length,
  );
  const addNode =
    provider === "ollama"
      ? createModelDropdownAddButton(dropdown.ownerDocument)
      : null;

  options.replaceChildren(
    ...optionNodes,
    ...(stateNode ? [stateNode] : []),
    ...(addNode ? [addNode] : []),
  );
  updateModelDropdownDisplay(dropdown, value, provider);
}

/**
 * Ermittelt die auswählbaren Modell-IDs. Für Ollama werden Embedding-Modelle aus
 * der Chat-Auswahl entfernt; bei Cloud bleibt auch ein gespeicherter Wert
 * sichtbar, wenn die aktuelle API-Liste ihn nicht enthält.
 *
 * @param models - Vom Provider geladene Modelle.
 * @param selectedValue - Persistierter aktueller Modellwert.
 * @param provider - Zugehöriger Provider.
 * @returns Eindeutige und sortierte Modell-IDs für das Dropdown.
 */
function getModelDropdownValues(
  models: ModelOption[],
  selectedValue: string,
  provider: LLMProvider,
) {
  if (provider === "ollama") {
    return getSelectableLocalModelValues(models.map((model) => model.id));
  }

  const values = [...models.map((model) => model.id.trim()), selectedValue];

  return [...new Set(values.filter(Boolean))].sort(compareModelNames);
}

/**
 * Sorts s or tm od el op ti on s.
 *
 * @param options - Parameter used by sortModelOptions.
 * @returns Result produced by sortModelOptions.
 */
function sortModelOptions(options: ModelOption[]) {
  return [...options].sort((a, b) =>
    compareModelNames(a.name || a.id, b.name || b.id),
  );
}

/**
 * Compares c om pa re mo de ln am es.
 *
 * @param a - Parameter used by compareModelNames.
 * @param b - Parameter used by compareModelNames.
 * @returns Result produced by compareModelNames.
 */
function compareModelNames(a: string, b: string) {
  return a.localeCompare(b, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

/**
 * Creates c re at em od el dr op do wn st at e.
 *
 * @param doc - Parameter used by createModelDropdownState.
 * @param provider - Parameter used by createModelDropdownState.
 * @param modelCount - Parameter used by createModelDropdownState.
 * @returns Result produced by createModelDropdownState.
 */
function createModelDropdownState(
  doc: Document,
  provider: LLMProvider,
  modelCount: number,
) {
  const state = modelLoadStates.get(provider);
  let text = "";
  let title = "";

  if (state?.status === "loading") {
    text = "Modelle werden geladen...";
  } else if (state?.status === "error") {
    text = modelCount
      ? "Aktualisierung fehlgeschlagen"
      : "Modelle konnten nicht geladen werden";
    title = state.message ?? "";
  } else if (state?.status === "loaded" && modelCount === 0) {
    text = "Keine Modelle gefunden";
  }

  if (!text) return null;

  const element = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  element.className = "zai-model-select-state";
  element.textContent = text;
  if (title) element.title = title;
  return element;
}

/**
 * Erstellt eine auswählbare Modelloption und kennzeichnet ihren Auswahlzustand
 * barrierefrei über `aria-selected`.
 */
function createModelDropdownOption(
  doc: Document,
  value: string,
  selected: boolean,
) {
  const option = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  option.className = "zai-model-select-option";
  option.dataset.modelValue = value;
  option.textContent = value;
  option.title = value;
  option.type = "button";
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", String(selected));
  return option;
}

/**
 * Creates c re at em od el dr op do wn ad db ut to n.
 *
 * @param doc - Parameter used by createModelDropdownAddButton.
 * @returns Result produced by createModelDropdownAddButton.
 */
function createModelDropdownAddButton(doc: Document) {
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.className = "zai-model-select-add-button";
  button.dataset.action = "add-local-model";
  button.textContent = "Modell hinzufügen...";
  button.title = "Lokales Ollama-Modell hinzufügen";
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  return button;
}

/**
 * Aktualisiert den sichtbaren Modellwert und die Auswahlmarkierungen, ohne den
 * gespeicherten Wert selbst zu verändern.
 *
 * @param dropdown - Zu aktualisierende Modellauswahl.
 * @param value - Aktuell gespeicherte Modell-ID.
 * @param provider - Zugehöriger Provider.
 */
function updateModelDropdownDisplay(
  dropdown: HTMLElement,
  value: string,
  provider: LLMProvider,
) {
  const displayValue = value || "Modell auswählen";
  const button = dropdown.querySelector<HTMLButtonElement>(".zai-model-select");
  const display = dropdown.querySelector<HTMLElement>(
    ".zai-model-select-value",
  );
  if (!button || !display) return;

  button.dataset.modelValue = value;
  button.dataset.provider = provider;
  button.title = `${getProviderLabel(provider)}: ${displayValue}`;
  display.textContent = displayValue;
  display.title = button.title;

  dropdown
    .querySelectorAll<HTMLElement>(".zai-model-select-option")
    .forEach((option) => {
      option.setAttribute(
        "aria-selected",
        String(option.dataset.modelValue === value),
      );
    });
}

/**
 * Übernimmt eine Auswahl aus dem Dropdown, speichert sie providerbezogen und
 * synchronisiert danach alle geöffneten Sidebars.
 *
 * @param dropdown - Dropdown, in dem die Auswahl erfolgte.
 * @param value - Ausgewählte Modell-ID.
 */
function selectModelDropdownValue(dropdown: HTMLElement, value: string) {
  const provider = getDropdownProvider(dropdown);
  setProviderModel(provider, value);
  closeModelDropdown(dropdown);
  syncAllModelPickers();
}

/** Liest den Provider, dem das aktuell dargestellte Dropdown zugeordnet ist. */
/**
 * Gets g et dr op do wn pr ov id er.
 *
 * @param dropdown - Parameter used by getDropdownProvider.
 * @returns Result produced by getDropdownProvider.
 */
function getDropdownProvider(dropdown: HTMLElement): LLMProvider {
  return dropdown.dataset.provider === "ollama" ? "ollama" : "kisski";
}

/**
 * Speichert ein ausgewähltes Modell getrennt für Ollama und KISSKI. Neben dem
 * Laufzeitwert wird die passende Zotero-Präferenz (`ollamaModel` oder `model`)
 * aktualisiert. Danach erhält der Provider-Manager das Modell und ein veralteter
 * Verbindungsstatus wird verworfen.
 *
 * @param provider - Provider, dessen Modell geändert wird.
 * @param value - Neue Modell-ID.
 */
function setProviderModel(provider: LLMProvider, value: string) {
  const model = value.trim();
  if (!model) return;

  /**
   * Cloud and local models intentionally use separate preference fields so a
   * provider switch restores the previous selection for that provider.
   */
  if (provider === "ollama") {
    addon.data.settings.ollamaModel = model;
    savePluginPreference("ollamaModel", model);
  } else {
    addon.data.settings.model = model;
    savePluginPreference("model", model);
  }

  /**
   * The manager is updated immediately; readiness checks only need to rerun
   * when the changed model belongs to the active provider.
   */
  addon.api.ai.setModel(model, provider);
  delete addon.data.runtime.providerConnections[provider];
  if (provider === getActiveProvider()) {
    addon.api.configureAI();
    addon.api.configureEmbeddings();
    void revalidateCurrentReadiness(true);
  }
}

/**
 * Formats the short visible label for a provider.
 *
 * @param provider - Provider whose label should be returned.
 * @returns Short provider label.
 */
function getProviderLabel(provider: LLMProvider) {
  return provider === "ollama" ? "Lokal" : "Cloud";
}

/**
 * Speichert eine Provider- oder Modelleinstellung dauerhaft in Zotero.
 *
 * @param key - Einstellungsname ohne Add-on-Präfix.
 * @param value - Zu speichernder Wert.
 */
function savePluginPreference(key: string, value: string) {
  Zotero.Prefs.set(`${addon.data.config.prefsPrefix}.${key}`, value, true);
}

/**
 * Toggles t og gl em od el dr op do wn.
 *
 * @param dropdown - Parameter used by toggleModelDropdown.
 * @returns Result produced by toggleModelDropdown.
 */
function toggleModelDropdown(dropdown: HTMLElement) {
  const open = !dropdown.classList.contains("zai-model-select-wrap-open");
  if (open) {
    openModelDropdown(dropdown);
  } else {
    closeModelDropdown(dropdown);
  }
}

/**
 * Opens o pe nm od el dr op do wn.
 *
 * @param dropdown - Parameter used by openModelDropdown.
 * @returns Result produced by openModelDropdown.
 */
function openModelDropdown(dropdown: HTMLElement) {
  closeOtherModelDropdowns(dropdown);
  const button = dropdown.querySelector<HTMLButtonElement>(".zai-model-select");
  const options = dropdown.querySelector<HTMLElement>(
    ".zai-model-select-options",
  );
  if (!button || !options) return;

  dropdown.classList.add("zai-model-select-wrap-open");
  button.setAttribute("aria-expanded", "true");
  options.hidden = false;
}

/**
 * Closes c lo se mo de ld ro pd ow n.
 *
 * @param dropdown - Parameter used by closeModelDropdown.
 * @returns Result produced by closeModelDropdown.
 */
function closeModelDropdown(dropdown: HTMLElement) {
  const button = dropdown.querySelector<HTMLButtonElement>(".zai-model-select");
  const options = dropdown.querySelector<HTMLElement>(
    ".zai-model-select-options",
  );

  dropdown.classList.remove("zai-model-select-wrap-open");
  button?.setAttribute("aria-expanded", "false");
  if (options) {
    options.hidden = true;
  }
}

/**
 * Closes c lo se ot he rm od el dr op do wn s.
 *
 * @param dropdown - Parameter used by closeOtherModelDropdowns.
 * @returns Result produced by closeOtherModelDropdowns.
 */
function closeOtherModelDropdowns(dropdown: HTMLElement) {
  dropdown.ownerDocument
    .querySelectorAll<HTMLElement>(".zai-model-select-wrap-open")
    .forEach((openDropdown) => {
      if (openDropdown !== dropdown) {
        closeModelDropdown(openDropdown);
      }
    });
}

/**
 * Ensures e ns ur em od el dr op do wn ou ts id eh an dl er.
 *
 * @param doc - Parameter used by ensureModelDropdownOutsideHandler.
 * @returns Result produced by ensureModelDropdownOutsideHandler.
 */
function ensureModelDropdownOutsideHandler(doc: Document) {
  if (modelDropdownDocuments.has(doc)) return;

  modelDropdownDocuments.add(doc);
  doc.addEventListener("click", (event) => {
    const target = event.target as Node | null;
    doc
      .querySelectorAll<HTMLElement>(".zai-model-select-wrap-open")
      .forEach((dropdown) => {
        if (!target || !dropdown.contains(target)) {
          closeModelDropdown(dropdown);
        }
      });
  });
}

/**
 * Handles h an dl em od el dr op do wn ke yd ow n.
 *
 * @param event - Parameter used by handleModelDropdownKeydown.
 * @param dropdown - Parameter used by handleModelDropdownKeydown.
 * @returns Result produced by handleModelDropdownKeydown.
 */
function handleModelDropdownKeydown(
  event: KeyboardEvent,
  dropdown: HTMLElement,
) {
  const optionButtons = getModelDropdownOptionButtons(dropdown);
  const activeOption = (event.target as Element | null)?.closest(
    ".zai-model-select-option",
  );
  const activeIndex = activeOption
    ? optionButtons.indexOf(activeOption as HTMLButtonElement)
    : -1;

  if (event.key === "Escape") {
    closeModelDropdown(dropdown);
    dropdown.querySelector<HTMLButtonElement>(".zai-model-select")?.focus();
    event.preventDefault();
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!dropdown.classList.contains("zai-model-select-wrap-open")) {
      openModelDropdown(dropdown);
    }

    const nextIndex =
      event.key === "ArrowDown"
        ? Math.min(activeIndex + 1, optionButtons.length - 1)
        : Math.max(activeIndex - 1, 0);
    optionButtons[nextIndex]?.focus();
    event.preventDefault();
    return;
  }

  if (event.key === "Home" || event.key === "End") {
    if (!dropdown.classList.contains("zai-model-select-wrap-open")) {
      openModelDropdown(dropdown);
    }

    const nextIndex = event.key === "Home" ? 0 : optionButtons.length - 1;
    optionButtons[nextIndex]?.focus();
    event.preventDefault();
    return;
  }

  if (
    activeOption &&
    (event.key === "Enter" || event.key === " " || event.key === "Spacebar")
  ) {
    const value = (activeOption as HTMLElement).dataset.modelValue;
    if (value) {
      selectModelDropdownValue(dropdown, value);
      dropdown.querySelector<HTMLButtonElement>(".zai-model-select")?.focus();
    }
    event.preventDefault();
  }
}

/**
 * Gets g et mo de ld ro pd ow no pt io nb ut to ns.
 *
 * @param dropdown - Parameter used by getModelDropdownOptionButtons.
 * @returns Result produced by getModelDropdownOptionButtons.
 */
function getModelDropdownOptionButtons(dropdown: HTMLElement) {
  return Array.from(
    dropdown.querySelectorAll(".zai-model-select-option"),
  ) as unknown as HTMLButtonElement[];
}

/**
 * Logs l og si mu la ti on pr om pt.
 *
 * @param message - Parameter used by logSimulationPrompt.
 * @returns Result produced by logSimulationPrompt.
 */
function logSimulationPrompt(message: AssistantChatMessage) {
  const output = `[Zotero AI Simulation] Prompt #${message.id}:\n${message.content}`;
  Zotero.debug(output);
  (
    Zotero as unknown as {
      log?: (message: string) => void;
    }
  ).log?.(output);

  const consoleObject = (
    globalThis as typeof globalThis & {
      console?: { log?: (...values: unknown[]) => void };
    }
  ).console;
  consoleObject?.log?.(output);
}

/**
 * Sets s et si mu la ti on en ab le d.
 *
 * @param enabled - Parameter used by setSimulationEnabled.
 * @returns Result produced by setSimulationEnabled.
 */
function setSimulationEnabled(enabled: boolean) {
  simulationEnabled = enabled;
  renderAllHosts();
  Zotero.debug(
    `[Zotero AI Simulation] ${enabled ? "aktiviert" : "deaktiviert"}`,
  );
  return getSimulationState();
}

/**
 * Gets g et si mu la ti on st at e.
 * @returns Result produced by getSimulationState.
 */
function getSimulationState() {
  return {
    enabled: simulationEnabled,
    pendingPrompts: pendingSimulationPrompts.map((prompt) => ({ ...prompt })),
  };
}

/**
 * Replies to r ep ly to si mu la ti on.
 *
 * @param content - Parameter used by replyToSimulation.
 * @param promptID - Parameter used by replyToSimulation.
 * @returns Result produced by replyToSimulation.
 */
function replyToSimulation(content: string, promptID?: number) {
  if (!simulationEnabled) {
    throw new Error(
      "Die Chat-Simulation ist nicht aktiv. Zuerst enable() aufrufen.",
    );
  }

  const answer = content.trim();
  if (!answer) {
    throw new Error("Die simulierte Antwort darf nicht leer sein.");
  }

  const promptIndex =
    promptID === undefined
      ? 0
      : pendingSimulationPrompts.findIndex((prompt) => prompt.id === promptID);
  if (promptIndex < 0 || !pendingSimulationPrompts[promptIndex]) {
    throw new Error("Es wartet kein passender simulierter Prompt.");
  }

  const [prompt] = pendingSimulationPrompts.splice(promptIndex, 1);
  const message = appendMessage("assistant", answer);
  if (activeChatID) {
    void persistChatMessage(activeChatID, message)
      .then(() => refreshChatSummaries(false))
      .catch((error) => {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  }
  Zotero.debug(
    `[Zotero AI Simulation] Antwort für Prompt #${prompt.id} übernommen.`,
  );
  return message;
}

/**
 * Development helper API for simulating assistant replies without calling a provider.
 */
export const chatSimulation = {
  enable() {
    return setSimulationEnabled(true);
  },
  disable() {
    return setSimulationEnabled(false);
  },
  isEnabled() {
    return simulationEnabled;
  },
  getState: getSimulationState,
  getPendingPrompts() {
    return getSimulationState().pendingPrompts;
  },
  reply: replyToSimulation,
};
