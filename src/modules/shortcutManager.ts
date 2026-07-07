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

type ShortcutAction = (win: _ZoteroTypes.MainWindow) => void | Promise<void>;

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

export function unregisterZAIAShortcuts(win: Window) {
  shortcutRegistrations.get(win)?.();
}

export function unregisterAllZAIAShortcuts() {
  for (const win of [...registeredWindows]) {
    unregisterZAIAShortcuts(win);
  }
}

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

function isReservedZoteroShortcut(event: KeyboardEvent) {
  if (!hasPlatformAccelerator(event) || !event.shiftKey || event.altKey) {
    return false;
  }

  return ZOTERO_DEFAULT_SHORTCUT_KEYS.has(normalizeShortcutKey(event.key));
}

function matchesShortcut(event: KeyboardEvent, key: string) {
  return (
    hasPlatformAccelerator(event) &&
    event.shiftKey &&
    !event.altKey &&
    normalizeShortcutKey(event.key) === normalizeShortcutKey(key)
  );
}

function hasPlatformAccelerator(event: KeyboardEvent) {
  return Zotero.isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

function normalizeShortcutKey(key: string) {
  return key.length === 1 ? key.toUpperCase() : key;
}

function formatShortcutList() {
  return ZAIA_SHORTCUTS.map((shortcut) => formatShortcut(shortcut.key));
}

function formatShortcut(key: string) {
  const modifier = Zotero.isMac ? "Cmd" : "Ctrl";
  return `${modifier}+Shift+${key.toUpperCase()}`;
}

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

async function startNewChat(win: _ZoteroTypes.MainWindow) {
  openAssistantSidebar(win);
  focusAssistantSidebar(win);
  await createChatAndFocusComposer();
  focusAssistantComposer(win);
  showShortcutNotification("Neuer ZAIA-Chat gestartet");
}

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

async function favoriteActiveChat(win: _ZoteroTypes.MainWindow) {
  openAssistantSidebar(win);
  const isFavorite = await toggleActiveChatFavorite();
  showShortcutNotification(
    isFavorite ? "ZAIA-Chat favorisiert" : "ZAIA-Chat-Favorit entfernt",
  );
}

function openContext(win: _ZoteroTypes.MainWindow) {
  openAssistantSidebar(win);
  openContextWhenReady(win);
}

function focusModel(win: _ZoteroTypes.MainWindow) {
  openAssistantSidebar(win);
  focusAssistantSidebar(win);
  win.setTimeout(() => {
    if (!focusModelSelection(win)) {
      focusAssistantComposer(win);
    }
  }, 0);
}

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

function focusZoteroLibrary(win: _ZoteroTypes.MainWindow) {
  const pane = (win as unknown as { ZoteroPane?: _ZoteroTypes.ZoteroPane })
    .ZoteroPane;

  if (pane?.itemsView) {
    pane.itemsView.focus();
    return;
  }

  (win.document.activeElement as HTMLElement | null)?.blur?.();
}

function showShortcutNotification(text: string) {
  Zotero.debug(`[ZAIA Shortcut] ${text}`);
}
