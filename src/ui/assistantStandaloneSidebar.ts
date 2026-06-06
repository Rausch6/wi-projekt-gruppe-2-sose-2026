import { config } from "../../package.json";
import { renderAssistantSidebar } from "./assistantSidebar";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SIDEBAR_ID = `${config.addonRef}-standalone-ai-sidebar`;
const DEFAULT_PANEL_WIDTH = 390;
const ASSISTANT_TRIGGER_SELECTOR = '[data-zai-assistant-trigger="true"]';
export const ASSISTANT_STATE_EVENT = `${config.addonRef}-ai-assistant-state-change`;

const states = new WeakMap<
  Window,
  {
    cleanup: () => void;
    setOpen: (open: boolean) => void;
    toggle: () => boolean;
    isOpen: () => boolean;
  }
>();

type SidenavElement = Element & {
  container?: Element;
};
type NativeItemPaneElement = Element & {
  collapsed?: boolean;
};
type OverlayRect = Pick<
  DOMRectReadOnly,
  "top" | "right" | "bottom" | "left" | "width" | "height"
>;

export function registerAssistantStandaloneSidebar(
  win: _ZoteroTypes.MainWindow,
) {
  const doc = win.document;
  const root = doc.documentElement;
  if (!root) {
    return;
  }

  unregisterAssistantStandaloneSidebar(win);

  const panel = createPanel(doc);
  const paneObserver = new win.MutationObserver(() => {
    if (isNativeItemPaneCollapsed(win)) {
      if (panel.hidden !== true) {
        setOpen(false, { updateNativePane: false });
      }
      return;
    }

    if (panel.hidden !== true) {
      syncPanelPosition();
    }
  });

  const syncPanelPosition = () => {
    const winWidth = win.innerWidth || root.clientWidth;
    const winHeight = win.innerHeight || root.clientHeight;
    const rect = getRightSideOverlayRect(win, winWidth, winHeight);
    const rightOffset = rect
      ? Math.max(0, Math.round(winWidth - rect.right))
      : 0;
    const panelWidth = rect?.width
      ? Math.max(320, Math.round(rect.width))
      : DEFAULT_PANEL_WIDTH;
    const panelTop = Math.max(0, Math.round(rect?.top ?? 48));
    const panelBottom = Math.max(
      0,
      Math.round(rect ? winHeight - rect.bottom : 0),
    );
    const maxPanelWidth = Math.max(320, winWidth - rightOffset - 20);

    panel.style.setProperty("--zai-standalone-right", `${rightOffset}px`);
    panel.style.setProperty("--zai-standalone-width", `${panelWidth}px`);
    panel.style.setProperty("--zai-standalone-top", `${panelTop}px`);
    panel.style.setProperty("--zai-standalone-bottom", `${panelBottom}px`);
    panel.style.position = "fixed";
    panel.style.right = `${rightOffset}px`;
    panel.style.top = `${panelTop}px`;
    panel.style.bottom = `${panelBottom}px`;
    panel.style.width = `${Math.min(panelWidth, maxPanelWidth)}px`;
    panel.style.minWidth = "320px";
    panel.style.maxWidth = "calc(100vw - 24px)";
    panel.style.zIndex = "1100";
  };

  const setOpen = (
    open: boolean,
    options: { updateNativePane?: boolean } = {},
  ) => {
    const updateNativePane = options.updateNativePane !== false;
    if (updateNativePane) {
      setNativeItemPaneCollapsed(win, !open);
    }

    if (open) {
      syncPanelPosition();
    }
    panel.hidden = !open;
    panel.style.display = open ? "flex" : "none";
    panel.classList.toggle("zai-standalone-sidebar-open", open);
    panel.setAttribute("aria-hidden", String(!open));
    emitStateChange(win, open);

    if (open) {
      win.requestAnimationFrame(syncPanelPosition);
    }
  };

  const togglePanel = () => {
    const open = panel.hidden === true;
    setOpen(open);
    return open;
  };
  const closeOnSidenavActivate = (event: Event) => {
    if (isAssistantTriggerEvent(event)) {
      return;
    }

    if (panel.hidden === true) {
      return;
    }

    setOpen(false, { updateNativePane: false });
  };
  const removeSidenavCloseListeners = addSidenavCloseListeners(
    win,
    closeOnSidenavActivate,
  );

  win.addEventListener("resize", syncPanelPosition);
  observeNativeItemPane(win, paneObserver);

  root.append(panel);
  syncPanelPosition();

  states.set(win, {
    cleanup: () => {
      win.removeEventListener("resize", syncPanelPosition);
      removeSidenavCloseListeners();
      paneObserver.disconnect();
      panel.remove();
    },
    setOpen,
    toggle: togglePanel,
    isOpen: () => panel.hidden !== true,
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
  return state?.toggle() ?? false;
}

export function isAssistantStandaloneSidebarOpen(win: _ZoteroTypes.MainWindow) {
  return states.get(win)?.isOpen() ?? false;
}

export function markAssistantSidenavBody(body: HTMLElement) {
  body.classList.add("zai-assistant-sidenav-body");
  body.replaceChildren();
}

function addSidenavCloseListeners(
  win: _ZoteroTypes.MainWindow,
  close: (event: Event) => void,
) {
  const sidenavs = getSidenavElements(win);
  const eventTypes = ["click", "command"];

  for (const sidenav of sidenavs) {
    for (const eventType of eventTypes) {
      sidenav.addEventListener(eventType, close);
    }
  }

  return () => {
    for (const sidenav of sidenavs) {
      for (const eventType of eventTypes) {
        sidenav.removeEventListener(eventType, close);
      }
    }
  };
}

function isAssistantTriggerEvent(event: Event) {
  const target = event.target as Element | null;
  return Boolean(target?.closest?.(ASSISTANT_TRIGGER_SELECTOR));
}

function getSidenavElements(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  const sidenavs = new Set<Element>();

  for (const id of [
    "zotero-view-item-sidenav",
    "zotero-context-pane-sidenav",
  ]) {
    const sidenav = doc.getElementById(id);
    if (sidenav) {
      sidenavs.add(sidenav);
    }
  }

  const contextPane = (win as unknown as { ZoteroContextPane?: unknown })
    .ZoteroContextPane as { sidenav?: SidenavElement } | undefined;
  if (contextPane?.sidenav) {
    sidenavs.add(contextPane.sidenav);
  }

  return [...sidenavs];
}

function observeNativeItemPane(
  win: _ZoteroTypes.MainWindow,
  observer: MutationObserver,
) {
  const pane = getNativeItemPane(win);
  if (!pane) {
    return;
  }

  observer.observe(pane, {
    attributes: true,
    attributeFilter: ["collapsed", "hidden", "style", "width", "height"],
  });
}

function setNativeItemPaneCollapsed(
  win: _ZoteroTypes.MainWindow,
  collapsed: boolean,
) {
  const pane = getNativeItemPane(win);
  if (!pane || pane.collapsed === collapsed) {
    return;
  }

  pane.collapsed = collapsed;
  getZoteroPane(win)?.updateLayoutConstraints?.();
}

function isNativeItemPaneCollapsed(win: _ZoteroTypes.MainWindow) {
  const pane = getNativeItemPane(win);
  return pane?.collapsed === true || pane?.getAttribute("collapsed") === "true";
}

function getNativeItemPane(win: _ZoteroTypes.MainWindow) {
  const zoteroPane = getZoteroPane(win);
  return (
    (zoteroPane?.itemPane as NativeItemPaneElement | false | undefined) ||
    (win.document.getElementById(
      "zotero-item-pane",
    ) as NativeItemPaneElement | null)
  );
}

function getZoteroPane(win: _ZoteroTypes.MainWindow) {
  return (win as unknown as { ZoteroPane?: _ZoteroTypes.ZoteroPane })
    .ZoteroPane;
}

function emitStateChange(win: Window, open: boolean) {
  win.dispatchEvent(
    new win.CustomEvent(ASSISTANT_STATE_EVENT, { detail: { open } }),
  );
}

function getRightSideOverlayRect(
  win: _ZoteroTypes.MainWindow,
  winWidth: number,
  winHeight: number,
) {
  const contentTarget = getRightSideContentTarget(win, winWidth, winHeight);
  if (contentTarget) {
    return contentTarget.getBoundingClientRect();
  }

  const paneTarget = getRightSidePaneTarget(win, winWidth, winHeight);
  if (!paneTarget) {
    return undefined;
  }

  return getPaneContentRect(win, paneTarget);
}

function getRightSideContentTarget(
  win: _ZoteroTypes.MainWindow,
  winWidth: number,
  winHeight: number,
) {
  const doc = win.document;
  const selectedType = (win as unknown as { Zotero_Tabs?: unknown })
    .Zotero_Tabs as { selectedType?: string } | undefined;
  const contentIDs =
    selectedType?.selectedType === "library"
      ? ["zotero-item-pane-content", "zotero-context-pane-inner"]
      : ["zotero-context-pane-inner", "zotero-item-pane-content"];

  for (const contentID of contentIDs) {
    const content = doc.getElementById(contentID);
    if (isRightSidePane(content, winWidth, winHeight)) {
      return content;
    }
  }

  return undefined;
}

function getRightSidePaneTarget(
  win: _ZoteroTypes.MainWindow,
  winWidth: number,
  winHeight: number,
) {
  const doc = win.document;
  const selectedType = (win as unknown as { Zotero_Tabs?: unknown })
    .Zotero_Tabs as { selectedType?: string } | undefined;
  const paneIDs =
    selectedType?.selectedType === "library"
      ? ["zotero-item-pane", "zotero-context-pane"]
      : ["zotero-context-pane", "zotero-item-pane"];

  for (const paneID of paneIDs) {
    const pane = doc.getElementById(paneID);
    if (isRightSidePane(pane, winWidth, winHeight)) {
      return pane;
    }
  }

  const contextPane = (win as unknown as { ZoteroContextPane?: unknown })
    .ZoteroContextPane as { sidenav?: SidenavElement } | undefined;
  const sidenav = contextPane?.sidenav;
  if (!sidenav) {
    return undefined;
  }

  if (sidenav.container) {
    return isRightSidePane(sidenav.container, winWidth, winHeight)
      ? sidenav.container
      : undefined;
  }

  const closestSidebar = sidenav.closest?.(
    "#zotero-context-pane, zotero-context-pane, .zotero-context-pane, .context-pane",
  );
  if (isRightSidePane(closestSidebar, winWidth, winHeight)) {
    return closestSidebar;
  }

  const parent = sidenav.parentElement;
  if (parent && isRightSidePane(parent, winWidth, winHeight)) {
    const parentRect = parent.getBoundingClientRect();
    const sidenavRect = sidenav.getBoundingClientRect();
    if (parentRect.width > sidenavRect.width) {
      return parent;
    }
  }

  return isRightSidePane(sidenav, winWidth, winHeight) ? sidenav : undefined;
}

function getPaneContentRect(win: _ZoteroTypes.MainWindow, pane: Element) {
  const paneRect = pane.getBoundingClientRect();
  const sidenav = getVisibleSidenavForPane(win, pane);
  const sidenavRect = sidenav?.getBoundingClientRect();

  if (
    sidenavRect &&
    sidenavRect.width > 0 &&
    sidenavRect.height > 0 &&
    sidenavRect.left > paneRect.left &&
    sidenavRect.left < paneRect.right
  ) {
    const right = Math.max(paneRect.left, sidenavRect.left);
    return {
      top: paneRect.top,
      right,
      bottom: paneRect.bottom,
      left: paneRect.left,
      width: Math.max(0, right - paneRect.left),
      height: paneRect.height,
    } satisfies OverlayRect;
  }

  return paneRect;
}

function getVisibleSidenavForPane(win: _ZoteroTypes.MainWindow, pane: Element) {
  const doc = win.document;
  const candidates =
    pane.id === "zotero-context-pane"
      ? ["zotero-context-pane-sidenav"]
      : ["zotero-view-item-sidenav", "zotero-context-pane-sidenav"];

  for (const id of candidates) {
    const sidenav = doc.getElementById(id);
    if (sidenav && !sidenav.hasAttribute("hidden")) {
      return sidenav;
    }
  }

  return undefined;
}

function isRightSidePane(
  element: Element | null | undefined,
  winWidth: number,
  winHeight: number,
) {
  if (!element) {
    return false;
  }
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("collapsed") === "true"
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    winWidth - rect.right < 80 &&
    rect.left > winWidth * 0.35 &&
    rect.height > winHeight * 0.35
  );
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
  applyPanelFallbackStyles(panel);
  return panel;
}

function applyPanelFallbackStyles(panel: HTMLElement) {
  panel.style.background = "var(--material-sidepane, #2b2b2b)";
  panel.style.borderLeft = "1px solid var(--border-color, rgba(0, 0, 0, 0.18))";
  panel.style.boxSizing = "border-box";
  panel.style.color = "var(--text-primary, inherit)";
  panel.style.display = "none";
  panel.style.flexDirection = "column";
  panel.style.overflow = "hidden";

  const sidebar = panel.querySelector(".zai-sidebar") as HTMLElement | null;
  if (sidebar) {
    sidebar.style.display = "grid";
    sidebar.style.gridTemplateRows = "auto minmax(0, 1fr) auto";
    sidebar.style.height = "100%";
    sidebar.style.minHeight = "0";
    sidebar.style.width = "100%";
  }

  const main = panel.querySelector(".zai-main") as HTMLElement | null;
  if (main) {
    main.style.minHeight = "0";
    main.style.overflow = "auto";
  }

  const footer = panel.querySelector(".zai-footer") as HTMLElement | null;
  if (footer) {
    footer.style.marginTop = "auto";
  }
}
