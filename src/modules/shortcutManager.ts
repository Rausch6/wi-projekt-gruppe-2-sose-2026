import {
  createChatAndFocusComposer,
  focusAssistantComposer,
  focusModelSelection,
  openContextWindow,
  toggleActiveChatFavorite,
} from "../ui/assistantChatController";
import {
  closeAssistantSidebar,
  focusAssistantSidebar,
  isAssistantSidebarFocused,
  isAssistantSidebarOpen,
  openAssistantSidebar,
} from "../ui/assistantSidebarController";
import {
  focusAssistantPopoutWindow,
  openAssistantPopoutWindow,
} from "../ui/assistantPopoutWindow";

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

/**
 * Represents an executable shortcut action for a Zotero main window.
 */
type ShortcutAction = (win: _ZoteroTypes.MainWindow) => void | Promise<void>;

/**
 * Defines a ZAIA keyboard shortcut and its action.
 */
type ShortcutDefinition = {
  id: string;
  key: string;
  action: ShortcutAction;
};

const ZOTERO_DEFAULT_SHORTCUT_KEYS = new Set([
  "A",
  "C",
  "K",
  "L",
  "N",
  "O",
  "R",
]);

const shortcutRegistrations = new WeakMap<Window, () => void>();
const registeredWindows = new Set<Window>();

const ZAIA_SHORTCUTS: ShortcutDefinition[] = [
  {
    id: "toggle-sidebar",
    key: "I",
    action: toggleSidebarFocus,
  },
  {
    id: "new-chat",
    key: "M",
    action: startNewChat,
  },
  {
    id: "open-popout",
    key: "P",
    action: openOrFocusPopout,
  },
  {
    id: "favorite-chat",
    key: "F",
    action: favoriteActiveChat,
  },
  {
    id: "open-context",
    key: "T",
    action: openContext,
  },
  {
    id: "focus-model",
    key: "D",
    action: focusModel,
  },
];

/**
 * Registers all ZAIA keyboard shortcuts for a Zotero main window.
 *
 * @param win - Zotero main window that should receive shortcut handlers.
 * @returns Nothing.
 */
export function registerZAIAShortcuts(win: _ZoteroTypes.MainWindow) {
  unregisterZAIAShortcuts(win);
  validateShortcutDefinitions();

  let lastRun: { id: string; at: number } | null = null;
  const activeShortcutIDs = new Set<string>();
  const runShortcut = (shortcut: ShortcutDefinition) => {
    const now = Date.now();
    if (lastRun?.id === shortcut.id && now - lastRun.at < 250) {
      return;
    }
    lastRun = { id: shortcut.id, at: now };

    void Promise.resolve(shortcut.action(win)).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      Zotero.logError(error instanceof Error ? error : new Error(message));
      showShortcutNotification(`ZAIA Shortcut fehlgeschlagen: ${message}`);
    });
  };

  const onKeyEvent = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;

    if (isReservedZoteroShortcut(event)) {
      return;
    }

    const shortcut = ZAIA_SHORTCUTS.find((definition) =>
      matchesShortcut(event, definition.key),
    );
    if (!shortcut) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.type === "keydown") {
      if (event.repeat || activeShortcutIDs.has(shortcut.id)) {
        return;
      }

      activeShortcutIDs.add(shortcut.id);
      runShortcut(shortcut);
      return;
    }

    if (event.type === "keyup") {
      const handledByKeydown = activeShortcutIDs.delete(shortcut.id);
      if (handledByKeydown) {
        return;
      }

      runShortcut(shortcut);
    }
  };
  const clearActiveShortcuts = () => activeShortcutIDs.clear();
  const keyset = createXULShortcutKeyset(win, runShortcut);

  win.addEventListener("keydown", onKeyEvent, true);
  win.addEventListener("keyup", onKeyEvent, true);
  win.addEventListener("blur", clearActiveShortcuts, true);
  win.document.addEventListener("keydown", onKeyEvent, true);
  win.document.addEventListener("keyup", onKeyEvent, true);
  const cleanup = () => {
    win.removeEventListener("keydown", onKeyEvent, true);
    win.removeEventListener("keyup", onKeyEvent, true);
    win.removeEventListener("blur", clearActiveShortcuts, true);
    win.document.removeEventListener("keydown", onKeyEvent, true);
    win.document.removeEventListener("keyup", onKeyEvent, true);
    keyset?.remove();
    shortcutRegistrations.delete(win);
    registeredWindows.delete(win);
  };

  shortcutRegistrations.set(win, cleanup);
  registeredWindows.add(win);
  Zotero.debug(
    `ZAIA Shortcuts registriert: ${formatShortcutList().join(", ")}`,
  );
}

