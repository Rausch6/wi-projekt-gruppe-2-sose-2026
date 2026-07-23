import { config } from "../../package.json";
import { renderAssistantSidebar } from "./assistantSidebar";
import {
  ASSISTANT_POPOUT_REQUEST_EVENT,
  ASSISTANT_POPOUT_STATE_EVENT,
} from "./assistantPopoutEvents";

const POPOUT_ROOT_ID = `${config.addonRef}-assistant-window-root`;
const POPOUT_DEFAULT_WIDTH = 420;
const POPOUT_DEFAULT_HEIGHT = 640;
const POPOUT_MIN_WIDTH = POPOUT_DEFAULT_WIDTH;
const POPOUT_MIN_HEIGHT = POPOUT_DEFAULT_HEIGHT;
const SIDEBAR_THEME_PROPERTIES = [
  "--accent-blue",
  "--border-color",
  "--fill-quinary",
  "--material-background",
  "--material-sidepane",
  "--text-primary",
  "--text-secondary",
];

type PopoutCallbacks = {
  onBeforeOpen?: () => void;
  onClose?: () => void;
};

/**
 * Tracks a popout window and the callbacks associated with its owner window.
 */
type PopoutState = {
  callbacks: PopoutCallbacks;
  cleanup?: () => void;
  restoreSidebarOnClose: boolean;
  window: Window;
};

const popouts = new WeakMap<Window, PopoutState>();

/**
 * Opens the assistant popout window for a Zotero main window or focuses an existing one.
 *
 * @param owner - Zotero main window that owns the popout.
 * @param callbacks - Optional lifecycle callbacks for open and close transitions.
 * @returns Opened popout window, existing popout window, or null when opening fails.
 */
export function openAssistantPopoutWindow(
  owner: _ZoteroTypes.MainWindow,
  callbacks: PopoutCallbacks = {},
) {
  const existing = getLivePopoutState(owner);
  if (existing) {
    focusAssistantPopoutWindow(owner);
    syncAssistantPopoutButtons(owner, true);
    return existing.window;
  }

  callbacks.onBeforeOpen?.();

  const features = [
    "chrome",
    "centerscreen",
    "dialog=no",
    "resizable=yes",
    `width=${POPOUT_DEFAULT_WIDTH}`,
    `height=${POPOUT_DEFAULT_HEIGHT}`,
    `minwidth=${POPOUT_MIN_WIDTH}`,
    `minheight=${POPOUT_MIN_HEIGHT}`,
  ].join(",");

  const openedWindow = owner.openDialog(
    `chrome://${config.addonRef}/content/assistantWindow.xhtml`,
    `${config.addonRef}-assistant-popout-${Date.now()}`,
    features,
    {
      addonInstance: config.addonInstance,
      owner,
    },
  ) as Window | null;

  if (!openedWindow) {
    callbacks.onClose?.();
    return null;
  }

  popouts.set(owner, {
    callbacks,
    restoreSidebarOnClose: true,
    window: openedWindow,
  });
  syncAssistantPopoutButtons(owner, true);
  emitAssistantPopoutState(owner, true);

  return openedWindow;
}

/**
 * Closes the assistant popout window for a Zotero main window.
 *
 * @param owner - Zotero main window that owns the popout.
 * @param options - Optional close behavior flags.
 * @returns True when a popout was closed, otherwise false.
 */
export function closeAssistantPopoutWindow(
  owner: _ZoteroTypes.MainWindow,
  options: { restoreSidebar?: boolean } = {},
) {
  const state = getLivePopoutState(owner);
  if (!state) {
    syncAssistantPopoutButtons(owner, false);
    emitAssistantPopoutState(owner, false);
    return false;
  }

  state.restoreSidebarOnClose = options.restoreSidebar !== false;
  state.window.close();
  return true;
}

/**
 * Checks whether an owner window currently has a live assistant popout.
 *
 * @param owner - Owner window to inspect.
 * @returns True when the popout exists and is not closed.
 */
export function isAssistantPopoutWindowOpen(owner: Window) {
  return Boolean(getLivePopoutState(owner));
}

/**
 * Focuses the assistant popout window for an owner window.
 *
 * @param owner - Owner window whose popout should be focused.
 * @returns True when a live popout was focused.
 */
export function focusAssistantPopoutWindow(owner: Window) {
  const state = getLivePopoutState(owner);
  if (!state) return false;

  state.window.focus();
  return true;
}

/**
 * Initializes the content and lifecycle handlers inside a popout window.
 *
 * @param popoutWindow - Popout window being initialized.
 * @param owner - Zotero main window that owns the popout.
 * @returns Cleanup callback for popout event handlers, or undefined when initialization cannot continue.
 */
