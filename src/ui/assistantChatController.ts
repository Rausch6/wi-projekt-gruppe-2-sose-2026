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
import type { LLMProvider, OllamaSetupMode } from "../addon";
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
let ollamaSetupAwaitingCompletion = false;
let ollamaStartRunning = false;
let ollamaTerminateRunning = false;
let lastPromptContextRouteDebug: PromptContextRouteDebug | null = null;
let lastAssistantRequestDebug: AssistantRequestDebug | null = null;
let setupStalled = false;
let setupStallTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let setupWasVisible = false;

const SETUP_STALL_TIMEOUT_MS = 3_000;

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

export type AssistantRequestDebug = {
  provider: LLMProvider;
  model: string;
  transport: "stream" | "buffered";
  messageCount: number;
  messages: RequestMessage[];
  createdAt: string;
};

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
    void sendChatPrompt(prompt).catch(() => {
      // The error is already rendered as a chat message.
    });
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
      ollamaSetupAwaitingCompletion = false;
      void revalidateCurrentReadiness(true);
    } else if (action === "launch-required-setup") {
      void launchOllamaSetup(getRequiredOllamaSetupMode());
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

function getSidebarView(host: HTMLElement): SidebarView {
  return sidebarViews.get(host) ?? "chat";
}

function getSidebarViewTarget(button: HTMLButtonElement): SidebarView {
  return button.dataset.viewTarget === "about" ? "about" : "chat";
}

function setSidebarView(host: HTMLElement, view: SidebarView) {
  hosts.add(host);
  sidebarViews.set(host, view);
  renderHost(host);
}

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

async function useInstalledLocalModel(model: string) {
  addon.data.settings.provider = "ollama";
  savePluginPreference("provider", "ollama");
  setProviderModel("ollama", model);

  await ensureModelOptionsLoaded("ollama", true);
  await checkProviderConnection("ollama", true);
  syncAllModelPickers();
}

export async function initializeChatPersistence() {
  await refreshChatSummaries(false);
  activeChatID = null;
  showAllChats = false;
  resetMessages();
  renderAllHosts();
}

export function registerPaperContextSelectionWindow(win: Window | null) {
  ensurePaperContextSelectionPolling(win);
  ensurePaperContextSelectionEventHandlers(win);
  win?.setTimeout(refreshPaperContextControls, 0);
}

export function refreshPaperContextControls() {
  lastAutomaticPaperContextSignature = getAutomaticPaperContextSignature();
  syncAllPaperContextControls();
}

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

export function getChatMessages() {
  return messages.map((message) => ({ ...message }));
}

export function getActiveChatID() {
  return activeChatID;
}

export async function listChats() {
  await refreshChatSummaries(false);
  return chatSummaries.map((chat) => ({ ...chat }));
}

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

export function clearChat() {
  returnToWelcome();
}

export async function createChatAndFocusComposer() {
  const chat = await createChat();
  focusAssistantComposer();
  return chat;
}

export async function toggleActiveChatFavorite() {
  const chatID = activeChatID;
  if (!chatID) {
    throw new Error("Es ist kein ZAIA-Chat aktiv.");
  }

  const nextFavorite = !getActiveChatSummary()?.isFavorite;
  await setChatFavorite(chatID, nextFavorite);
  return nextFavorite;
}

export function focusAssistantComposer(owner?: Window | null) {
  const host = getPreferredAssistantHost(owner);
  const textarea = host?.querySelector<HTMLTextAreaElement>(".zai-input");
  textarea?.focus();
  return Boolean(textarea);
}

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

function cancelActiveAssistantResponse() {
  if (!requestRunning || activeChatCancelRequested) return;

  activeChatCancelRequested = true;
  finalizeActiveAssistantMessage();
  renderAllHosts();
}

function isActiveChatRequestCancelled(requestID: number) {
  return requestID === activeChatRequestID && activeChatCancelRequested;
}

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

function invalidateChatSummaries() {
  chatSummariesLoaded = false;
  chatSummaries.length = 0;
}

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

function getActiveProvider(): LLMProvider {
  return addon.data.settings.provider === "ollama" ? "ollama" : "kisski";
}

function isActiveProviderReady() {
  return isProviderConnectionReady(
    addon.data.runtime.providerConnections[getActiveProvider()],
  );
}

function isEmbeddingReady() {
  return (
    !addon.data.settings.embeddingSearchEnabled ||
    isEmbeddingConnectionReady(addon.data.runtime.embeddingConnection)
  );
}

function isChatReady() {
  return getCurrentSetupReadiness().ready;
}

function getCurrentSetupReadiness(): SetupReadiness {
  const provider = getActiveProvider();
  return deriveSetupReadiness(
    addon.data.settings,
    addon.data.runtime.providerConnections[provider],
    addon.data.runtime.embeddingConnection,
  );
}

function getChatReadinessErrorText() {
  if (addon.data.settings.embeddingSearchEnabled && !isEmbeddingReady()) {
    return getString("sidebar-active-embedding-not-connected-error");
  }
  return getString("sidebar-active-provider-not-connected-error");
}

function getActiveModel(provider: LLMProvider = getActiveProvider()) {
  if (provider !== "ollama") return addon.data.settings.model;

  const model = addon.data.settings.ollamaModel;
  return isLocalEmbeddingModel(model) ? OLLAMA_DEFAULT_MODEL : model;
}

function getSelectedMetadataFields() {
  return getMetadataFieldsForSelection(
    addon.data.settings.metadataFieldSelection,
  );
}

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

function sortRagCandidatesByRecency(
  first: RagItemCandidate,
  second: RagItemCandidate,
) {
  return getCandidateTimestamp(second) - getCandidateTimestamp(first);
}

function clampCandidateLimit(value: number) {
  if (!Number.isFinite(value)) return 200;
  return Math.min(1000, Math.max(1, Math.floor(value)));
}

function getCandidateTimestamp(candidate: RagItemCandidate) {
  const parsed = Date.parse(
    candidate.dateModified || candidate.dateAdded || "",
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

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

function formatCandidateMetadataFull(
  candidate: RagItemCandidate,
  fields: PromptContextRouteDecision["requestedFields"],
) {
  const include = (field: NonNullable<typeof fields>[number]) =>
    !fields?.length || fields.includes(field);
  const lines = [
    `[PAPER Zotero-ID=${candidate.itemID}]`,
    `Item-Key: ${normalizeMetadataValue(candidate.itemKey, "unbekannt")}`,
    `Bibliothek: ${normalizeMetadataValue(candidate.library.name, "Unbekannte Bibliothek")} (Library-ID: ${candidate.library.libraryID})`,
    `Titel: ${normalizeMetadataValue(candidate.title, "Ohne Titel")}`,
    `Autorenschaft: ${normalizeMetadataValue(candidate.creators, "Unbekannte Autorenschaft")}`,
    `Veröffentlichungsdatum: ${normalizeMetadataValue(candidate.publicationDate, "Unbekannt")}`,
    `Jahr: ${normalizeMetadataValue(candidate.year, "Unbekannt")}`,
    `Publikation/Journal: ${normalizeMetadataValue(candidate.publicationTitle, "Unbekannt")}`,
    `Verlag: ${normalizeMetadataValue(candidate.publisher, "Unbekannt")}`,
    `DOI: ${normalizeMetadataValue(candidate.doi, "Nicht vorhanden")}`,
    `ISBN: ${normalizeMetadataValue(candidate.isbn, "Nicht vorhanden")}`,
    `URL: ${normalizeMetadataValue(candidate.url, "Nicht vorhanden")}`,
    `Abstract vorhanden: ${normalizeMetadataValue(candidate.abstractNote) ? "Ja" : "Nein"}`,
    `Typ: ${normalizeMetadataValue(candidate.itemType, "unknown")}`,
    `Tags: ${candidate.tags.length ? candidate.tags.map((tag) => normalizeMetadataValue(tag)).join(", ") : "Keine Tags"}`,
    `Zotero hinzugefügt: ${normalizeMetadataValue(candidate.dateAdded, "Unbekannt")}`,
    `Zotero geändert: ${normalizeMetadataValue(candidate.dateModified, "Unbekannt")}`,
  ];

  if (include("tags")) {
    lines.push(
      `Hinweis: Tags koennen fuer thematische Filter und Gruppierungen genutzt werden.`,
    );
  }

  return [...lines, "[/PAPER]"].join("\n");
}

function normalizeMetadataValue(value: unknown, fallback = "") {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

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

function normalizeFilterText(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

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

function getContextMode(
  decision: PromptContextRouteDecision,
  context: string | null | undefined,
) {
  if (context === undefined) return "fallback";
  if (context === null) return "no-context";
  return decision.route;
}

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

export function formatLastPromptContextRouteDebug() {
  const debug = getLastPromptContextRouteDebug();
  if (!debug) return "Noch keine Prompt-Kontext-Entscheidung vorhanden.";

  return JSON.stringify(debug, null, 2);
}

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

export function formatLastAssistantRequestDebug() {
  const debug = getLastAssistantRequestDebug();
  if (!debug) return "Noch kein KI-Request vorhanden.";

  return JSON.stringify(debug, null, 2);
}

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

function getEffectiveContextRouterProvider(): LLMProvider {
  return addon.data.settings.contextRouterProvider;
}

function getRouterModel(provider: LLMProvider) {
  if (provider === "ollama") {
    const model = addon.data.settings.ollamaModel;
    return isLocalEmbeddingModel(model) ? OLLAMA_DEFAULT_MODEL : model;
  }

  return addon.data.settings.model;
}

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

function hasRealChatMessages() {
  return messages.some(
    (message) =>
      message.role === "user" ||
      (message.role === "assistant" && message.content.trim()),
  );
}

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

function shouldFallbackToBufferedChat(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /stream|sse|event-stream|unsupported|not supported|chatStream/i.test(
    message,
  );
}

function failNoAnswer(): never {
  throw new Error("ZAIA hat keine Textantwort zurückgegeben.");
}

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

function resetMessages() {
  messages.length = 0;
  nextMessageID = 1;
}

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

function isAssistantHostReadyForPopover(host: HTMLElement) {
  if (host.hidden || host.getAttribute("aria-hidden") === "true") {
    return false;
  }

  return isElementReadyForPopover(host);
}

function isElementReadyForPopover(element: HTMLElement) {
  const win = element.ownerDocument.defaultView;
  const style = win?.getComputedStyle(element);
  if (!style || style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

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

function deriveChatTitle(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= 60) return normalized;

  return `${normalized.slice(0, 57)}...`;
}

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
  // Sticky: once the setup view is showing, keep it showing through a
  // transient "checking" re-verification (e.g. switching from one provider
  // that needs setup to another that also does) instead of dropping to the
  // welcome screen for a frame and popping back. It still yields the
  // instant a provider is confirmed ready.
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
      ? getString("sidebar-launching-ollama-setup")
      : ollamaSetupAwaitingCompletion
        ? getString("sidebar-setup-external-running")
        : "";
    liveStatus.textContent = statusText;
    liveStatus.toggleAttribute("hidden", !statusText);
  }
}

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
  // Milestones aren't a strict sequence a user must complete in order, so
  // the marker communicates status (done vs. needs something) rather than
  // position.
  marker.textContent = milestone.state === "complete" ? "✓" : "!";

  const card = createControllerHtmlElement(
    doc,
    "article",
    "zai-setup-step-card",
  );
  const copy = getSetupMilestoneCopy(milestone, readiness);
  const download = getSetupMilestoneDownload(milestone.id);
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
  card.append(
    heading,
    createControllerHtmlElement(
      doc,
      "p",
      "zai-setup-step-description",
      copy.description,
    ),
  );

  const statusText = download ? download.statusText : copy.status;
  if (statusText) {
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

function getSetupMilestoneDownload(milestoneId: SetupMilestone["id"]) {
  return milestoneId === "local-model" || milestoneId === "embedding"
    ? setupModelDownloads.get(milestoneId)
    : undefined;
}

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
        title: getString("sidebar-milestone-ollama-title"),
        description: getString("sidebar-milestone-ollama-description"),
        status: getOllamaInstallationStatusText(
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
  const ollamaNotRunning =
    providerConnection?.issue === "ollama-not-running" ||
    embeddingConnection.issue === "ollama-not-running";

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
      if (ollamaNotRunning && !ollamaSetupAwaitingCompletion) {
        addAction(
          "start-ollama",
          ollamaStartRunning
            ? getString("sidebar-starting-ollama")
            : getString("sidebar-start-ollama"),
        );
      } else {
        addAction(
          ollamaSetupAwaitingCompletion
            ? "check-readiness"
            : "launch-required-setup",
          ollamaSetupAwaitingCompletion
            ? getString("sidebar-setup-check-again")
            : getString("sidebar-launch-ollama-setup"),
        );
      }
      addAction(
        "open-preferences",
        getString("sidebar-open-preferences"),
        true,
      );
      break;
    case "local-model":
      addAction(
        ollamaSetupAwaitingCompletion
          ? "check-readiness"
          : getActiveModel("ollama") === OLLAMA_DEFAULT_MODEL
            ? "install-default-local-model"
            : "open-local-model-window",
        ollamaSetupAwaitingCompletion
          ? getString("sidebar-setup-check-again")
          : getActiveModel("ollama") === OLLAMA_DEFAULT_MODEL
            ? getString(
                download?.status === "error"
                  ? "sidebar-retry-model-download"
                  : "sidebar-install-default-local-model",
              )
            : getString("sidebar-open-local-model-window"),
      );
      addAction("check-readiness", getString("sidebar-check-provider"), true);
      addAction(
        "open-preferences",
        getString("sidebar-open-preferences"),
        true,
      );
      break;
    case "embedding":
      if (ollamaNotRunning && !ollamaSetupAwaitingCompletion) {
        addAction(
          "start-ollama",
          ollamaStartRunning
            ? getString("sidebar-starting-ollama")
            : getString("sidebar-start-ollama"),
        );
      } else {
        addAction(
          ollamaSetupAwaitingCompletion
            ? "check-readiness"
            : "install-embedding-model",
          ollamaSetupAwaitingCompletion
            ? getString("sidebar-setup-check-again")
            : getString(
                download?.status === "error"
                  ? "sidebar-retry-model-download"
                  : "sidebar-install-embedding-model",
              ),
        );
      }
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
  if (active.status === "missing-config") {
    if (active.issue === "base-url-missing") {
      return getString("sidebar-base-url-missing");
    }
    if (active.issue === "model-missing") {
      return getString("sidebar-model-missing");
    }
    return getString("sidebar-local-config-incomplete");
  }
  if (active.status === "ready" || active.status === "missing-model") {
    return getString("sidebar-milestone-ollama-ready");
  }
  if (active.status === "unknown" || active.status === "disabled") {
    return getString("sidebar-connection-not-checked");
  }
  return getString("sidebar-local-unreachable");
}

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

function isProviderConnectionReady(
  connection: ProviderConnectionResult | undefined,
) {
  return connection?.status === "ready";
}

function isEmbeddingConnectionReady(connection: EmbeddingConnectionResult) {
  return connection.status === "ready";
}

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

function createSendArrowIcon(doc: Document) {
  const svg = createIconSvg(doc, "20");
  const line = doc.createElementNS(SVG_NS, "path");
  const arrow = doc.createElementNS(SVG_NS, "path");

  line.setAttribute("d", "M12 19V5");
  arrow.setAttribute("d", "m5 12 7-7 7 7");
  svg.append(line, arrow);

  return svg;
}

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

function createActivityElement(host: HTMLElement, text: string) {
  const element = host.ownerDocument!.createElementNS(
    HTML_NS,
    "div",
  ) as HTMLElement;
  element.className = "zai-activity-line";
  element.textContent = text;
  return element;
}

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

function getActiveChatTitle() {
  const chat = getActiveChatSummary();
  return chat?.title || "Unbenannter Chat";
}

function getActiveChatSummary() {
  if (!activeChatID) return null;

  return chatSummaries.find((entry) => entry.id === activeChatID) ?? null;
}

function confirmDeleteActiveChat(host: HTMLElement) {
  const win = host.ownerDocument?.defaultView;
  if (typeof win?.confirm !== "function") return true;

  return win.confirm(`Chat "${getActiveChatTitle()}" wirklich löschen?`);
}

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

function syncAllModelPickers() {
  for (const host of [...hosts]) {
    syncModelPicker(host);
  }
}

function syncAllMetadataFieldControls() {
  for (const host of [...hosts]) {
    syncMetadataFieldControls(host);
  }
}

function syncAllPaperContextControls() {
  syncPaperContextBadges();
  for (const host of [...hosts]) {
    syncPaperContextControls(host);
  }
}

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
  } catch {
    // Sidebar hosts are still handled above.
  }

  for (const doc of documents) {
    doc
      .querySelectorAll<HTMLElement>(".zai-context-count-badge")
      .forEach((badge) => {
        badge.textContent = String(count);
        badge.toggleAttribute("hidden", count === 0);
      });
  }
}

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

function addBestMatchingPaperToManualContext() {
  const option = getBestMatchingPaperLibraryOption();
  if (!option) return;

  addPaperLibraryOptionToManualContext(option);
}

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

function getBestMatchingPaperLibraryOption() {
  return getFilteredPaperLibraryOptions()[0] ?? null;
}

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

function getVisiblePaperContextCount() {
  const automaticEntries = getAutomaticPaperContextEntries();
  return (
    automaticEntries.length +
    getManualPaperContextEntries(automaticEntries).length
  );
}

function getManualPaperContextEntries(automaticEntries: PaperContextEntry[]) {
  const automaticKeys = new Set(automaticEntries.map(getPaperContextKey));
  return [...manualPaperContextEntries.values()].filter(
    (entry) => !automaticKeys.has(getPaperContextKey(entry)),
  );
}

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

function getAutomaticPaperContextEntries() {
  return getSelectedContextItems().map((item) =>
    createPaperContextEntry(item, "automatic"),
  );
}

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

function getAutomaticPaperContextSignature() {
  return getAutomaticPaperContextEntries().map(getPaperContextKey).join("|");
}

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

function getPaperContextMeta(entry: PaperContextEntry) {
  return [entry.firstCreator, entry.year].filter(Boolean).join(" · ");
}

function getPaperContextKey(reference: PaperReference) {
  return `${reference.libraryID}:${reference.itemKey}`;
}

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

function toggleMetadataPopover(control: HTMLElement) {
  const open = !control.classList.contains("zai-metadata-control-open");
  if (open) {
    openMetadataPopover(control);
  } else {
    closeMetadataPopover(control);
  }
}

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

function closeMetadataPopover(control: HTMLElement) {
  const button = control.querySelector<HTMLButtonElement>(
    ".zai-metadata-button",
  );
  const popover = control.querySelector<HTMLElement>(".zai-metadata-popover");

  control.classList.remove("zai-metadata-control-open");
  button?.setAttribute("aria-expanded", "false");
  popover?.setAttribute("hidden", "");
}

function closeOtherMetadataPopovers(control: HTMLElement) {
  control.ownerDocument
    .querySelectorAll<HTMLElement>(".zai-metadata-control-open")
    .forEach((openControl) => {
      if (openControl !== control) {
        closeMetadataPopover(openControl);
      }
    });
}

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

function getProviderButtonValue(button: HTMLButtonElement): LLMProvider {
  return button.dataset.provider === "ollama" ? "ollama" : "kisski";
}

function setActiveProvider(provider: LLMProvider) {
  const currentProvider = getActiveProvider();
  if (provider !== currentProvider) {
    addon.data.settings.provider = provider;
    savePluginPreference("provider", provider);
    addon.api.configureAI();
    addon.api.configureEmbeddings();
  }

  syncAllModelPickers();
  void ensureModelOptionsLoaded(provider);
  void revalidateCurrentReadiness(true);
}

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

function confirmTerminateOllama(host: HTMLElement) {
  const win = host.ownerDocument.defaultView;
  if (!win) return false;

  return win.confirm(
    "Ollama vollständig beenden? Dadurch werden auch Ollama-Prozesse beendet, die nicht von ZAIA gestartet wurden.",
  );
}

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

function ensureProviderConnectionChecked(provider: LLMProvider) {
  const connection = addon.data.runtime.providerConnections[provider];
  if (connection) {
    renderAllHosts();
    return;
  }

  void checkProviderConnection(provider, false);
}

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

function getRequiredOllamaSetupMode(): OllamaSetupMode {
  if (getActiveProvider() === "kisski") return "embedding";
  return addon.data.settings.embeddingSearchEnabled
    ? "local-with-embedding"
    : "local";
}

async function launchOllamaSetup(
  mode: OllamaSetupMode = getRequiredOllamaSetupMode(),
) {
  if (ollamaSetupLaunchRunning) return;

  ollamaSetupLaunchRunning = true;
  renderAllHosts();

  try {
    await addon.api.launchOllamaSetup(mode);
    ollamaSetupAwaitingCompletion = true;
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    const currentConnection = addon.data.runtime.providerConnections.ollama;
    addon.data.runtime.providerConnections.ollama = {
      ...(currentConnection ??
        createProviderConnectionResult("ollama", "error")),
      status: "error",
      ok: false,
      issue: "unknown-error",
      error: error instanceof Error ? error.message : String(error),
      message: getString("sidebar-launch-ollama-setup-failed"),
    };
  } finally {
    ollamaSetupLaunchRunning = false;
    renderAllHosts();
  }
}

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
      issue: "unknown-error",
      error: error instanceof Error ? error.message : String(error),
      message: getString("sidebar-start-ollama-failed"),
    };
  } finally {
    ollamaStartRunning = false;
    renderAllHosts();
  }
}