/**
 * Unregisters ZAIA keyboard shortcuts for a window.
 *
 * @param win - Window whose shortcut registration should be removed.
 * @returns Nothing.
 */
export function unregisterZAIAShortcuts(win: Window) {
  shortcutRegistrations.get(win)?.();
}

/**
 * Unregisters ZAIA keyboard shortcuts from every registered window.
 *
 * @returns Nothing.
 */
export function unregisterAllZAIAShortcuts() {
  for (const win of [...registeredWindows]) {
    unregisterZAIAShortcuts(win);
  }
}

/**
 * Creates a XUL keyset fallback for ZAIA shortcuts.
 *
 * @param win - Zotero main window that should receive the keyset.
 * @param runShortcut - Callback used to execute matched shortcuts.
 * @returns Created keyset element.
 */
function createXULShortcutKeyset(
  win: _ZoteroTypes.MainWindow,
  runShortcut: (shortcut: ShortcutDefinition) => void,
) {
  const doc = win.document;
  const createXULElement =
    (
      doc as Document & { createXULElement?: (tagName: string) => XULElement }
    ).createXULElement?.bind(doc) ??
    ((tagName: string) => doc.createElementNS(XUL_NS, tagName) as XULElement);
  const keysetID = `${addon.data.config.addonRef}-zaia-shortcut-keyset`;
  doc.getElementById(keysetID)?.remove();

  const keyset = createXULElement("keyset");
  keyset.id = keysetID;

  for (const shortcut of ZAIA_SHORTCUTS) {
    const key = createXULElement("key");
    key.id = `${addon.data.config.addonRef}-zaia-shortcut-${shortcut.id}`;
    key.setAttribute("key", shortcut.key.toLowerCase());
    key.setAttribute("modifiers", "accel,shift");
    key.addEventListener("command", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runShortcut(shortcut);
    });
    keyset.append(key);
  }

  doc.documentElement.append(keyset);
  return keyset;
}

/**
 * Validates that ZAIA shortcuts do not collide with reserved Zotero defaults.
 *
 * @returns Nothing.
 */
function validateShortcutDefinitions() {
  for (const shortcut of ZAIA_SHORTCUTS) {
    const key = normalizeShortcutKey(shortcut.key);
    if (ZOTERO_DEFAULT_SHORTCUT_KEYS.has(key)) {
      throw new Error(
        `ZAIA Shortcut ${shortcut.id} kollidiert mit Zotero-Default Cmd/Ctrl+Shift+${key}.`,
      );
    }
  }
}

/**
 * Checks whether a keyboard event matches a reserved Zotero shortcut.
 *
 * @param event - Keyboard event to inspect.
 * @returns True when the shortcut is reserved by Zotero.
 */
function isReservedZoteroShortcut(event: KeyboardEvent) {
  if (!hasPlatformAccelerator(event) || !event.shiftKey || event.altKey) {
    return false;
  }

  return ZOTERO_DEFAULT_SHORTCUT_KEYS.has(normalizeShortcutKey(event.key));
}

/**
 * Checks whether a keyboard event matches a configured shortcut key.
 *
 * @param event - Keyboard event to inspect.
 * @param key - Shortcut key to match.
 * @returns True when the event matches the ZAIA shortcut pattern.
 */
function matchesShortcut(event: KeyboardEvent, key: string) {
  return (
    hasPlatformAccelerator(event) &&
    event.shiftKey &&
    !event.altKey &&
    normalizeShortcutKey(event.key) === normalizeShortcutKey(key)
  );
}

/**
 * Checks whether a keyboard event uses the platform accelerator key.
 *
 * @param event - Keyboard event to inspect.
 * @returns True when Cmd on macOS or Ctrl elsewhere is active.
 */
