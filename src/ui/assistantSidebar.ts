import { config } from "../../package.json";
import { bindAssistantChat } from "./assistantChatController";
import { openPreferencesPane } from "../modules/preferences";
import { ASSISTANT_POPOUT_REQUEST_EVENT } from "./assistantPopoutEvents";
import type { LLMProvider } from "../addon";
import {
  isMetadataFieldSelected,
  METADATA_FIELD_SELECTION_OPTIONS,
} from "../core/MetadataFieldSelection";
import { getString } from "../utils/locale";
import { indexingEvents } from "../core/IndexingEventBus";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

type AssistantSidebarRenderOptions = {
  showPopoutButton?: boolean;
};

const ABOUT_TEAM_MEMBERS = [
  {
    name: "Frank Baum",
    role: "Setup & KI-Anbindung",
  },
  {
    name: "Vincent Korsch",
    role: "UI-Design & Branding",
  },
  {
    name: "Nicolas Medda",
    role: "Embedding & Indexierung",
  },
  {
    name: "Timo Rausch",
    role: "KI-Anbindung & Architektur",
  },
  {
    name: "Henrik Schneider",
    role: "Indexierung & Datenspeicherung",
  },
];

const ABOUT_LINKS = [
  {
    label: "Instagram",
    description: "Einblicke in Entwicklung, Design und Projektfortschritt.",
    url: "https://www.instagram.com/zaia.plugin/",
    icon: "instagram",
  },
  {
    label: "Website",
    description: "Alle Informationen zu Features, FAQ und Download.",
    url: "https://zaia-plugin.vercel.app/",
    icon: "website",
  },
  {
    label: "GitHub",
    description: "Technische Umsetzung und Projektstruktur.",
    url: "GITHUB_URL",
    icon: "github",
  },
];

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
  aboutButton.dataset.viewTarget = "about";
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

  const modelPicker = createModelPicker(doc);
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
  const chatListActions = createHtmlElement(
    doc,
    "div",
    "zai-chat-list-actions",
  );
  chatListActions.append(seeAll);
  top.append(
    header,
    modelPicker,
    divider,
    activeChatBar,
    chatList,
    chatListActions,
  );

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
  const setupTimeline = createSetupTimeline(doc);
  const messages = createHtmlElement(doc, "div", "zai-messages");
  messages.setAttribute("aria-live", "polite");
  const aboutView = createAboutView(doc);
  main.append(welcome, setupTimeline, messages, aboutView);

  const footer = createHtmlElement(doc, "footer", "zai-footer");
  const indexingBanner = createIndexingStatusBanner(doc);
  const composer = createHtmlElement(doc, "div", "zai-composer");
  const textarea = createHtmlElement(
    doc,
    "textarea",
    "zai-input",
  ) as HTMLTextAreaElement;
  textarea.placeholder = "Frag etwas zur Bibliothek...";
  textarea.rows = 3;

  const chatStatus = createHtmlElement(doc, "span", "zai-chat-status", "");
  chatStatus.hidden = true;
  const metadataControl = createMetadataFieldControl(doc);
  const sendButton = createButton(doc, "zai-send-button");
  sendButton.setAttribute("aria-label", "Nachricht senden");
  sendButton.append(createSendIcon(doc));

  composer.append(textarea, metadataControl, chatStatus, sendButton);
  footer.append(indexingBanner, composer);

  sidebar.append(top, main, footer);
  return sidebar;
}

