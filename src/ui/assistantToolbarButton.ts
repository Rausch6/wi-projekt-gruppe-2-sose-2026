import { config } from "../../package.json";
import {
  ASSISTANT_STATE_EVENT,
  isAssistantSidebarOpen,
  registerAssistantSidebarController,
  toggleAssistantSidebar,
} from "./assistantSidebarController";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const LEGACY_BUTTON_ID = `${config.addonRef}-ai-assistant-toolbar-button`;
const LEGACY_FALLBACK_ID = `${config.addonRef}-ai-assistant-toolbar-fallback`;
const BUTTON_ATTRIBUTE = "data-zai-assistant-trigger";
const SLOT_ATTRIBUTE = "data-zai-assistant-trigger-slot";
const BUTTON_LABEL = "Zotero AI Assistent";
const BUTTON_TOOLTIP = "Zotero AI Assistent öffnen/schließen";

const SIDENAV_IDS = ["zotero-view-item-sidenav", "zotero-context-pane-sidenav"];

const states = new WeakMap<Window, { cleanup: () => void }>();

type XulDocument = Document & {
  createXULElement?: (tagName: string) => XULElement;
};

type SidenavElement = Element & {
  container?: Element;
};

type MountedButton = {
  root: Element;
  button: Element;
  activationEvent: "click" | "command";
  onActivate: EventListener;
  onKeyDown?: EventListener;
  stopClick?: EventListener;
};

export function registerAssistantToolbarButton(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  unregisterAssistantToolbarButton(win);
  registerAssistantSidebarController(win);

  const buttons = new Set<MountedButton>();

  const syncButtonState = () => {
    const open = isAssistantSidebarOpen(win);
    for (const mounted of [...buttons]) {
      if (!mounted.button.isConnected) {
        cleanupMountedButton(mounted);
        buttons.delete(mounted);
        continue;
      }

      mounted.button.classList.toggle("zai-sidenav-button-active", open);
      mounted.button.setAttribute("aria-pressed", String(open));
      mounted.button.setAttribute("checked", String(open));
    }
  };

  const mountButtons = () => {
    for (const target of findSidenavTargets(win)) {
      if (hasAssistantButton(target)) {
        continue;
      }

      const created = createSidenavButton(doc, target);
      const { button } = created;
      const activationEvent =
        button.namespaceURI === XUL_NS ? "command" : "click";
      const onActivate: EventListener = (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleAssistantSidebar(win);
        syncButtonState();
      };
      const mounted: MountedButton = {
        root: created.root,
        button,
        activationEvent,
        onActivate,
      };

      if (activationEvent === "command") {
        mounted.stopClick = (event) => event.stopPropagation();
        button.addEventListener("click", mounted.stopClick);
      }

      if (created.needsKeyboardActivation) {
        mounted.onKeyDown = (event) => {
          const key = (event as KeyboardEvent).key;
          if (key !== " " && key !== "Enter") {
            return;
          }
          onActivate(event);
        };
        button.addEventListener("keydown", mounted.onKeyDown);
      }

      button.addEventListener(activationEvent, onActivate);
      mountSidenavButton(target, created.root);
      buttons.add(mounted);
    }

    syncButtonState();
  };
  const observer = new win.MutationObserver(mountButtons);

  win.addEventListener(ASSISTANT_STATE_EVENT, syncButtonState);
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  mountButtons();

  states.set(win, {
    cleanup: () => {
      win.removeEventListener(ASSISTANT_STATE_EVENT, syncButtonState);
      observer.disconnect();
      for (const mounted of buttons) {
        cleanupMountedButton(mounted);
      }
      buttons.clear();
    },
  });
}

export function unregisterAssistantToolbarButton(win: Window) {
  states.get(win)?.cleanup();
  states.delete(win);

  const doc = win.document;
  removeAssistantButtons(doc);
  cleanupLegacyToolbarButton(doc);
}

function findSidenavTargets(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  const sidenavs = new Set<Element>();
  const targets = new Set<Element>();

  for (const id of SIDENAV_IDS) {
    const element = doc.getElementById(id);
    if (element) {
      sidenavs.add(element);
    }
  }

  const contextPane = (win as unknown as { ZoteroContextPane?: unknown })
    .ZoteroContextPane as { sidenav?: SidenavElement } | undefined;
  if (contextPane?.sidenav) {
    sidenavs.add(contextPane.sidenav);
  }

  for (const sidenav of sidenavs) {
    const nativeSidenav = getNativeSidenavElement(sidenav);
    targets.add(
      nativeSidenav ?? sidenav.querySelector(".inherit-flex") ?? sidenav,
    );
  }

  return [...targets];
}

