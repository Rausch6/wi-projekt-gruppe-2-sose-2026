import { ChatRepository } from "../core/ChatRepository";
import { ItemManager } from "../core/ItemManager";
import { CreateChatInput, StoredChat } from "../core/chatTypes";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_GENERATED_TITLE_LENGTH = 80;
const TITLE_GENERATION_SYSTEM_PROMPT =
  "Erstelle einen kurzen, präzisen Chat-Titel auf Deutsch. " +
  "Maximal 6 Wörter. Gib ausschließlich den Titel zurück, ohne Anführungszeichen, ohne Einleitung und ohne Punkt am Ende.";

type ChatRole = "user" | "assistant" | "system" | "error";

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

const hosts = new Set<HTMLElement>();
const messages: AssistantChatMessage[] = [];
const chatSummaries: StoredChat[] = [];
const pendingSimulationPrompts: PendingSimulationPrompt[] = [];

let nextMessageID = 1;
let activeChatID: string | null = null;
let showAllChats = false;
let chatSummariesLoaded = false;
let simulationEnabled = false;
let requestRunning = false;
let activeAssistantResponse: ActiveAssistantResponse | null = null;

export function bindAssistantChat(host: HTMLElement) {
  hosts.add(host);

  const textarea = host.querySelector<HTMLTextAreaElement>(".zai-input");
  const sendButton = host.querySelector<HTMLButtonElement>(".zai-send-button");
  const chatList = host.querySelector<HTMLElement>(".zai-chat-list");
  const seeAllButton = host.querySelector<HTMLButtonElement>(".zai-see-all");
  const backButton = host.querySelector<HTMLButtonElement>(
    ".zai-chat-back-button",
  );
  const modelSelect =
    host.querySelector<HTMLSelectElement>(".zai-model-select");

  syncModelSelect(modelSelect);
  if (!activeChatID) invalidateChatSummaries();
  renderHost(host);
  void refreshChatSummaries(true).catch((error) => {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  });

  const sendCurrentPrompt = () => {
    const prompt = textarea?.value.trim() ?? "";
    if (!prompt || requestRunning) return;

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
  textarea?.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      sendCurrentPrompt();
    }
  });
  modelSelect?.addEventListener("change", () => {
    updateModelSelectDisplay(modelSelect);
    if (modelSelect.value) {
      addon.api.ai.setModel(modelSelect.value, "kisski");
    }
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

  const chat = await ensureActiveChat(content);
  const chatID = chat.chatID;
  const userMessage = appendMessage("user", content);
  await persistChatMessage(chatID, userMessage);

  if (chat.shouldGenerateTitle && !simulationEnabled) {
    scheduleGeneratedChatTitle(chatID, content);
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
      createRequestMessages(),
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
  showAllChats = false;
  await refreshChatSummaries(false);

  if (activeChatID === chatID) {
    activeChatID = null;
    showAllChats = false;
    resetMessages();
  }

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

async function requestAssistantResponse(
  requestMessages: Array<{ role: "user" | "assistant"; content: string }>,
) {
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
  requestMessages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  let assistantMessage: AssistantChatMessage | null = null;

  for await (const event of addon.api.ai.chatStream(requestMessages, {
    providerId: "kisski",
    model: addon.data.settings.model,
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
  requestMessages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  const result = (await addon.api.ai.chat(requestMessages, {
    providerId: "kisski",
    model: addon.data.settings.model,
  })) as { content?: unknown };

  if (typeof result?.content !== "string" || !result.content.trim()) {
    throw new Error("ZAIA hat keine Textantwort zurückgegeben.");
  }

  const assistantMessage = appendAssistantDelta(result.content.trim());
  return finalizeActiveAssistantMessage() ?? assistantMessage ?? failNoAnswer();
}

function createRequestMessages() {
  const requestMessages: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [];

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

function scheduleGeneratedChatTitle(chatID: string, firstPrompt: string) {
  void generateChatTitle(chatID, firstPrompt).catch((error) => {
    Zotero.debug(`ZAIA: Chat-Titel konnte nicht generiert werden: ${error}`);
  });
}

async function generateChatTitle(chatID: string, firstPrompt: string) {
  const result = (await addon.api.ai.chat(
    [
      {
        role: "system",
        content: TITLE_GENERATION_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: firstPrompt,
      },
    ],
    {
      providerId: "kisski",
      model: addon.data.settings.model,
      temperature: 0.2,
      maxTokens: 24,
    },
  )) as { content?: unknown };
  const title = normalizeGeneratedChatTitle(result?.content);

  if (!title) return;

  await ChatRepository.updateChatTitle(chatID, title);
  await refreshChatSummaries(true);
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
  const seeAll = host.querySelector<HTMLButtonElement>(".zai-see-all");
  const activeChatBar = host.querySelector<HTMLElement>(".zai-active-chat-bar");
  const activeChatTitle = host.querySelector<HTMLElement>(
    ".zai-active-chat-title",
  );
  const backButton = host.querySelector<HTMLButtonElement>(
    ".zai-chat-back-button",
  );
  const sendButton = host.querySelector<HTMLButtonElement>(".zai-send-button");
  const textarea = host.querySelector<HTMLTextAreaElement>(".zai-input");
  const status = host.querySelector<HTMLElement>(".zai-chat-status");

  if (!main || !messageList) return;

  const showWelcome = !activeChatID;
  const showChat = !showWelcome;
  top?.classList.toggle("zai-top-chat-active", showChat);
  main.classList.toggle("zai-main-empty", showWelcome);
  main.classList.toggle("zai-main-chat-active", showChat);
  welcome?.toggleAttribute("hidden", !showWelcome);
  messageList.toggleAttribute("hidden", showWelcome);
  chatList?.toggleAttribute("hidden", !showWelcome);
  seeAll?.toggleAttribute("hidden", !showWelcome || chatSummaries.length <= 3);
  activeChatBar?.toggleAttribute("hidden", !showChat);

  if (activeChatTitle) {
    const title = getActiveChatTitle();
    activeChatTitle.textContent = title;
    activeChatTitle.title = title;
  }
  if (backButton) backButton.disabled = requestRunning;
  if (seeAll) {
    seeAll.textContent = showAllChats ? "Weniger anzeigen" : "Alle ansehen";
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

  if (sendButton) sendButton.disabled = requestRunning;
  if (textarea) textarea.disabled = requestRunning;

  if (status) {
    const statusText = simulationEnabled
      ? pendingSimulationPrompts.length
        ? `Simulation: ${pendingSimulationPrompts.length} Antwort(en) ausstehend`
        : "Simulation aktiv"
      : requestRunning
        ? "ZAIA antwortet"
        : "";
    status.textContent = statusText;
    status.toggleAttribute("hidden", !statusText);
    status.classList.toggle("zai-chat-status-simulation", simulationEnabled);
  }

  main.scrollTop = showWelcome ? 0 : main.scrollHeight;
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
  content.textContent = message.content;

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
  if (!activeChatID) return "";

  const chat = chatSummaries.find((entry) => entry.id === activeChatID);
  return chat?.title || "Unbenannter Chat";
}

function formatRelativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";

  const elapsedMinutes = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 60_000),
  );
  if (elapsedMinutes < 1) return "<1 min";
  if (elapsedMinutes < 60) return `${elapsedMinutes} min`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} h`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays} t`;

  return `${Math.floor(elapsedDays / 7)} w`;
}

function syncModelSelect(select: HTMLSelectElement | null) {
  if (!select) return;

  const option = select.ownerDocument!.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "option",
  ) as HTMLOptionElement;
  option.value = addon.data.settings.model;
  option.textContent = addon.data.settings.model;
  option.selected = true;
  select.replaceChildren(option);
  updateModelSelectDisplay(select);
}

function updateModelSelectDisplay(select: HTMLSelectElement | null) {
  if (!select) return;

  const value = select.selectedOptions[0]?.textContent || select.value;
  const display = select.parentElement?.querySelector<HTMLElement>(
    ".zai-model-select-value",
  );
  if (!display) return;

  display.textContent = value;
  display.title = value;
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