export function initializeAssistantPopoutWindow(
  popoutWindow: Window,
  owner: _ZoteroTypes.MainWindow,
) {
  let state = popouts.get(owner);
  if (!state || state.window !== popoutWindow) {
    state = {
      callbacks: {},
      restoreSidebarOnClose: false,
      window: popoutWindow,
    };
    popouts.set(owner, state);
  }

  const doc = popoutWindow.document;
  const root = doc.getElementById(POPOUT_ROOT_ID) as HTMLElement | null;
  if (!root) {
    return;
  }

  doc.documentElement.classList.add("zai-assistant-popout-document");
  doc.body?.classList.add("zai-assistant-popout-body");
  root.classList.add("zai-assistant-popout");

  syncPopoutAppearance(popoutWindow, owner, root);
  renderAssistantSidebar(root, { showPopoutButton: false });
  syncAssistantPopoutButtons(owner, true);
  emitAssistantPopoutState(owner, true);

  const focusExistingPopout = () => {
    focusAssistantPopoutWindow(owner);
  };
  popoutWindow.addEventListener(
    ASSISTANT_POPOUT_REQUEST_EVENT,
    focusExistingPopout,
  );

  state.cleanup?.();

  const removeResizeGuard = installResizeGuard(popoutWindow);
  focusComposer(popoutWindow);

  state.cleanup = () => {
    popoutWindow.removeEventListener(
      ASSISTANT_POPOUT_REQUEST_EVENT,
      focusExistingPopout,
    );
    removeResizeGuard();
  };

  return state.cleanup;
}

/**
 * Handles popout unload by clearing state and optionally restoring the sidebar.
 *
 * @param popoutWindow - Popout window that is unloading.
 * @param owner - Zotero main window that owns the popout.
 * @returns Nothing.
 */
export function handleAssistantPopoutWindowUnload(
  popoutWindow: Window,
  owner: _ZoteroTypes.MainWindow,
) {
  const state = popouts.get(owner);
  if (!state || state.window !== popoutWindow) {
    return;
  }

  popouts.delete(owner);
  state.cleanup?.();
  syncAssistantPopoutButtons(owner, false);
  emitAssistantPopoutState(owner, false);

  if (state.restoreSidebarOnClose) {
    state.callbacks.onClose?.();
  }
}

/**
 * Synchronizes all popout buttons in a window with the current popout state.
 *
 * @param win - Window containing popout buttons.
 * @param open - Whether the popout is currently open.
 * @returns Nothing.
 */
export function syncAssistantPopoutButtons(win: Window, open: boolean) {
  const doc = win.document;
  const label = open
    ? "ZAIA-Popout fokussieren"
    : "ZAIA in eigenem Fenster öffnen";

  doc
    .querySelectorAll<HTMLElement>('[data-zai-popout-button="true"]')
    .forEach((button) => {
      button.classList.toggle("zai-header-icon-button-active", open);
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(open));
      button.setAttribute("title", label);
    });
}

/**
 * Returns a live popout state and clears stale closed-window state.
 *
 * @param owner - Owner window whose popout state should be inspected.
 * @returns Live popout state, or null when no live popout exists.
 */
function getLivePopoutState(owner: Window) {
  const state = popouts.get(owner);
  if (!state) return null;

  if (state.window.closed) {
    popouts.delete(owner);
    syncAssistantPopoutButtons(owner, false);
    emitAssistantPopoutState(owner, false);
    return null;
  }

  return state;
}

/**
 * Emits a popout state event on the owner window.
 *
 * @param owner - Owner window receiving the event.
 * @param open - Current popout open state.
 * @returns Nothing.
 */
function emitAssistantPopoutState(owner: Window, open: boolean) {
  owner.dispatchEvent(
    new owner.CustomEvent(ASSISTANT_POPOUT_STATE_EVENT, {
      detail: { open },
    }),
  );
}

/**
 * Copies relevant sidebar theme values into the popout document.
 *
 * @param popoutWindow - Popout window whose document should be styled.
 * @param owner - Owner window used as the style source.
 * @param root - Popout root element receiving inherited appearance.
 * @returns Nothing.
 */