function hasAssistantButton(target: Element) {
  return Boolean(target.querySelector(`[${BUTTON_ATTRIBUTE}="true"]`));
}

function createSidenavButton(doc: Document, target: Element) {
  if (isNativeSidenavElement(target)) {
    return createNativeSidenavButton(doc);
  }

  return createFallbackSidenavButton(doc, target);
}

function getNativeSidenavElement(target: Element) {
  if (isNativeSidenavElement(target)) {
    return target;
  }

  return target.closest("item-pane-sidenav");
}

function isNativeSidenavElement(target: Element) {
  return target.localName === "item-pane-sidenav";
}

function createNativeSidenavButton(doc: Document) {
  const slot = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  slot.className = "zai-sidenav-assistant-slot";
  slot.setAttribute(SLOT_ATTRIBUTE, "true");

  const divider = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  divider.className = "divider";

  const wrapper = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  wrapper.className = "pin-wrapper";

  const button = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  button.classList.add("btn");
  button.setAttribute(BUTTON_ATTRIBUTE, "true");
  button.setAttribute("custom", "true");
  button.setAttribute("tabindex", "0");
  button.setAttribute("role", "button");
  button.setAttribute("label", BUTTON_LABEL);
  button.setAttribute("aria-label", BUTTON_LABEL);
  button.setAttribute("title", BUTTON_TOOLTIP);
  button.setAttribute("tooltiptext", BUTTON_TOOLTIP);
  button.style.setProperty(
    "--custom-sidenav-icon-light",
    `url('${getAssistantIcon()}')`,
  );
  button.style.setProperty(
    "--custom-sidenav-icon-dark",
    `url('${getAssistantIcon()}')`,
  );

  wrapper.append(button);
  slot.append(divider, wrapper);

  return { root: slot, button, needsKeyboardActivation: true };
}

function createFallbackSidenavButton(doc: Document, target: Element) {
  const xulDoc = doc as XulDocument;
  const useXulButton = target.namespaceURI === XUL_NS;
  const button = useXulButton
    ? (xulDoc.createXULElement?.("toolbarbutton") ??
      doc.createElementNS(XUL_NS, "toolbarbutton"))
    : doc.createElementNS(HTML_NS, "button");

  button.classList.add("zai-sidenav-button");
  button.setAttribute(BUTTON_ATTRIBUTE, "true");
  button.setAttribute("type", "button");
  button.setAttribute("label", BUTTON_LABEL);
  button.setAttribute("aria-label", BUTTON_LABEL);
  button.setAttribute("title", BUTTON_TOOLTIP);
  button.setAttribute("tooltiptext", BUTTON_TOOLTIP);
  button.setAttribute("image", getAssistantIcon());

  if (useXulButton) {
    button.classList.add("toolbarbutton-1");
  } else {
    const icon = doc.createElementNS(HTML_NS, "img");
    icon.className = "zai-sidenav-button-icon";
    icon.setAttribute("alt", "");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("src", getAssistantIcon());
    button.append(icon);
  }

  return { root: button, button, needsKeyboardActivation: false };
}

function mountSidenavButton(target: Element, root: Element) {
  if (!isNativeSidenavElement(target)) {
    target.append(root);
    return;
  }

  target.insertBefore(root, target.querySelector("popupset"));
}

function cleanupMountedButton(mounted: MountedButton) {
  mounted.button.removeEventListener(
    mounted.activationEvent,
    mounted.onActivate,
  );
  if (mounted.onKeyDown) {
    mounted.button.removeEventListener("keydown", mounted.onKeyDown);
  }
  if (mounted.stopClick) {
    mounted.button.removeEventListener("click", mounted.stopClick);
  }
  mounted.root.remove();
}

function removeAssistantButtons(doc: Document) {
  doc
    .querySelectorAll(`[${SLOT_ATTRIBUTE}="true"]`)
    .forEach((slot) => slot.remove());
  doc
    .querySelectorAll(`[${BUTTON_ATTRIBUTE}="true"]`)
    .forEach((button) => button.remove());
}

function cleanupLegacyToolbarButton(doc: Document) {
  doc.getElementById(LEGACY_BUTTON_ID)?.remove();

  const fallback = doc.getElementById(LEGACY_FALLBACK_ID);
  if (fallback && !fallback.childElementCount) {
    fallback.remove();
  }
}

function getAssistantIcon() {
  return `chrome://${config.addonRef}/content/icons/IconPlugin.png`;
}