function hasPlatformAccelerator(event: KeyboardEvent) {
  return Zotero.isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/**
 * Normalizes a shortcut key for comparison.
 *
 * @param key - Shortcut key to normalize.
 * @returns Uppercase single-character key or original non-character key.
 */
function normalizeShortcutKey(key: string) {
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Formats all configured shortcuts for logging.
 *
 * @returns List of human-readable shortcut labels.
 */
function formatShortcutList() {
  return ZAIA_SHORTCUTS.map((shortcut) => formatShortcut(shortcut.key));
}

/**
 * Formats a shortcut key with platform-specific modifiers.
 *
 * @param key - Shortcut key to format.
 * @returns Human-readable shortcut label.
 */
function formatShortcut(key: string) {
  const modifier = Zotero.isMac ? "Cmd" : "Ctrl";
  return `${modifier}+Shift+${key.toUpperCase()}`;
}

/**
 * Toggles assistant sidebar visibility or focus.
 *
 * @param win - Zotero main window containing the sidebar.
 * @returns Nothing.
 */
function toggleSidebarFocus(win: _ZoteroTypes.MainWindow) {
  if (!isAssistantSidebarOpen(win)) {
    openAssistantSidebar(win);
    focusAssistantSidebar(win);
    return;
  }

  if (!isAssistantSidebarFocused(win)) {
    focusAssistantSidebar(win);
    return;
  }

  closeAssistantSidebar(win);
  focusZoteroLibrary(win);
}

/**
 * Opens the assistant sidebar and starts a new chat.
 *
 * @param win - Zotero main window containing the assistant UI.
 * @returns Promise that resolves after the new chat composer is focused.
 */
async function startNewChat(win: _ZoteroTypes.MainWindow) {
  openAssistantSidebar(win);
  focusAssistantSidebar(win);
  await createChatAndFocusComposer();
  focusAssistantComposer(win);
  showShortcutNotification("Neuer ZAIA-Chat gestartet");
}

/**
 * Opens the assistant popout window or focuses an existing one.
 *
 * @param win - Zotero main window owning the popout.
 * @returns Nothing.
 */
function openOrFocusPopout(win: _ZoteroTypes.MainWindow) {
  if (focusAssistantPopoutWindow(win)) return;

  const openedWindow = openAssistantPopoutWindow(win, {
    onBeforeOpen: () => closeAssistantSidebar(win),
    onClose: () => {
      win.focus();
      openAssistantSidebar(win);
      focusAssistantSidebar(win);
    },
  });

  if (!openedWindow) {
    showShortcutNotification("ZAIA-Popout konnte nicht geöffnet werden");
  }
}

/**
 * Toggles the favorite state of the active chat.
 *
 * @param win - Zotero main window containing the assistant UI.
 * @returns Promise that resolves after the favorite state was toggled.
 */
async function favoriteActiveChat(win: _ZoteroTypes.MainWindow) {
  openAssistantSidebar(win);
  const isFavorite = await toggleActiveChatFavorite();
  showShortcutNotification(
    isFavorite ? "ZAIA-Chat favorisiert" : "ZAIA-Chat-Favorit entfernt",
  );
}

/**
 * Opens the assistant context window once the sidebar is ready.
 *
 * @param win - Zotero main window containing the assistant UI.
 * @returns Nothing.
 */
function openContext(win: _ZoteroTypes.MainWindow) {
  openAssistantSidebar(win);
  openContextWhenReady(win);
}

/**
 * Focuses the model selector in the assistant sidebar.
 *
 * @param win - Zotero main window containing the assistant UI.
 * @returns Nothing.
 */
function focusModel(win: _ZoteroTypes.MainWindow) {
  openAssistantSidebar(win);
  focusAssistantSidebar(win);
  win.setTimeout(() => {
    if (!focusModelSelection(win)) {
      focusAssistantComposer(win);
    }
  }, 0);
}

/**
 * Retries opening the context window until the assistant sidebar is ready.
 *
 * @param win - Zotero main window containing the assistant UI.
 * @returns Nothing.
 */
function openContextWhenReady(win: _ZoteroTypes.MainWindow) {
  let attempts = 0;
  const tryOpen = () => {
    attempts += 1;
    if (openContextWindow(win) || attempts >= 30) {
      return;
    }

    win.setTimeout(tryOpen, 50);
  };

  win.requestAnimationFrame(() => {
    win.requestAnimationFrame(tryOpen);
  });
}

/**
 * Returns keyboard focus to Zotero's library pane.
 *
 * @param win - Zotero main window containing the library pane.
 * @returns Nothing.
 */
function focusZoteroLibrary(win: _ZoteroTypes.MainWindow) {
  const pane = (win as unknown as { ZoteroPane?: _ZoteroTypes.ZoteroPane })
    .ZoteroPane;

  if (pane?.itemsView) {
    pane.itemsView.focus();
    return;
  }

  (win.document.activeElement as HTMLElement | null)?.blur?.();
}

/**
 * Logs a shortcut notification.
 *
 * @param text - Notification text to log.
 * @returns Nothing.
 */
function showShortcutNotification(text: string) {
  Zotero.debug(`[ZAIA Shortcut] ${text}`);
}