function createSetupTimeline(doc: Document) {
  const setup = createHtmlElement(doc, "section", "zai-setup-timeline");
  setup.hidden = true;
  setup.setAttribute("aria-labelledby", "zai-setup-title");

  const header = createHtmlElement(doc, "header", "zai-setup-header");
  const eyebrow = createHtmlElement(
    doc,
    "span",
    "zai-setup-eyebrow",
    getString("sidebar-setup-eyebrow"),
  );
  const title = createHtmlElement(
    doc,
    "h2",
    "zai-setup-title",
    getString("sidebar-setup-title"),
  );
  title.id = "zai-setup-title";
  const description = createHtmlElement(
    doc,
    "p",
    "zai-setup-description",
    getString("sidebar-setup-description"),
  );
  header.append(eyebrow, title, description);

  const milestones = createHtmlElement(doc, "ol", "zai-setup-milestones");
  const liveStatus = createHtmlElement(doc, "p", "zai-setup-live-status");
  liveStatus.setAttribute("aria-live", "polite");
  liveStatus.hidden = true;
  setup.append(header, milestones, liveStatus);
  return setup;
}

function createAboutView(doc: Document) {
  const view = createHtmlElement(doc, "article", "zai-about-view");
  view.hidden = true;

  const team = createHtmlElement(doc, "section", "zai-about-section");
  team.append(
    createHtmlElement(
      doc,
      "p",
      "zai-about-section-text",
      "ZAIA entsteht im Rahmen des Moduls “Wirtschaftsinformatik-Projekt” an der Universität Potsdam. Hinter dem Plugin steht ein studentisches Projektteam, das Konzeption, Design, Entwicklung und Projektmanagement gemeinsam umsetzt:",
    ),
  );
  const teamGrid = createHtmlElement(doc, "div", "zai-about-team-grid");
  teamGrid.append(
    ...ABOUT_TEAM_MEMBERS.map((member) => {
      const card = createHtmlElement(doc, "section", "zai-about-team-card");
      card.append(
        createHtmlElement(doc, "h4", "zai-about-team-name", member.name),
        createHtmlElement(doc, "p", "zai-about-team-role", member.role),
      );
      return card;
    }),
  );
  team.append(teamGrid);

  const links = createHtmlElement(doc, "section", "zai-about-section");
  links.append(
    createHtmlElement(
      doc,
      "h3",
      "zai-about-section-title",
      "Folge dem Projekt",
    ),
  );
  const linkGrid = createHtmlElement(doc, "div", "zai-about-links");
  linkGrid.append(...ABOUT_LINKS.map((link) => createAboutLinkCard(doc, link)));
  links.append(linkGrid);

  view.append(team, links);
  return view;
}

function createAboutSection(
  doc: Document,
  title: string,
  paragraphs: string[],
) {
  const section = createHtmlElement(doc, "section", "zai-about-section");
  section.append(
    createHtmlElement(doc, "h3", "zai-about-section-title", title),
  );
  section.append(
    ...paragraphs.map((text) =>
      createHtmlElement(doc, "p", "zai-about-section-text", text),
    ),
  );
  return section;
}

function createAboutLinkCard(
  doc: Document,
  link: { label: string; description: string; url: string; icon: string },
) {
  const card = createHtmlElement(doc, "a", "zai-about-link-card");
  const anchor = card as HTMLAnchorElement;
  anchor.href = link.url;
  anchor.dataset.aboutUrl = link.url;
  anchor.setAttribute("aria-label", `${link.label}: ${link.description}`);
  anchor.append(
    createAboutLinkIcon(doc, link.icon),
    createHtmlElement(doc, "span", "zai-about-link-title", link.label),
    createHtmlElement(
      doc,
      "span",
      "zai-about-link-description",
      link.description,
    ),
  );
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    if (link.url.endsWith("_URL")) return;
    Zotero.launchURL(link.url);
  });
  return anchor;
}

