import { config } from "../../package.json";
import { bindAssistantChat } from "./assistantChatController";
import { openPreferencesPane } from "../modules/preferences";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

export function renderAssistantSidebar(host: HTMLElement) {
  const doc = host.ownerDocument;
  if (!doc) {
    return;
  }

  host.classList.remove("makeItRed");
  host.classList.add("zotero-ai-assistant-host");
  host.replaceChildren(createSidebar(doc));
  bindAssistantChat(host);
}

function createSidebar(doc: Document) {
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
  headerActions.append(aboutButton, settingsButton);
  header.append(title, headerActions);

  const divider = createHtmlElement(doc, "div", "zai-divider");
  divider.setAttribute("aria-hidden", "true");

  const chatList = createHtmlElement(doc, "div", "zai-chat-list");
  [
    "Machine Learning Papers",
    "Neuronale Netzwerke Übersicht",
    "Konzeptuelle Modelle",
  ].forEach((label) => {
    const entry = createButton(doc, "zai-chat-entry", label);
    chatList.append(entry);
  });

  const seeAll = createButton(doc, "zai-see-all", "Alle ansehen");
  top.append(header, divider, chatList, seeAll);

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
  const modelWrap = createHtmlElement(doc, "label", "zai-model-select-wrap");
  const modelSelect = createHtmlElement(
    doc,
    "select",
    "zai-model-select",
  ) as HTMLSelectElement;
  modelSelect.setAttribute("aria-label", "Modell auswählen");
  ["Cloud (GPT-4o)", "Lokal (Ollama)", "Cloud (Claude 3.5)"].forEach(
    (label) => {
      const option = createHtmlElement(doc, "option", undefined, label);
      option.setAttribute("value", label);
      modelSelect.append(option);
    },
  );
  modelWrap.append(modelSelect);

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
  return button;
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
