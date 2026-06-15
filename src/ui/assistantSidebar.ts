import { config } from "../../package.json";
import { bindAssistantChat } from "./assistantChatController";
import { openPreferencesPane } from "../modules/preferences";
import { ASSISTANT_POPOUT_REQUEST_EVENT } from "./assistantPopoutEvents";
import type { LLMProvider } from "../addon";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

type AssistantSidebarRenderOptions = {
  showPopoutButton?: boolean;
};

export function renderAssistantSidebar(
  host: HTMLElement,
  options: AssistantSidebarRenderOptions = {},
) {
  const doc = host.ownerDocument;
  if (!doc) {
    return;
  }

  host.classList.remove("makeItRed");
  host.classList.add("zotero-ai-assistant-host");
  host.replaceChildren(createSidebar(doc, options));
  bindAssistantChat(host);
}

function createSidebar(doc: Document, options: AssistantSidebarRenderOptions) {
  const sidebar = createHtmlElement(doc, "section", "zai-sidebar");
  sidebar.setAttribute("aria-label", "Zotero AI Assistent");

  const top = createHtmlElement(doc, "div", "zai-top");
  const header = createHtmlElement(doc, "div", "zai-header");
  const title = createHtmlElement(
    doc,
    "h1",
    "zai-title",
    "ZAIA – Zotero AI Assistent",
  );
  const headerActions = createHtmlElement(doc, "div", "zai-header-actions");
  const aboutButton = createButton(doc, "zai-header-icon-button");
  aboutButton.setAttribute("aria-label", "Über ZAIA");
  aboutButton.setAttribute("title", "Über ZAIA");
  aboutButton.append(createQuestionIcon(doc));

  const settingsButton = createButton(doc, "zai-header-icon-button");
  settingsButton.setAttribute("aria-label", "Einstellungen");
  settingsButton.setAttribute("title", "Einstellungen");
  settingsButton.addEventListener("click", () => {
    openPreferencesPane();
  });
  settingsButton.append(createGearIcon(doc));
  headerActions.append(aboutButton);
  if (options.showPopoutButton !== false) {
    headerActions.append(createPopoutButton(doc));
  }
  headerActions.append(settingsButton);
  header.append(title, headerActions);

  const providerToggle = createProviderToggle(doc);
  const activeChatBar = createHtmlElement(doc, "div", "zai-active-chat-bar");
  activeChatBar.hidden = true;
  const backButton = createButton(doc, "zai-chat-back-button");
  backButton.setAttribute("aria-label", "Zurück zur Startansicht");
  backButton.setAttribute("title", "Zurück");
  backButton.append(createBackIcon(doc));
  const activeChatTitle = createHtmlElement(
    doc,
    "div",
    "zai-active-chat-title",
  );
  const activeChatActions = createHtmlElement(
    doc,
    "div",
    "zai-active-chat-actions",
  );
  const favoriteButton = createButton(
    doc,
    "zai-chat-action-button zai-chat-favorite-button",
  );
  favoriteButton.setAttribute("aria-label", "Chat favorisieren");
  favoriteButton.setAttribute("aria-pressed", "false");
  favoriteButton.setAttribute("title", "Chat favorisieren");
  favoriteButton.append(createHeartIcon(doc));
  const deleteButton = createButton(
    doc,
    "zai-chat-action-button zai-chat-delete-button",
  );
  deleteButton.setAttribute("aria-label", "Chat löschen");
  deleteButton.setAttribute("title", "Chat löschen");
  deleteButton.append(createTrashIcon(doc));
  activeChatActions.append(favoriteButton, deleteButton);
  activeChatBar.append(backButton, activeChatTitle, activeChatActions);

  const divider = createHtmlElement(doc, "div", "zai-divider");
  divider.setAttribute("aria-hidden", "true");

  const chatList = createHtmlElement(doc, "div", "zai-chat-list");

  const seeAll = createButton(doc, "zai-see-all", "Alle ansehen");
  top.append(header, providerToggle, divider, activeChatBar, chatList, seeAll);

  const main = createHtmlElement(doc, "main", "zai-main");
  const welcome = createHtmlElement(doc, "div", "zai-welcome");
  const welcomeLogo = createHtmlElement(
    doc,
    "img",
    "zai-welcome-logo",
  ) as HTMLImageElement;
  welcomeLogo.alt = "ZAIA";
  welcomeLogo.src = `chrome://${config.addonRef}/content/icons/LogoPlugin.png`;
  const welcomeTitle = createHtmlElement(
    doc,
    "h2",
    "zai-welcome-title",
    "Willkommen bei ZAIA",
  );
  const welcomeText = createHtmlElement(
    doc,
    "p",
    "zai-welcome-text",
    "Dein Zotero AI Assistent für Fragen, Zusammenfassungen und Recherche in deiner Bibliothek.",
  );
  welcome.append(welcomeLogo, welcomeTitle, welcomeText);
  const messages = createHtmlElement(doc, "div", "zai-messages");
  messages.setAttribute("aria-live", "polite");
  main.append(welcome, messages);

  const footer = createHtmlElement(doc, "footer", "zai-footer");
  const actions = createHtmlElement(doc, "div", "zai-actions");
  ["Tags suchen", "Autor suchen", "Abstract lesen"].forEach((label) => {
    actions.append(createButton(doc, "zai-action-pill", label));
  });

  const composer = createHtmlElement(doc, "div", "zai-composer");
  const textarea = createHtmlElement(
    doc,
    "textarea",
    "zai-input",
  ) as HTMLTextAreaElement;
  textarea.placeholder = "Frag etwas zur Bibliothek...";
  textarea.rows = 3;

  const composerFooter = createHtmlElement(doc, "div", "zai-composer-footer");
  const modelWrap = createHtmlElement(doc, "div", "zai-model-select-wrap");
  const modelSelect = createButton(doc, "zai-model-select");
  modelSelect.setAttribute("aria-expanded", "false");
  modelSelect.setAttribute("aria-haspopup", "listbox");
  modelSelect.setAttribute("aria-label", "Modell auswählen");
  const modelValue = createHtmlElement(
    doc,
    "span",
    "zai-model-select-value",
    "Cloud (GPT-4o)",
  );
  const modelOptions = createHtmlElement(
    doc,
    "div",
    "zai-model-select-options",
  );
  modelOptions.hidden = true;
  modelOptions.setAttribute("role", "listbox");
  modelSelect.append(modelValue);
  modelWrap.append(modelSelect, modelOptions);

  const chatStatus = createHtmlElement(doc, "span", "zai-chat-status", "");
  chatStatus.hidden = true;
  const sendButton = createButton(doc, "zai-send-button");
  sendButton.setAttribute("aria-label", "Nachricht senden");
  sendButton.append(createSendIcon(doc));

  composerFooter.append(modelWrap, chatStatus, sendButton);
  composer.append(textarea, composerFooter);
  footer.append(actions, composer);

  sidebar.append(top, main, footer);
  return sidebar;
}

