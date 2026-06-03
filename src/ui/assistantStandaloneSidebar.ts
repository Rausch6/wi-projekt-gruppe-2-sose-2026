import { config } from "../../package.json";
import { renderAssistantSidebar } from "./assistantSidebar";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SIDEBAR_ID = `${config.addonRef}-standalone-ai-sidebar`;

const states = new WeakMap<
  Window,
  {
    cleanup: () => void;
    setOpen: (open: boolean) => void;
    toggle: () => void;
  }
>();

type SidenavElement = HTMLElement & {
  container?: HTMLElement;
};

export function registerAssistantStandaloneSidebar(
  win: _ZoteroTypes.MainWindow,
) {
  const doc = win.document;
  const root = doc.documentElement;
  const sidenav = getContextPaneSidenav(win);
  if (!root || !sidenav) {
    return;
  }

  unregisterAssistantStandaloneSidebar(win);

  const panel = createPanel(doc);

  const syncPanelPosition = () => {
    const rect = sidenav.getBoundingClientRect();
    const winWidth = win.innerWidth || root.clientWidth;
    const winHeight = win.innerHeight || root.clientHeight;
    const rightOffset = rect.width
      ? Math.max(0, Math.round(winWidth - rect.left))
      : 0;

    panel.style.setProperty("--zai-standalone-right", `${rightOffset}px`);
    panel.style.setProperty(
      "--zai-standalone-top",
      `${Math.max(0, Math.round(rect.top))}px`,
    );
    panel.style.setProperty(
      "--zai-standalone-bottom",
      `${Math.max(0, Math.round(winHeight - rect.bottom))}px`,
    );
  };

  const setOpen = (open: boolean) => {
    syncPanelPosition();
    panel.hidden = !open;
    panel.setAttribute("aria-hidden", String(!open));
  };

  const togglePanel = () => {
    setOpen(panel.hidden === true);
  };

  win.addEventListener("resize", syncPanelPosition);

  root.append(panel);
  syncPanelPosition();

  states.set(win, {
    cleanup: () => {
      win.removeEventListener("resize", syncPanelPosition);
      panel.remove();
    },
    setOpen,
    toggle: togglePanel,
  });
}

export function unregisterAssistantStandaloneSidebar(win: Window) {
  states.get(win)?.cleanup();
  states.delete(win);

  const doc = win.document;
  doc.getElementById(SIDEBAR_ID)?.remove();
}

export function openAssistantStandaloneSidebar(win: _ZoteroTypes.MainWindow) {
  const state = ensureAssistantStandaloneSidebar(win);
  state?.setOpen(true);
}

export function toggleAssistantStandaloneSidebar(win: _ZoteroTypes.MainWindow) {
  const state = ensureAssistantStandaloneSidebar(win);
  state?.toggle();
}

export function markAssistantSidenavBody(body: HTMLElement) {
  body.classList.add("zai-assistant-sidenav-body");
  body.replaceChildren();
}

function getContextPaneSidenav(win: _ZoteroTypes.MainWindow) {
  const contextPane = (win as unknown as { ZoteroContextPane?: unknown })
    .ZoteroContextPane as { sidenav?: SidenavElement } | undefined;
  return contextPane?.sidenav;
}

function ensureAssistantStandaloneSidebar(win: _ZoteroTypes.MainWindow) {
  if (!states.has(win)) {
    registerAssistantStandaloneSidebar(win);
  }
  return states.get(win);
}

function createPanel(doc: Document) {
  const panel = doc.createElementNS(HTML_NS, "aside") as HTMLElement;
  panel.id = SIDEBAR_ID;
  panel.className = "zai-standalone-sidebar";
  panel.hidden = true;
  panel.setAttribute("aria-hidden", "true");
  panel.setAttribute("aria-label", "Zotero AI Assistent");
  renderAssistantSidebar(panel);
  return panel;
}