function createAboutLinkIcon(doc: Document, icon: string) {
  const wrap = createHtmlElement(doc, "span", "zai-about-link-icon");
  if (icon === "instagram") {
    wrap.append(createInstagramIcon(doc));
  } else if (icon === "github") {
    wrap.append(createGitHubIcon(doc));
  } else {
    wrap.append(createGlobeIcon(doc));
  }
  return wrap;
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

function createModelPicker(doc: Document) {
  const picker = createHtmlElement(
    doc,
    "div",
    "zai-model-picker zai-model-picker-collapsed",
  );
  const toggle = createButton(doc, "zai-model-picker-toggle");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Modellauswahl ein- oder ausklappen");
  toggle.append(
    createHtmlElement(doc, "span", "zai-model-picker-title", "Modellauswahl"),
    createHtmlElement(doc, "span", "zai-model-picker-summary"),
  );

  const content = createHtmlElement(doc, "div", "zai-model-picker-content");
  content.hidden = true;
  content.append(createProviderToggle(doc), createModelSelect(doc));

  picker.append(toggle, content);
  return picker;
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

  toggle.append(cloudButton, localButton);
  return toggle;
}

function createModelSelect(doc: Document) {
  const modelWrap = createHtmlElement(doc, "div", "zai-model-select-wrap");
  const modelSelect = createButton(doc, "zai-model-select");
  modelSelect.setAttribute("aria-expanded", "false");
  modelSelect.setAttribute("aria-haspopup", "listbox");
  modelSelect.setAttribute("aria-label", "Modell auswählen");

  const modelValue = createHtmlElement(
    doc,
    "span",
    "zai-model-select-value",
    "Modell auswählen",
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
  return modelWrap;
}

function createMetadataFieldControl(doc: Document) {
  const control = createHtmlElement(doc, "div", "zai-metadata-control");

  const button = createButton(doc, "zai-metadata-button");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-label", "Metadaten-Kontext auswählen");
  button.setAttribute("title", "Metadaten-Kontext auswählen");
  button.append(
    createMetadataIcon(doc),
    createHtmlElement(doc, "span", "zai-metadata-button-label", "Kontext"),
    createHtmlElement(doc, "span", "zai-context-count-badge", "0"),
  );

  const popover = createHtmlElement(doc, "div", "zai-metadata-popover");
  popover.hidden = true;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Metadaten-Kontext");

  const title = createHtmlElement(
    doc,
    "div",
    "zai-metadata-popover-title",
    "Metadaten-Kontext",
  );
  const options = createHtmlElement(doc, "div", "zai-metadata-options");

  for (const option of METADATA_FIELD_SELECTION_OPTIONS) {
    const label = createHtmlElement(doc, "label", "zai-metadata-option");
    const checkbox = doc.createElementNS(HTML_NS, "input") as HTMLInputElement;
    checkbox.className = "zai-metadata-checkbox";
    checkbox.type = "checkbox";
    checkbox.value = option.value;
    checkbox.checked = isMetadataFieldSelected(
      addon.data.settings.metadataFieldSelection,
      option.value,
    );
    label.append(
      checkbox,
      createHtmlElement(doc, "span", "zai-metadata-option-label", option.label),
    );
    options.append(label);
  }

  const paperContext = createHtmlElement(doc, "div", "zai-paper-context");
  const paperContextTitle = createHtmlElement(
    doc,
    "div",
    "zai-paper-context-title",
    "Paper-Kontext",
  );
  const paperContextList = createHtmlElement(
    doc,
    "div",
    "zai-paper-context-list",
  );
  const manualPaperContextList = createHtmlElement(
    doc,
    "div",
    "zai-paper-manual-context-list",
  );
  const selectedPapersTitle = createHtmlElement(
    doc,
    "div",
    "zai-paper-context-subtitle",
    "Ausgewählte Paper",
  );
  const paperContextEmpty = createHtmlElement(
    doc,
    "div",
    "zai-paper-context-empty",
    "Keine Paper angehängt",
  );
  const paperLibrarySearch = createHtmlElement(
    doc,
    "input",
    "zai-paper-library-search",
  ) as HTMLInputElement;
  paperLibrarySearch.type = "search";
  paperLibrarySearch.placeholder = "Paper in Bibliothek suchen...";
  paperLibrarySearch.setAttribute("aria-label", "Paper in Bibliothek suchen");
  const paperLibraryResults = createHtmlElement(
    doc,
    "div",
    "zai-paper-library-results",
  );
  paperLibraryResults.setAttribute("aria-live", "polite");
  paperContextList.append(paperContextEmpty);
  paperContext.append(
    paperContextTitle,
    paperLibrarySearch,
    paperLibraryResults,
    manualPaperContextList,
    selectedPapersTitle,
    paperContextList,
  );

  popover.append(title, options, paperContext);
  control.append(button, popover);
  return control;
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
  const svg = createIconSvg(doc, "20");

  const line = doc.createElementNS(SVG_NS, "path");
  line.setAttribute("d", "M12 19V5");

  const arrow = doc.createElementNS(SVG_NS, "path");
  arrow.setAttribute("d", "m5 12 7-7 7 7");

  svg.append(line, arrow);
  return svg;
}

function createMetadataIcon(doc: Document) {
  const svg = createIconSvg(doc, "18");

  const topLine = doc.createElementNS(SVG_NS, "path");
  topLine.setAttribute("d", "M4 7h16");

  const middleLine = doc.createElementNS(SVG_NS, "path");
  middleLine.setAttribute("d", "M4 12h16");

  const bottomLine = doc.createElementNS(SVG_NS, "path");
  bottomLine.setAttribute("d", "M4 17h16");

  const topDot = doc.createElementNS(SVG_NS, "path");
  topDot.setAttribute("d", "M8 5v4");

  const middleDot = doc.createElementNS(SVG_NS, "path");
  middleDot.setAttribute("d", "M14 10v4");

  const bottomDot = doc.createElementNS(SVG_NS, "path");
  bottomDot.setAttribute("d", "M10 15v4");

  svg.append(topLine, middleLine, bottomLine, topDot, middleDot, bottomDot);
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

function createInstagramIcon(doc: Document) {
  const svg = createIconSvg(doc, "18");

  const frame = doc.createElementNS(SVG_NS, "rect");
  frame.setAttribute("x", "2");
  frame.setAttribute("y", "2");
  frame.setAttribute("width", "20");
  frame.setAttribute("height", "20");
  frame.setAttribute("rx", "5");
  frame.setAttribute("ry", "5");

  const lens = doc.createElementNS(SVG_NS, "circle");
  lens.setAttribute("cx", "12");
  lens.setAttribute("cy", "12");
  lens.setAttribute("r", "4");

  const dot = doc.createElementNS(SVG_NS, "path");
  dot.setAttribute("d", "M17.5 6.5h.01");

  svg.append(frame, lens, dot);
  return svg;
}

function createGlobeIcon(doc: Document) {
  const svg = createIconSvg(doc, "18");

  const globe = doc.createElementNS(SVG_NS, "circle");
  globe.setAttribute("cx", "12");
  globe.setAttribute("cy", "12");
  globe.setAttribute("r", "10");

  const meridian = doc.createElementNS(SVG_NS, "path");
  meridian.setAttribute("d", "M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20");

  const equator = doc.createElementNS(SVG_NS, "path");
  equator.setAttribute("d", "M2 12h20");

  svg.append(globe, meridian, equator);
  return svg;
}

function createGitHubIcon(doc: Document) {
  const svg = createIconSvg(doc, "18");

  const mark = doc.createElementNS(SVG_NS, "path");
  mark.setAttribute(
    "d",
    "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
  );

  const branch = doc.createElementNS(SVG_NS, "path");
  branch.setAttribute("d", "M9 18c-4.51 2-5-2-7-2");

  svg.append(mark, branch);
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

function createCheckIcon(doc: Document) {
  const svg = createIconSvg(doc, "14");
  const check = doc.createElementNS(SVG_NS, "path");
  check.setAttribute("d", "M20 6 9 17l-5-5");
  svg.append(check);
  return svg;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Erzeugt den Indizierungs-Status-Banner, der direkt über dem Kompositor angezeigt wird.
 */
function createIndexingStatusBanner(doc: Document) {
  const banner = createHtmlElement(
    doc,
    "div",
    "zai-indexing-banner zai-indexing-banner--idle",
  );
  banner.hidden = true;

  const activeIndicator = createHtmlElement(doc, "span", "zai-indexing-active");
  activeIndicator.hidden = true;
  const activeIcon = createHtmlElement(doc, "span", "zai-indexing-spinner");
  activeIcon.textContent = "⏳";
  const activeText = createHtmlElement(doc, "span", "zai-indexing-active-text");
  activeText.textContent = "Achtung: Indexierung aktiv";

  const stopButton = createHtmlElement(doc, "button", "zai-indexing-stop-btn");
  stopButton.textContent = "Abbrechen";
  stopButton.title = "Indexierung abbrechen";
  stopButton.style.marginLeft = "12px";
  stopButton.style.cursor = "pointer";
  stopButton.style.background = "transparent";
  stopButton.style.color = "inherit";
  stopButton.style.border = "1px solid currentColor";
  stopButton.style.borderRadius = "4px";
  stopButton.style.padding = "2px 8px";
  stopButton.style.fontSize = "0.9em";
  stopButton.style.opacity = "0.8";

  // Hover effect using simple mouse events since it's inline styled
  stopButton.addEventListener("mouseenter", () => {
    stopButton.style.opacity = "1";
    stopButton.style.background = "rgba(128, 128, 128, 0.2)";
  });
  stopButton.addEventListener("mouseleave", () => {
    stopButton.style.opacity = "0.8";
    stopButton.style.background = "transparent";
  });
  stopButton.addEventListener("click", () => {
    import("../core/BackgroundIndexer")
      .then((mod) => {
        mod.backgroundIndexer.abort();
      })
      .catch((err) => {
        Zotero.debug("Error aborting indexer: " + err);
      });
  });

  activeIndicator.append(activeIcon, activeText, stopButton);

  const successIndicator = createHtmlElement(
    doc,
    "span",
    "zai-indexing-success",
  );
  successIndicator.hidden = true;
  const successText = createHtmlElement(
    doc,
    "span",
    "zai-indexing-success-text",
  );
  successIndicator.append(successText);

  banner.append(activeIndicator, successIndicator);

  let hideSuccessTimeout: any = null;

  function showActive(text: string) {
    if (hideSuccessTimeout) clearTimeout(hideSuccessTimeout);
    successIndicator.hidden = true;
    activeText.textContent = text;
    activeIndicator.hidden = false;
    banner.hidden = false;
    banner.classList.remove(
      "zai-indexing-banner--success",
      "zai-indexing-banner--idle",
    );
    banner.classList.add("zai-indexing-banner--active");
  }

  function showSuccess(text: string) {
    if (hideSuccessTimeout) clearTimeout(hideSuccessTimeout);
    activeIndicator.hidden = true;
    successText.textContent = text;
    successIndicator.hidden = false;
    banner.hidden = false;
    banner.classList.remove(
      "zai-indexing-banner--active",
      "zai-indexing-banner--idle",
      "zai-indexing-banner--error",
    );
    banner.classList.add("zai-indexing-banner--success");

    hideSuccessTimeout = setTimeout(() => {
      successIndicator.hidden = true;
      banner.hidden = true;
      banner.classList.remove("zai-indexing-banner--success");
      hideSuccessTimeout = null;
    }, 3000);
  }

  function showError(text: string) {
    if (hideSuccessTimeout) clearTimeout(hideSuccessTimeout);
    activeIndicator.hidden = true;
    successText.textContent = text;
    successIndicator.hidden = false;
    banner.hidden = false;
    banner.classList.remove(
      "zai-indexing-banner--active",
      "zai-indexing-banner--idle",
      "zai-indexing-banner--success",
    );
    banner.classList.add("zai-indexing-banner--error");

    hideSuccessTimeout = setTimeout(() => {
      successIndicator.hidden = true;
      banner.hidden = true;
      banner.classList.remove("zai-indexing-banner--error");
      hideSuccessTimeout = null;
    }, 3000);
  }

  const unsubStarted = indexingEvents.on("started", () => {
    showActive("Achtung: Indexierung aktiv…");
  });

  const unsubProgress = indexingEvents.on(
    "progress",
    ({ indexed, total, estimatedRemainingMs }) => {
      let msg = `Achtung: Indexierung aktiv ${indexed} / ${total} Papern indexiert`;
      if (estimatedRemainingMs !== undefined && estimatedRemainingMs > 0) {
        msg += ` (noch ca. ${formatDuration(estimatedRemainingMs)})`;
      }
      showActive(msg);
    },
  );

  const unsubFinished = indexingEvents.on("finished", ({ indexed, total }) => {
    showSuccess(
      `✓ Indexierung abgeschlossen (${indexed ?? 0} / ${total ?? "?"} Papern)`,
    );
  });

  const unsubAborted = indexingEvents.on("aborted", ({ indexed, total }) => {
    showError(
      `Indexierung abgebrochen (${indexed ?? 0} / ${total ?? "?"} Papern)`,
    );
  });

  const unsubSingleStarted = indexingEvents.on(
    "singleStarted",
    ({ paperTitle }) => {
      showActive(
        paperTitle
          ? `"${paperTitle}" wird indexiert ...`
          : "Paper wird indexiert ...",
      );
    },
  );

  const unsubSingleDone = indexingEvents.on(
    "singleDone",
    ({ paperTitle, skipped, unchanged }) => {
      if (unchanged) {
        showSuccess(`✓ Bereits aktuell indexiert: ${paperTitle ?? "Paper"}`);
        return;
      }
      if (skipped) {
        showSuccess(`Indexierung übersprungen: ${paperTitle ?? "Paper"}`);
        return;
      }
      showSuccess(`✓ Erfolgreich indexiert: ${paperTitle ?? "Paper"}`);
    },
  );

  const unsubDeleted = indexingEvents.on("deleted", ({ paperTitle }) => {
    showSuccess(`✓ Aus dem Index entfernt: ${paperTitle ?? "Paper"}`);
  });

  const unsubError = indexingEvents.on("error", ({ paperTitle, message }) => {
    showError(`Fehler bei ${paperTitle ?? "Paper"}: ${message}`);
  });

  import("../core/BackgroundIndexer")
    .then((mod) => {
      const currentState = mod.backgroundIndexer.indexingState;
      if (currentState.status === "running") {
        let msg = `Achtung: Indexierung aktiv – ${currentState.indexed} / ${currentState.total} Papern indexiert`;
        if (
          currentState.estimatedRemainingMs !== undefined &&
          currentState.estimatedRemainingMs > 0
        ) {
          msg += ` (noch ca. ${formatDuration(currentState.estimatedRemainingMs)})`;
        }
        showActive(msg);
      } else if (
        currentState.status === "done" &&
        currentState.newlyIndexed > 0
      ) {
        showSuccess(
          `✓ Indexierung abgeschlossen (${currentState.indexed} / ${currentState.total} Papern)`,
        );
      } else if (currentState.status === "aborted") {
        showError(
          `Indexierung abgebrochen (${currentState.indexed} / ${currentState.total} Papern)`,
        );
      }
    })
    .catch((err) => {});

  const observer = new doc.defaultView!.MutationObserver(() => {
    if (!banner.isConnected) {
      unsubStarted();
      unsubProgress();
      unsubFinished();
      unsubAborted();
      unsubSingleStarted();
      unsubSingleDone();
      unsubDeleted();
      unsubError();
      if (hideSuccessTimeout) clearTimeout(hideSuccessTimeout);
      observer.disconnect();
    }
  });
  if (banner.ownerDocument.body) {
    observer.observe(banner.ownerDocument.body, {
      childList: true,
      subtree: true,
    });
  }

  return banner;
}