function createButton(doc: Document, className: string, text?: string) {
  const button = createHtmlElement(doc, "button", className, text);
  button.setAttribute("type", "button");
  return button as HTMLButtonElement;
}

function createPopoutButton(doc: Document) {
  const popoutButton = createButton(
    doc,
    "zai-header-icon-button zai-header-popout-button",
  );
  popoutButton.dataset.zaiPopoutButton = "true";
  popoutButton.setAttribute("aria-label", "ZAIA in eigenem Fenster öffnen");
  popoutButton.setAttribute("aria-pressed", "false");
  popoutButton.setAttribute("title", "ZAIA in eigenem Fenster öffnen");
  popoutButton.addEventListener("click", () => {
    const view = doc.defaultView;
    if (!view) return;

    view.dispatchEvent(new view.CustomEvent(ASSISTANT_POPOUT_REQUEST_EVENT));
  });
  popoutButton.append(createPopoutIcon(doc));
  return popoutButton;
}

function createProviderToggle(doc: Document) {
  const toggle = createHtmlElement(doc, "div", "zai-provider-toggle");
  toggle.setAttribute("role", "group");
  toggle.setAttribute("aria-label", "LLM Anbieter auswählen");

  const cloudButton = createButton(doc, "zai-provider-toggle-button", "Cloud");
  cloudButton.dataset.provider = "kisski";

  const localButton = createButton(doc, "zai-provider-toggle-button", "Lokal");
  localButton.dataset.provider = "ollama";

  const buttons = [cloudButton, localButton];
  syncProviderToggleButtons(buttons, addon.data.settings.provider);

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const provider = getToggleProvider(button);
      addon.data.settings.provider = provider;
      saveProviderPreference(provider);
      addon.api.configureAI();
      syncProviderToggleButtons(buttons, provider);
    });
  }

  toggle.append(cloudButton, localButton);
  return toggle;
}

