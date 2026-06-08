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

const hosts = new Set<HTMLElement>();
const messages: AssistantChatMessage[] = [];
const pendingSimulationPrompts: PendingSimulationPrompt[] = [];

let nextMessageID = 1;
let simulationEnabled = false;
let requestRunning = false;

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
  renderAllHosts();

  try {
    const requestMessages = messages
      .filter((message) => message.role !== "error")
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));
    const result = (await addon.api.ai.chat(requestMessages, {
      providerId: "kisski",
      model: addon.data.settings.model,
    })) as { content?: unknown };

    if (typeof result?.content !== "string" || !result.content.trim()) {
      throw new Error("KISSKI hat keine Textantwort zurückgegeben.");
    }

    return appendMessage("assistant", result.content.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendMessage("error", `Anfrage fehlgeschlagen: ${message}`);
    throw error;
  } finally {
    requestRunning = false;
    renderAllHosts();
  }
}

export function getChatMessages() {
  return messages.map((message) => ({ ...message }));
}

export function clearChat() {
  messages.length = 0;
  pendingSimulationPrompts.length = 0;
  renderAllHosts();
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
  const welcome = host.querySelector<HTMLElement>(".zai-welcome");
  const messageList = host.querySelector<HTMLElement>(".zai-messages");
  const sendButton = host.querySelector<HTMLButtonElement>(".zai-send-button");
  const textarea = host.querySelector<HTMLTextAreaElement>(".zai-input");
  const status = host.querySelector<HTMLElement>(".zai-chat-status");

  if (!main || !messageList) return;

  const showWelcome = messages.length === 0;
  main.classList.toggle("zai-main-empty", showWelcome);
  welcome?.toggleAttribute("hidden", !showWelcome);
  messageList.replaceChildren(
    ...messages.map((message) => createMessageElement(host, message)),
  );

  if (requestRunning) {
    messageList.append(
      createStatusMessage(host, "KISSKI erstellt eine Antwort..."),
    );
  }

  if (sendButton) sendButton.disabled = requestRunning;
  if (textarea) textarea.disabled = requestRunning;

  if (status) {
    status.textContent = simulationEnabled
      ? pendingSimulationPrompts.length
        ? `Simulation: ${pendingSimulationPrompts.length} Antwort(en) ausstehend`
        : "Simulation aktiv"
      : "KISSKI Cloud";
    status.classList.toggle("zai-chat-status-simulation", simulationEnabled);
  }

  main.scrollTop = showWelcome ? 0 : main.scrollHeight;
}

function createMessageElement(
  host: HTMLElement,
  message: AssistantChatMessage,
) {
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
        ? "KI"
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

function createStatusMessage(host: HTMLElement, text: string) {
  const element = host.ownerDocument!.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as HTMLElement;
  element.className = "zai-message zai-message-pending";
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
  option.textContent = `KISSKI: ${addon.data.settings.model}`;
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