function syncPopoutAppearance(
  popoutWindow: Window,
  owner: _ZoteroTypes.MainWindow,
  root: HTMLElement,
) {
  const ownerDoc = owner.document;
  const sourceHost =
    ownerDoc.querySelector<HTMLElement>(".zai-standalone-sidebar") ??
    ownerDoc.querySelector<HTMLElement>(".zotero-ai-assistant-host") ??
    ownerDoc.documentElement;
  const sourceSidebar =
    sourceHost.querySelector<HTMLElement>(".zai-sidebar") ??
    ownerDoc.querySelector<HTMLElement>(".zai-sidebar") ??
    sourceHost;
  const sourceHostStyle = owner.getComputedStyle(sourceHost);
  const sourceSidebarStyle = owner.getComputedStyle(sourceSidebar);
  if (!sourceHostStyle || !sourceSidebarStyle) {
    return;
  }

  const targetRoot = popoutWindow.document.documentElement;
  const targetStyle = targetRoot.style;

  for (const property of SIDEBAR_THEME_PROPERTIES) {
    const value =
      sourceSidebarStyle.getPropertyValue(property) ||
      sourceHostStyle.getPropertyValue(property);
    if (value.trim()) {
      targetStyle.setProperty(property, value.trim());
    }
  }

  setStyleProperty(
    targetStyle,
    "--material-sidepane",
    sourceSidebarStyle.backgroundColor || sourceHostStyle.backgroundColor,
  );
  setStyleProperty(
    targetStyle,
    "--text-primary",
    sourceSidebarStyle.color || sourceHostStyle.color,
  );
  setStyleProperty(
    targetStyle,
    "--border-color",
    sourceHostStyle.borderLeftColor,
  );

  copyStyleProperty(sourceSidebarStyle, targetStyle, "color-scheme");
  copyFontStyle(sourceSidebarStyle, targetStyle);

  targetStyle.background =
    sourceSidebarStyle.backgroundColor || sourceHostStyle.backgroundColor;
  targetStyle.color = sourceSidebarStyle.color || sourceHostStyle.color;
  if (popoutWindow.document.body) {
    popoutWindow.document.body.style.background = "inherit";
    popoutWindow.document.body.style.color = "inherit";
    popoutWindow.document.body.style.font = "inherit";
  }
  root.style.background = "inherit";
  root.style.color = "inherit";
}

/**
 * Copies font-related style properties from one style declaration to another.
 *
 * @param sourceStyle - Computed style used as the source.
 * @param targetStyle - Inline style declaration receiving values.
 * @returns Nothing.
 */
function copyFontStyle(
  sourceStyle: CSSStyleDeclaration,
  targetStyle: CSSStyleDeclaration,
) {
  for (const property of [
    "font-family",
    "font-size",
    "font-stretch",
    "font-style",
    "font-variant",
    "font-weight",
    "line-height",
  ]) {
    copyStyleProperty(sourceStyle, targetStyle, property);
  }
}

/**
 * Copies a non-empty CSS property value between style declarations.
 *
 * @param sourceStyle - Computed style used as the source.
 * @param targetStyle - Inline style declaration receiving values.
 * @param property - CSS property name to copy.
 * @returns Nothing.
 */
function copyStyleProperty(
  sourceStyle: CSSStyleDeclaration,
  targetStyle: CSSStyleDeclaration,
  property: string,
) {
  const value = sourceStyle.getPropertyValue(property).trim();
  if (value) {
    targetStyle.setProperty(property, value);
  }
}

/**
 * Sets a CSS property when the value is non-empty.
 *
 * @param targetStyle - Inline style declaration receiving the value.
 * @param property - CSS property name to set.
 * @param value - CSS value to apply.
 * @returns Nothing.
 */
function setStyleProperty(
  targetStyle: CSSStyleDeclaration,
  property: string,
  value: string,
) {
  if (value.trim()) {
    targetStyle.setProperty(property, value.trim());
  }
}

/**
 * Keeps a popout window from being resized below the supported minimum size.
 *
 * @param win - Popout window to guard.
 * @returns Cleanup callback that removes resize handlers.
 */
function installResizeGuard(win: Window) {
  let pendingFrame: number | undefined;

  const enforceMinSize = () => {
    if (pendingFrame !== undefined) {
      return;
    }

    pendingFrame = win.requestAnimationFrame(() => {
      pendingFrame = undefined;
      const width = Math.max(win.outerWidth || 0, POPOUT_MIN_WIDTH);
      const height = Math.max(win.outerHeight || 0, POPOUT_MIN_HEIGHT);
      if (width !== win.outerWidth || height !== win.outerHeight) {
        win.resizeTo(width, height);
      }
    });
  };

  win.addEventListener("resize", enforceMinSize);
  enforceMinSize();

  return () => {
    if (pendingFrame !== undefined) {
      win.cancelAnimationFrame(pendingFrame);
    }
    win.removeEventListener("resize", enforceMinSize);
  };
}

/**
 * Focuses the assistant composer after the popout content has rendered.
 *
 * @param win - Popout window containing the composer.
 * @returns Nothing.
 */
function focusComposer(win: Window) {
  win.setTimeout(() => {
    win.document.querySelector<HTMLTextAreaElement>(".zai-input")?.focus();
  }, 0);
}