function getToggleProvider(button: HTMLButtonElement): LLMProvider {
  return button.dataset.provider === "ollama" ? "ollama" : "kisski";
}

function syncProviderToggleButtons(
  buttons: HTMLButtonElement[],
  provider: LLMProvider,
) {
  for (const button of buttons) {
    const isActive = getToggleProvider(button) === provider;
    button.classList.toggle("zai-provider-toggle-button-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function saveProviderPreference(provider: LLMProvider) {
  Zotero.Prefs.set(`${addon.data.config.prefsPrefix}.provider`, provider, true);
}

function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tagName: K,
  className?: string,
  text?: string,
) {
  const element = doc.createElementNS(HTML_NS, tagName);
  if (className) {
    element.className = className;
  }
  if (text) {
    element.textContent = text;
  }
  return element;
}

function createSendIcon(doc: Document) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M22 2 11 13");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  const polygon = doc.createElementNS(SVG_NS, "path");
  polygon.setAttribute("d", "m22 2-7 20-4-9-9-4 20-7Z");
  polygon.setAttribute("fill", "none");
  polygon.setAttribute("stroke", "currentColor");
  polygon.setAttribute("stroke-width", "2");
  polygon.setAttribute("stroke-linecap", "round");
  polygon.setAttribute("stroke-linejoin", "round");

  svg.append(path, polygon);
  return svg;
}

function createQuestionIcon(doc: Document) {
  const svg = createIconSvg(doc, "18");

  const circle = doc.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "10");

  const question = doc.createElementNS(SVG_NS, "path");
  question.setAttribute("d", "M9.09 9a3 3 0 1 1 5.82 1c0 2-3 2.5-3 4");

  const dot = doc.createElementNS(SVG_NS, "path");
  dot.setAttribute("d", "M12 17h.01");

  svg.append(circle, question, dot);
  return svg;
}

function createGearIcon(doc: Document) {
  const svg = createIconSvg(doc, "18");

  const circle = doc.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "3");

  const gear = doc.createElementNS(SVG_NS, "path");
  gear.setAttribute(
    "d",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.92 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.31.2.65.18 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z",
  );

  svg.append(circle, gear);
  return svg;
}

function createPopoutIcon(doc: Document) {
  const svg = createIconSvg(doc, "18");

  const windowShape = doc.createElementNS(SVG_NS, "path");
  windowShape.setAttribute("d", "M5 5h14a2 2 0 0 1 2 2v12H3V7a2 2 0 0 1 2-2Z");

  const sidebar = doc.createElementNS(SVG_NS, "path");
  sidebar.setAttribute("d", "M8 5v14");

  const arrow = doc.createElementNS(SVG_NS, "path");
  arrow.setAttribute("d", "M13 9h4v4m0-4-6 6");

  svg.append(windowShape, sidebar, arrow);
  return svg;
}

function createBackIcon(doc: Document) {
  const svg = createIconSvg(doc, "18");

  const line = doc.createElementNS(SVG_NS, "path");
  line.setAttribute("d", "M19 12H5");

  const arrow = doc.createElementNS(SVG_NS, "path");
  arrow.setAttribute("d", "m12 19-7-7 7-7");

  svg.append(line, arrow);
  return svg;
}

function createHeartIcon(doc: Document) {
  const svg = createIconSvg(doc, "18");

  const heart = doc.createElementNS(SVG_NS, "path");
  heart.setAttribute(
    "d",
    "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z",
  );

  svg.append(heart);
  return svg;
}

function createTrashIcon(doc: Document) {
  const svg = createIconSvg(doc, "18");

  const lid = doc.createElementNS(SVG_NS, "path");
  lid.setAttribute("d", "M3 6h18");

  const handle = doc.createElementNS(SVG_NS, "path");
  handle.setAttribute("d", "M8 6V4h8v2");

  const bin = doc.createElementNS(SVG_NS, "path");
  bin.setAttribute("d", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6");

  const leftLine = doc.createElementNS(SVG_NS, "path");
  leftLine.setAttribute("d", "M10 11v6");

  const rightLine = doc.createElementNS(SVG_NS, "path");
  rightLine.setAttribute("d", "M14 11v6");

  svg.append(lid, handle, bin, leftLine, rightLine);
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