async function refreshOllamaDependentConnections() {
  await waitForOllamaConnection();
  await checkEmbeddingConnection(true);
}

/**
 * Pulls a model straight from the sidebar's setup card, the same way the
 * local model window does it (direct `pullModel` call with streamed
 * progress) instead of shelling out to the external setup script.
 */
async function pullSetupModel(
  target: SetupModelDownloadTarget,
  model: string,
  win: Window,
) {
  if (setupModelDownloads.get(target)?.status === "downloading") return;

  const provider = addon.api.ai.getProvider("ollama");
  if (typeof provider.pullModel !== "function") return;

  // Must be created from the same window whose fetch() will actually send
  // the request - Gecko rejects an AbortSignal from a different global
  // ("'signal' member of RequestInit does not implement interface
  // AbortSignal"), which is exactly what happened when this used the
  // generic, window-agnostic AbortController before.
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
          // Ollama streams a progress line every few KB, which can be many
          // times a second - re-rendering the whole sidebar that often
          // would block the tab reading the response and stall the
          // download. A render every 300ms is still smooth.
          const now = Date.now();
          if (!progress.done && now - lastProgressRenderAt < 300) {
            return;
          }
          lastProgressRenderAt = now;
          renderAllHosts();
        } catch (renderError) {
          // A bug in the progress UI must never bubble up into pullModel's
          // stream-reading loop, where it would get misread as a network
          // failure and abort an otherwise healthy download.
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
    // AIProviderResponseError's own message is a generic summary; the real
    // underlying cause (e.g. the actual network/parse error) is chained via
    // `.cause`. Log it too so a recurring report can be root-caused from
    // Zotero's error console instead of guessing from the friendly text.
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function isLocalEmbeddingModel(model: string) {
  const value = model.trim().toLowerCase();
  if (!value) return false;

  return (
    value === REQUIRED_EMBEDDING_MODEL.toLowerCase() ||
    /(^|[-_/.:])embed(?:ding)?($|[-_/.:])/i.test(value)
  );
}

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

function sortModelOptions(options: ModelOption[]) {
  return [...options].sort((a, b) =>
    compareModelNames(a.name || a.id, b.name || b.id),
  );
}

function compareModelNames(a: string, b: string) {
  return a.localeCompare(b, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

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

function selectModelDropdownValue(dropdown: HTMLElement, value: string) {
  const provider = getDropdownProvider(dropdown);
  setProviderModel(provider, value);
  closeModelDropdown(dropdown);
  syncAllModelPickers();
}

function getDropdownProvider(dropdown: HTMLElement): LLMProvider {
  return dropdown.dataset.provider === "ollama" ? "ollama" : "kisski";
}

function setProviderModel(provider: LLMProvider, value: string) {
  const model = value.trim();
  if (!model) return;

  if (provider === "ollama") {
    addon.data.settings.ollamaModel = model;
    savePluginPreference("ollamaModel", model);
  } else {
    addon.data.settings.model = model;
    savePluginPreference("model", model);
  }

  addon.api.ai.setModel(model, provider);
  delete addon.data.runtime.providerConnections[provider];
  if (provider === getActiveProvider()) {
    addon.api.configureAI();
    addon.api.configureEmbeddings();
    void revalidateCurrentReadiness(true);
  }
}

function getProviderLabel(provider: LLMProvider) {
  return provider === "ollama" ? "Lokal" : "Cloud";
}

function savePluginPreference(key: string, value: string) {
  Zotero.Prefs.set(`${addon.data.config.prefsPrefix}.${key}`, value, true);
}

function toggleModelDropdown(dropdown: HTMLElement) {
  const open = !dropdown.classList.contains("zai-model-select-wrap-open");
  if (open) {
    openModelDropdown(dropdown);
  } else {
    closeModelDropdown(dropdown);
  }
}

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

function closeOtherModelDropdowns(dropdown: HTMLElement) {
  dropdown.ownerDocument
    .querySelectorAll<HTMLElement>(".zai-model-select-wrap-open")
    .forEach((openDropdown) => {
      if (openDropdown !== dropdown) {
        closeModelDropdown(openDropdown);
      }
    });
}

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

function getModelDropdownOptionButtons(dropdown: HTMLElement) {
  return Array.from(
    dropdown.querySelectorAll(".zai-model-select-option"),
  ) as unknown as HTMLButtonElement[];
}

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

function setSimulationEnabled(enabled: boolean) {
  simulationEnabled = enabled;
  renderAllHosts();
  Zotero.debug(
    `[Zotero AI Simulation] ${enabled ? "aktiviert" : "deaktiviert"}`,
  );
  return getSimulationState();
}

function getSimulationState() {
  return {
    enabled: simulationEnabled,
    pendingPrompts: pendingSimulationPrompts.map((prompt) => ({ ...prompt })),
  };
}

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
