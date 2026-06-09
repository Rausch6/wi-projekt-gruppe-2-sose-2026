type ChatRole = "user" | "assistant" | "error";

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

const hosts = new Set<HTMLElement>();
const messages: AssistantChatMessage[] = [];
const pendingSimulationPrompts: PendingSimulationPrompt[] = [];

let nextMessageID = 1;
let simulationEnabled = false;
let requestRunning = false;
let activeAssistantResponse: ActiveAssistantResponse | null = null;

export function bindAssistantChat(host: HTMLElement) {
  hosts.add(host);

  const textarea = host.querySelector<HTMLTextAreaElement>(".zai-input");
  const sendButton = host.querySelector<HTMLButtonElement>(".zai-send-button");
  const modelSelect =
    host.querySelector<HTMLSelectElement>(".zai-model-select");

  syncModelSelect(modelSelect);
  renderHost(host);

  const sendCurrentPrompt = () => {
    const prompt = textarea?.value.trim() ?? "";
    if (!prompt || requestRunning) return;

    if (textarea) textarea.value = "";
    void sendChatPrompt(prompt).catch(() => {
      // The error is already rendered as a chat message.
    });
  };

  sendButton?.addEventListener("click", sendCurrentPrompt);
  textarea?.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      sendCurrentPrompt();
    }
  });
  modelSelect?.addEventListener("change", () => {
    if (modelSelect.value) {
      addon.api.ai.setModel(modelSelect.value, "kisski");
    }
  });
}

export async function sendChatPrompt(prompt: string) {
  const content = prompt.trim();
  if (!content) {
    throw new Error("Der Prompt darf nicht leer sein.");
  }

  const userMessage = appendMessage("user", content);

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

export function clearChat() {
  messages.length = 0;
  pendingSimulationPrompts.length = 0;
  activeAssistantResponse = null;
  renderAllHosts();
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
  const seeAll = host.querySelector<HTMLElement>(".zai-see-all");
  const sendButton = host.querySelector<HTMLButtonElement>(".zai-send-button");
  const textarea = host.querySelector<HTMLTextAreaElement>(".zai-input");
  const status = host.querySelector<HTMLElement>(".zai-chat-status");

  if (!main || !messageList) return;

  const showWelcome = !hasRealChatMessages();
  top?.classList.toggle("zai-top-chat-active", !showWelcome);
  main.classList.toggle("zai-main-empty", showWelcome);
  main.classList.toggle("zai-main-chat-active", !showWelcome);
  welcome?.toggleAttribute("hidden", !showWelcome);
  chatList?.toggleAttribute("hidden", !showWelcome);
  seeAll?.toggleAttribute("hidden", !showWelcome);

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

  const doc = host.ownerDocument!;
  const wrapper = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "article",
  ) as HTMLElement;
  wrapper.className = `zai-message zai-message-${message.role}`;

  const label = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "strong",
  ) as HTMLElement;
  label.className = "zai-message-label";
  label.textContent =
    message.role === "user"
      ? "Du"
      : message.role === "assistant"
        ? "ZAIA"
        : "Fehler";

  const content = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  content.className = "zai-message-content";
  content.textContent = message.content;

  wrapper.append(label, content);
  return wrapper;
}

function createActivityElement(host: HTMLElement, text: string) {
  const element = host.ownerDocument!.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  element.className = "zai-activity-line";
  element.textContent = text;
  return element;
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
