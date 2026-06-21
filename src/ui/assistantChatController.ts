import { ChatRepository } from "../core/ChatRepository";
import { ItemManager } from "../core/ItemManager";
import {
  PaperContextService,
  type PaperReference,
} from "../core/PaperContextService";
import { CreateChatInput, StoredChat } from "../core/chatTypes";
import { renderMarkdownContent } from "./markdownRenderer";
import type { LLMProvider } from "../addon";
import { KISSKI_MODEL_OPTIONS } from "../ai/providers/KisskiProvider.js";
import {
  createCheckingProviderConnectionResult,
  createProviderConnectionResult,
  type ProviderConnectionResult,
} from "../ai/providerConnectionStatus";
import { getString } from "../utils/locale";

const HTML_NS = "http://www.w3.org/1999/xhtml";
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

export type AssistantChatMessage = {
  id: number;
  role: ChatRole;
  content: string;
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

const hosts = new Set<HTMLElement>();
const messages: AssistantChatMessage[] = [];
const chatSummaries: StoredChat[] = [];
const pendingSimulationPrompts: PendingSimulationPrompt[] = [];
const pendingGeneratedTitleChatIDs = new Set<string>();
const modelDropdownDocuments = new WeakSet<Document>();
const modelOptionsByProvider = new Map<LLMProvider, ModelOption[]>([
  ["kisski", normalizeModelOptions(KISSKI_MODEL_OPTIONS)],
]);
const modelLoadStates = new Map<LLMProvider, ModelLoadState>();
const providerConnectionRequestIDs = new Map<LLMProvider, number>();

let nextMessageID = 1;
let nextModelLoadRequestID = 1;
let nextProviderConnectionRequestID = 1;
let activeChatID: string | null = null;
let showAllChats = false;
let chatSummariesLoaded = false;
let simulationEnabled = false;
let requestRunning = false;
let modelPickerExpanded = false;
let activeAssistantResponse: ActiveAssistantResponse | null = null;
let ollamaModelPullRunning = false;
let ollamaSetupLaunchRunning = false;
let ollamaStartRunning = false;
let ollamaStopRunning = false;

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
  const modelDropdown = host.querySelector<HTMLElement>(
    ".zai-model-select-wrap",
  );
  const modelButton =
    host.querySelector<HTMLButtonElement>(".zai-model-select");
  const modelPickerToggle = host.querySelector<HTMLButtonElement>(
    ".zai-model-picker-toggle",
  );
  const providerButtons = Array.from(
    host.querySelectorAll(".zai-provider-toggle-button[data-provider]"),
  ) as HTMLButtonElement[];
  const providerCheckButtons = Array.from(
    host.querySelectorAll(
      '.zai-provider-setup-button[data-action="check-provider"][data-provider]',
    ),
  ) as HTMLButtonElement[];
  const ollamaModelPullButtons = Array.from(
    host.querySelectorAll(
      '.zai-provider-setup-button[data-action="pull-ollama-model"]',
    ),
  ) as HTMLButtonElement[];
  const ollamaSetupLaunchButtons = Array.from(
    host.querySelectorAll(
      '.zai-provider-setup-button[data-action="launch-ollama-setup"]',
    ),
  ) as HTMLButtonElement[];
  const ollamaStartButtons = Array.from(
    host.querySelectorAll(
      '.zai-provider-setup-button[data-action="start-ollama"]',
    ),
  ) as HTMLButtonElement[];
  const ollamaStopButtons = Array.from(
    host.querySelectorAll('.zai-stop-ollama-button[data-action="stop-ollama"]'),
  ) as HTMLButtonElement[];

  syncModelPicker(host);
  ensureModelDropdownOutsideHandler(host.ownerDocument);
  void ensureModelOptionsLoaded(getActiveProvider());
  void ensureProviderConnectionChecked(getActiveProvider());
  if (!activeChatID) invalidateChatSummaries();
  renderHost(host);
  void refreshChatSummaries(true).catch((error) => {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  });

  const sendCurrentPrompt = () => {
    hosts.add(host);
    const prompt = textarea?.value.trim() ?? "";
    if (!prompt || requestRunning || !isActiveProviderReady()) return;

    if (textarea) textarea.value = "";
    void sendChatPrompt(prompt).catch(() => {
      // The error is already rendered as a chat message.
    });
  };

  sendButton?.addEventListener("click", sendCurrentPrompt);
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
  for (const providerCheckButton of providerCheckButtons) {
    providerCheckButton.addEventListener("click", () => {
      hosts.add(host);
      void checkProviderConnection(
        getProviderButtonValue(providerCheckButton),
        true,
      );
    });
  }
  for (const ollamaModelPullButton of ollamaModelPullButtons) {
    ollamaModelPullButton.addEventListener("click", () => {
      hosts.add(host);
      void pullOllamaModel();
    });
  }
  for (const ollamaSetupLaunchButton of ollamaSetupLaunchButtons) {
    ollamaSetupLaunchButton.addEventListener("click", () => {
      hosts.add(host);
      void launchOllamaSetup();
    });
  }
  for (const ollamaStartButton of ollamaStartButtons) {
    ollamaStartButton.addEventListener("click", () => {
      hosts.add(host);
      void startOllama();
    });
  }
  for (const ollamaStopButton of ollamaStopButtons) {
    ollamaStopButton.addEventListener("click", () => {
      hosts.add(host);
      void stopOllama();
    });
  }
  modelButton?.addEventListener("click", () => {
    if (!modelDropdown) return;

    hosts.add(host);
    void ensureModelOptionsLoaded(getActiveProvider());
    toggleModelDropdown(modelDropdown);
  });
  modelDropdown?.addEventListener("click", (event) => {
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
}

export async function initializeChatPersistence() {
  await refreshChatSummaries(false);
  activeChatID = null;
  showAllChats = false;
  resetMessages();
  renderAllHosts();
}

export async function sendChatPrompt(prompt: string) {
  const content = prompt.trim();
  if (!content) {
    throw new Error("Der Prompt darf nicht leer sein.");
  }
  if (!isActiveProviderReady()) {
    throw new Error(getString("sidebar-active-provider-not-connected-error"));
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
    pendingSimulationPrompts.push({
      id: userMessage.id,
      content: userMessage.content,
    });
    logSimulationPrompt(userMessage);
    renderAllHosts();
    return userMessage;
  }

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
    const assistantMessage = await requestAssistantResponse(
      await createRequestMessages(content),
    );

    if (!assistantMessage.content.trim()) {
      throw new Error("ZAIA hat keine Textantwort zurückgegeben.");
    }

    await persistChatMessage(chatID, assistantMessage);
    await refreshChatSummaries(false);
    return assistantMessage;
  } catch (error) {
    finalizeActiveAssistantMessage();
    const message = error instanceof Error ? error.message : String(error);
    requestRunning = false;
    activeAssistantResponse = null;
    appendMessage("error", `Anfrage fehlgeschlagen: ${message}`);
    throw error;
  } finally {
    requestRunning = false;
    activeAssistantResponse = null;
    renderAllHosts();
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

async function requestAssistantResponse(requestMessages: RequestMessage[]) {
  if (typeof addon.api.ai.chatStream === "function") {
    try {
      return await requestStreamingAssistantResponse(requestMessages);
    } catch (error) {
      if (
        !activeAssistantResponse?.assistantMessage &&
        shouldFallbackToBufferedChat(error)
      ) {
        return requestBufferedAssistantResponse(requestMessages);
      }
      throw error;
    }
  }

  return requestBufferedAssistantResponse(requestMessages);
}

async function requestStreamingAssistantResponse(
  requestMessages: RequestMessage[],
) {
  let assistantMessage: AssistantChatMessage | null = null;

  for await (const event of addon.api.ai.chatStream(requestMessages, {
    providerId: getActiveProvider(),
    model: getActiveModel(),
  }) as AsyncIterable<{ type?: unknown; content?: unknown }>) {
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

    if (event.type === "done") break;
  }

  return finalizeActiveAssistantMessage() ?? assistantMessage ?? failNoAnswer();
}

async function requestBufferedAssistantResponse(
  requestMessages: RequestMessage[],
) {
  const result = (await addon.api.ai.chat(requestMessages, {
    providerId: getActiveProvider(),
    model: getActiveModel(),
  })) as { content?: unknown };

  if (typeof result?.content !== "string" || !result.content.trim()) {
    throw new Error("ZAIA hat keine Textantwort zurückgegeben.");
  }

  const assistantMessage = appendAssistantDelta(result.content.trim());
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

function getActiveModel(provider: LLMProvider = getActiveProvider()) {
  return provider === "ollama"
    ? addon.data.settings.ollamaModel
    : addon.data.settings.model;
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
    return null;
  }

  const reference = getActivePaperReference();
  if (!reference) return null;

  const context = await PaperContextService.buildContext(reference, prompt);
  if (!context) {
    throw new Error(
      "Paper-Kontext ist aktiviert, aber Zotero konnte keinen Text aus dem verknüpften PDF laden. Prüfe, ob das PDF lokal verfügbar und per OCR durchsuchbar ist.",
    );
  }

  return context.systemMessage;
}

function getActivePaperReference(): PaperReference | null {
  const chat = getActiveChatSummary();
  if (!chat?.zoteroLibraryID || !chat.zoteroItemKey) return null;

  return {
    libraryID: chat.zoteroLibraryID,
    itemKey: chat.zoteroItemKey,
  };
}

function appendAssistantDelta(delta: string) {
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

function appendMessage(role: ChatRole, content: string) {
  const message = {
    id: nextMessageID++,
    role,
    content,
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
  });
}

function resetMessages() {
  messages.length = 0;
  nextMessageID = 1;
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

function renderHost(host: HTMLElement) {
  const main = host.querySelector<HTMLElement>(".zai-main");
  const top = host.querySelector<HTMLElement>(".zai-top");
  const welcome = host.querySelector<HTMLElement>(".zai-welcome");
  const messageList = host.querySelector<HTMLElement>(".zai-messages");
  const chatList = host.querySelector<HTMLElement>(".zai-chat-list");
  const chatListActions = host.querySelector<HTMLElement>(
    ".zai-chat-list-actions",
  );
  const seeAll = host.querySelector<HTMLButtonElement>(".zai-see-all");
  const stopOllamaButtons = Array.from(
    host.querySelectorAll(".zai-stop-ollama-button"),
  ) as HTMLButtonElement[];
  const chatListStopOllamaButton = host.querySelector<HTMLButtonElement>(
    ".zai-chat-list-stop-ollama-button",
  );
  const activeChatStopOllamaButton = host.querySelector<HTMLButtonElement>(
    ".zai-active-chat-stop-ollama-button",
  );
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
  const actionButtons = Array.from(
    host.querySelectorAll(".zai-action-pill"),
  ) as HTMLButtonElement[];
  const sendButton = host.querySelector<HTMLButtonElement>(".zai-send-button");
  const textarea = host.querySelector<HTMLTextAreaElement>(".zai-input");
  const status = host.querySelector<HTMLElement>(".zai-chat-status");

  if (!main || !messageList) return;

  const activeProvider = getActiveProvider();
  const providerConnection =
    addon.data.runtime.providerConnections[activeProvider];
  const providerReady = isProviderConnectionReady(providerConnection);
  const showProviderSetup = shouldShowProviderSetup(providerConnection);
  const showWelcome = !activeChatID && !showProviderSetup;
  const showChat = !showWelcome && !showProviderSetup;
  top?.classList.toggle("zai-top-chat-active", showChat);
  main.classList.toggle("zai-main-empty", showWelcome || showProviderSetup);
  main.classList.toggle("zai-main-chat-active", showChat);
  welcome?.toggleAttribute("hidden", !showWelcome);
  syncProviderSetup(host, activeProvider, providerConnection);
  messageList.toggleAttribute("hidden", !showChat);
  chatList?.toggleAttribute("hidden", !showWelcome);
  const showSeeAll = showWelcome && chatSummaries.length > 3;
  const canStopOllama = activeProvider === "ollama" && providerReady;
  const showChatListStopOllama = showWelcome && canStopOllama;
  const showActiveChatStopOllama = showChat && canStopOllama;
  chatListActions?.toggleAttribute(
    "hidden",
    !showSeeAll && !showChatListStopOllama,
  );
  seeAll?.toggleAttribute("hidden", !showSeeAll);
  chatListStopOllamaButton?.toggleAttribute("hidden", !showChatListStopOllama);
  activeChatStopOllamaButton?.toggleAttribute(
    "hidden",
    !showActiveChatStopOllama,
  );
  activeChatBar?.toggleAttribute("hidden", !showChat);

  if (activeChatTitle) {
    const title = getActiveChatTitle();
    activeChatTitle.textContent = title;
    activeChatTitle.classList.toggle(
      "zai-active-chat-title-pending",
      Boolean(activeChatID && pendingGeneratedTitleChatIDs.has(activeChatID)),
    );
  }
  if (backButton) backButton.disabled = requestRunning;
  const activeChatSummary = getActiveChatSummary();
  const isActiveFavorite = Boolean(activeChatSummary?.isFavorite);
  if (favoriteButton) {
    const favoriteLabel = isActiveFavorite
      ? "Favorit entfernen"
      : "Chat favorisieren";
    favoriteButton.disabled = requestRunning || !activeChatID;
    favoriteButton.setAttribute("aria-label", favoriteLabel);
    favoriteButton.setAttribute("aria-pressed", String(isActiveFavorite));
    favoriteButton.setAttribute("title", favoriteLabel);
  }
  if (deleteButton) {
    deleteButton.disabled = requestRunning || !activeChatID;
  }
  if (seeAll) {
    seeAll.textContent = showAllChats ? "Weniger anzeigen" : "Alle ansehen";
  }
  for (const stopOllamaButton of stopOllamaButtons) {
    const label = ollamaStopRunning
      ? getString("sidebar-stopping-ollama")
      : getString("sidebar-stop-ollama");
    stopOllamaButton.disabled = ollamaStopRunning;
    stopOllamaButton.setAttribute("aria-label", label);
    stopOllamaButton.setAttribute("title", label);
  }
  for (const actionButton of actionButtons) {
    actionButton.disabled = requestRunning || !providerReady;
  }

  if (chatList && showWelcome) renderChatList(host, chatList);

  const renderedMessages = messages
    .map((message) => createMessageElement(host, message))
    .filter((element): element is HTMLElement => Boolean(element));
  messageList.replaceChildren(...renderedMessages);

  const activeActivity = getVisibleActivity();
  if (activeActivity) {
    messageList.append(createActivityElement(host, activeActivity));
  }

  if (sendButton) sendButton.disabled = requestRunning || !providerReady;
  if (textarea) textarea.disabled = requestRunning || !providerReady;

  if (status) {
    const statusText = getComposerStatusText(providerReady);
    status.textContent = statusText;
    status.toggleAttribute("hidden", !statusText);
    status.classList.toggle("zai-chat-status-simulation", simulationEnabled);
  }

  main.scrollTop = showWelcome ? 0 : main.scrollHeight;
}

function shouldShowProviderSetup(
  connection: ProviderConnectionResult | undefined,
) {
  return !isProviderConnectionReady(connection);
}

function isProviderConnectionReady(
  connection: ProviderConnectionResult | undefined,
) {
  return connection?.status === "ready";
}

function getComposerStatusText(providerReady: boolean) {
  if (!providerReady) return getString("sidebar-provider-not-connected");
  if (simulationEnabled) {
    return pendingSimulationPrompts.length
      ? `Simulation: ${pendingSimulationPrompts.length} Antwort(en) ausstehend`
      : "Simulation aktiv";
  }
  return requestRunning ? "ZAIA antwortet" : "";
}

function syncProviderSetup(
  host: HTMLElement,
  provider: LLMProvider,
  connection: ProviderConnectionResult | undefined,
) {
  const setup = host.querySelector<HTMLElement>(".zai-provider-setup");
  if (!setup) return;

  const showSetup = shouldShowProviderSetup(connection);
  setup.toggleAttribute("hidden", !showSetup);

  setup
    .querySelectorAll<HTMLElement>(".zai-provider-setup-panel[data-provider]")
    .forEach((panel) => {
      panel.toggleAttribute(
        "hidden",
        !showSetup || panel.dataset.provider !== provider,
      );
    });

  setup
    .querySelectorAll<HTMLButtonElement>(
      '.zai-provider-setup-button[data-action="check-provider"]',
    )
    .forEach((button) => {
      const isActiveProvider = button.dataset.provider === provider;
      const isChecking = isActiveProvider && connection?.status === "checking";
      button.disabled = isChecking;
      button.textContent = isChecking
        ? getString("sidebar-checking-provider")
        : getString("sidebar-check-provider");
    });

  setup
    .querySelectorAll<HTMLButtonElement>(
      '.zai-provider-setup-button[data-action="pull-ollama-model"]',
    )
    .forEach((button) => {
      const isActiveProvider = provider === "ollama";
      button.disabled = !isActiveProvider || ollamaModelPullRunning;
      button.textContent = ollamaModelPullRunning
        ? getString("sidebar-pulling-ollama-model")
        : getString("sidebar-pull-ollama-model");
    });

  setup
    .querySelectorAll<HTMLButtonElement>(
      '.zai-provider-setup-button[data-action="launch-ollama-setup"]',
    )
    .forEach((button) => {
      const isActiveProvider = provider === "ollama";
      button.disabled = !isActiveProvider || ollamaSetupLaunchRunning;
      button.textContent = ollamaSetupLaunchRunning
        ? getString("sidebar-launching-ollama-setup")
        : getString("sidebar-launch-ollama-setup");
    });

  setup
    .querySelectorAll<HTMLButtonElement>(
      '.zai-provider-setup-button[data-action="start-ollama"]',
    )
    .forEach((button) => {
      const isActiveProvider = provider === "ollama";
      button.disabled = !isActiveProvider || ollamaStartRunning;
      button.textContent = ollamaStartRunning
        ? getString("sidebar-starting-ollama")
        : getString("sidebar-start-ollama");
    });

  setup
    .querySelectorAll<HTMLElement>(".zai-provider-setup-status[data-provider]")
    .forEach((status) => {
      const isActiveProvider = status.dataset.provider === provider;
      const text =
        showSetup && isActiveProvider
          ? getProviderConnectionStatusText(provider, connection)
          : "";
      status.textContent = text;
      status.toggleAttribute("hidden", !text);
    });
}

function getProviderConnectionStatusText(
  provider: LLMProvider,
  connection: ProviderConnectionResult | undefined,
) {
  if (provider === "ollama" && ollamaStopRunning) {
    return getString("sidebar-stopping-ollama");
  }
  if (provider === "ollama" && ollamaStartRunning) {
    return getString("sidebar-starting-ollama");
  }
  if (provider === "ollama" && ollamaSetupLaunchRunning) {
    return getString("sidebar-launching-ollama-setup");
  }
  if (provider === "ollama" && ollamaModelPullRunning) {
    return getString("sidebar-pulling-ollama-model");
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
  const wrapper = doc.createElementNS(HTML_NS, "article") as HTMLElement;
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

  wrapper.append(label, content);
  return wrapper;
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
  }

  syncAllModelPickers();
  void ensureModelOptionsLoaded(provider);
  void checkProviderConnection(provider, true);
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

async function pullOllamaModel() {
  if (ollamaModelPullRunning) return;

  const model = addon.data.settings.ollamaModel.trim();
  if (!model) return;

  ollamaModelPullRunning = true;
  renderAllHosts();

  try {
    addon.api.configureAI();
    const provider = addon.api.ai.getProvider("ollama") as {
      pullModel?: (model: string) => Promise<unknown>;
    };

    if (typeof provider.pullModel !== "function") {
      throw new Error("Ollama provider does not support model downloads.");
    }

    await provider.pullModel(model);
    await checkProviderConnection("ollama", true);
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    const currentConnection = addon.data.runtime.providerConnections.ollama;
    if (currentConnection) {
      addon.data.runtime.providerConnections.ollama = {
        ...currentConnection,
        status: "error",
        ok: false,
        issue: "unknown-error",
        error: error instanceof Error ? error.message : String(error),
        message: getString("sidebar-pull-ollama-model-failed"),
      };
    }
  } finally {
    ollamaModelPullRunning = false;
    renderAllHosts();
  }
}

async function launchOllamaSetup() {
  if (ollamaSetupLaunchRunning) return;

  ollamaSetupLaunchRunning = true;
  renderAllHosts();

  try {
    await addon.api.launchOllamaSetup();
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
    await waitForOllamaConnection();
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

async function stopOllama() {
  if (ollamaStopRunning) return;

  ollamaStopRunning = true;
  renderAllHosts();

  try {
    await addon.api.stopOllama();
    await delay(1_000);
    await checkProviderConnection("ollama", true);
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
      message: getString("sidebar-stop-ollama-failed"),
    };
  } finally {
    ollamaStopRunning = false;
    renderAllHosts();
  }
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
    }
    const models = normalizeModelOptions(
      await addon.api.ai.listModels(provider),
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

function normalizeModelOptions(models: unknown): ModelOption[] {
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
  const values = getModelDropdownValues(models, value);
  const optionNodes = values.map((model) =>
    createModelDropdownOption(dropdown.ownerDocument, model, model === value),
  );
  const stateNode = createModelDropdownState(
    dropdown.ownerDocument,
    provider,
    models.length,
  );

  options.replaceChildren(...optionNodes, ...(stateNode ? [stateNode] : []));
  updateModelDropdownDisplay(dropdown, value, provider);
}

function getModelDropdownValues(models: ModelOption[], selectedValue: string) {
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
  if (provider === getActiveProvider()) {
    addon.api.configureAI();
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
