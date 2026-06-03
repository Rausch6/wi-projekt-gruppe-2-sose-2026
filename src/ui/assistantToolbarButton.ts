import { config } from "../../package.json";
import {
  ASSISTANT_STATE_EVENT,
  isAssistantStandaloneSidebarOpen,
  registerAssistantStandaloneSidebar,
  toggleAssistantStandaloneSidebar,
} from "./assistantStandaloneSidebar";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const BUTTON_ID = `${config.addonRef}-ai-assistant-toolbar-button`;
const FALLBACK_ID = `${config.addonRef}-ai-assistant-toolbar-fallback`;
const BUTTON_LABEL = "Zotero AI Assistent";
const BUTTON_TOOLTIP = "Zotero AI Assistent öffnen/schließen";

const TOOLBAR_SELECTORS = [
  "#zotero-items-toolbar",
  "#zotero-toolbar",
  "#zotero-pane-toolbar",
  "#zotero-collections-toolbar",
  "#zotero-view-toolbar",
  "toolbar",
];

const states = new WeakMap<Window, { cleanup: () => void }>();

type XulDocument = Document & {
  createXULElement?: (tagName: string) => XULElement;
};

export function registerAssistantToolbarButton(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  unregisterAssistantToolbarButton(win);
  registerAssistantStandaloneSidebar(win);

  const target = findToolbarTarget(doc) ?? createFallbackTarget(doc);
  if (!target) {
    return;
  }

  const button = createToolbarButton(doc, target);
  const syncButtonState = () => {
    const open = isAssistantStandaloneSidebarOpen(win);
    button.classList.toggle("zai-toolbar-button-active", open);
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("checked", String(open));
  };
  const onActivate = () => {
    toggleAssistantStandaloneSidebar(win);
    syncButtonState();
  };
  const activationEvent = button.namespaceURI === XUL_NS ? "command" : "click";

  button.addEventListener(activationEvent, onActivate);
  win.addEventListener(ASSISTANT_STATE_EVENT, syncButtonState);
  target.append(button);
  syncButtonState();

  states.set(win, {
    cleanup: () => {
      button.removeEventListener(activationEvent, onActivate);
      win.removeEventListener(ASSISTANT_STATE_EVENT, syncButtonState);
      button.remove();
      cleanupFallbackTarget(doc);
    },
  });
}

export function unregisterAssistantToolbarButton(win: Window) {
  states.get(win)?.cleanup();
  states.delete(win);

  const doc = win.document;
  doc.getElementById(BUTTON_ID)?.remove();
  cleanupFallbackTarget(doc);
}

function findToolbarTarget(doc: Document) {
  for (const selector of TOOLBAR_SELECTORS) {
    const element = doc.querySelector(selector);
    if (element) {
      return element;
    }
  }
  return undefined;
}

function createFallbackTarget(doc: Document) {
  const existing = doc.getElementById(FALLBACK_ID);
  if (existing) {
    return existing;
  }

  const root = doc.getElementById("zotero-pane") ?? doc.documentElement;
  if (!root) {
    return undefined;
  }

  const fallback = doc.createElementNS(HTML_NS, "div");
  fallback.id = FALLBACK_ID;
  fallback.className = "zai-toolbar-fallback";
  root.prepend(fallback);
  return fallback;
}

function cleanupFallbackTarget(doc: Document) {
  const fallback = doc.getElementById(FALLBACK_ID);
  if (fallback && !fallback.childElementCount) {
    fallback.remove();
  }
}

function createToolbarButton(doc: Document, target: Element) {
  const xulDoc = doc as XulDocument;
  const useXulButton = target.namespaceURI === XUL_NS;
  const button = useXulButton
    ? (xulDoc.createXULElement?.("toolbarbutton") ??
      doc.createElementNS(XUL_NS, "toolbarbutton"))
    : doc.createElementNS(HTML_NS, "button");

  button.id = BUTTON_ID;
  button.classList.add("zai-toolbar-button");
  button.setAttribute("type", "button");
  button.setAttribute("label", BUTTON_LABEL);
  button.setAttribute("aria-label", BUTTON_LABEL);
  button.setAttribute("title", BUTTON_TOOLTIP);
  button.setAttribute("tooltiptext", BUTTON_TOOLTIP);
  button.setAttribute("image", getAssistantIcon());

  if (useXulButton) {
    button.classList.add("toolbarbutton-1", "chromeclass-toolbar-additional");
  } else {
    const icon = doc.createElementNS(HTML_NS, "img");
    icon.className = "zai-toolbar-button-icon";
    icon.setAttribute("alt", "");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("src", getAssistantIcon());
    button.append(icon);
  }

  return button;
}

function getAssistantIcon() {
  return `chrome://${config.addonRef}/content/icons/assistant.svg`;
}
