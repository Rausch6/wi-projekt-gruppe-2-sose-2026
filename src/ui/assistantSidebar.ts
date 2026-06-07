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
}

function createSidebar(doc: Document) {
  const sidebar = createHtmlElement(doc, "section", "zai-sidebar");
  sidebar.setAttribute("aria-label", "Zotero AI Assistent");

  const top = createHtmlElement(doc, "div", "zai-top");
  const title = createHtmlElement(
    doc,
    "h1",
    "zai-title",
    "Zotero AI Assistent",
  );
  const divider = createHtmlElement(doc, "div", "zai-divider");
  divider.setAttribute("aria-hidden", "true");

  const chatList = createHtmlElement(doc, "div", "zai-chat-list");
  [
    "Machine Learning Papers",
    "Neuronale Netzwerke Übersicht",
    "Konzeptuelle Modelle & KI",
  ].forEach((label) => {
    const entry = createButton(doc, "zai-chat-entry", label);
    chatList.append(entry);
  });

  const seeAll = createButton(doc, "zai-see-all", "Alle ansehen");
  top.append(title, divider, chatList, seeAll);

  const main = createHtmlElement(doc, "main", "zai-main");
  const welcome = createHtmlElement(doc, "div", "zai-welcome");
  const welcomeTitle = createHtmlElement(
    doc,
    "h2",
    "zai-welcome-title",
    "Willkommen beim Zotero AI Assistenten",
  );
  const welcomeText = createHtmlElement(
    doc,
    "p",
    "zai-welcome-text",
    "Wählen Sie einen Chat aus oder stellen Sie eine Frage zu Ihrer Bibliothek.",
  );
  welcome.append(welcomeTitle, welcomeText);
  main.append(welcome);

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
  modelSelect.setAttribute("aria-label", "KI-Modell auswählen");
  ["Cloud (GPT-4o)", "Lokal (Ollama)", "Cloud (Claude 3.5)"].forEach(
    (label) => {
      const option = createHtmlElement(doc, "option", undefined, label);
      option.setAttribute("value", label);
      modelSelect.append(option);
    },
  );
  modelWrap.append(modelSelect);

  const sendButton = createButton(doc, "zai-send-button");
  sendButton.setAttribute("aria-label", "Nachricht senden");
  sendButton.append(createSendIcon(doc));

  composerFooter.append(modelWrap, sendButton);
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
