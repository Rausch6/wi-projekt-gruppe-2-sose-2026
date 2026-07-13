import { config } from "../../package.json";
import { createWindowAbortController } from "../utils/AbortController";
import { LOCAL_OLLAMA_MODEL_CATALOG } from "./localOllamaModels";

export const LOCAL_OLLAMA_MODEL_INSTALLED_EVENT =
  "zai-local-ollama-model-installed";
export const LOCAL_OLLAMA_MODELS_CHANGED_EVENT =
  "zai-local-ollama-models-changed";

const LOCAL_MODEL_WINDOW_ROOT_ID = `${config.addonRef}-local-ollama-model-window-root`;
const LOCAL_MODEL_WINDOW_DEFAULT_WIDTH = 540;
const LOCAL_MODEL_WINDOW_DEFAULT_HEIGHT = 500;
const LOCAL_MODEL_WINDOW_MIN_WIDTH = LOCAL_MODEL_WINDOW_DEFAULT_WIDTH;
const LOCAL_MODEL_WINDOW_MIN_HEIGHT = LOCAL_MODEL_WINDOW_DEFAULT_HEIGHT;
const LOCAL_MODEL_WINDOW_MAX_WIDTH = LOCAL_MODEL_WINDOW_DEFAULT_WIDTH;
const LOCAL_MODEL_WINDOW_MAX_HEIGHT = LOCAL_MODEL_WINDOW_DEFAULT_HEIGHT;
const SIDEBAR_THEME_PROPERTIES = [
  "--accent-blue",
  "--border-color",
  "--fill-quinary",
  "--material-background",
  "--material-sidepane",
  "--text-primary",
  "--text-secondary",
];
const HTML_NS = "http://www.w3.org/1999/xhtml";

type LocalModelWindowState = {
  activeOperationModel?: string;
  cancelTimers: Map<string, number>;
  controllers: Map<string, AbortController>;
  cleanup?: () => void;
  disposed?: boolean;
  window: Window;
};

type LocalModelWindowContext = {
  owner: _ZoteroTypes.MainWindow;
  window: Window;
};

type LocalModelNoticeState = "info" | "success" | "warning" | "error";
type LocalModelStatusState = "success" | "warning" | "error" | "";

export type LocalModelProgress = {
  completed: number | null;
  done: boolean;
  percent: number | null;
  status: string;
  total: number | null;
};

type LocalModelRowElements = {
  button: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  deleteButton: HTMLButtonElement;
  installed: boolean;
  model: string;
  operationId: number;
  progress: HTMLElement;
  progressFill: HTMLElement;
  row: HTMLElement;
  status: HTMLElement;
};

type LocalModelWindowElements = {
  notice: HTMLElement;
  noticeActions: HTMLElement;
  noticeText: HTMLElement;
  refreshButton: HTMLButtonElement;
  rows: LocalModelRowElements[];
  setupButton: HTMLButtonElement;
};

const localModelWindows = new WeakMap<Window, LocalModelWindowState>();

export function openLocalOllamaModelWindow(owner: _ZoteroTypes.MainWindow) {
  const existing = getLiveLocalModelWindow(owner);
  if (existing) {
    existing.window.focus();
    return existing.window;
  }

  const features = [
    "chrome",
    "centerscreen",
    "dialog=no",
    "resizable=no",
    `width=${LOCAL_MODEL_WINDOW_DEFAULT_WIDTH}`,
    `height=${LOCAL_MODEL_WINDOW_DEFAULT_HEIGHT}`,
    `minwidth=${LOCAL_MODEL_WINDOW_MIN_WIDTH}`,
    `minheight=${LOCAL_MODEL_WINDOW_MIN_HEIGHT}`,
    `maxwidth=${LOCAL_MODEL_WINDOW_MAX_WIDTH}`,
    `maxheight=${LOCAL_MODEL_WINDOW_MAX_HEIGHT}`,
  ].join(",");

  const openedWindow = owner.openDialog(
    `chrome://${config.addonRef}/content/localOllamaModelWindow.xhtml`,
    `${config.addonRef}-local-ollama-model-${Date.now()}`,
    features,
    {
      addonInstance: config.addonInstance,
      owner,
    },
  ) as Window | null;

  if (!openedWindow) return null;

  localModelWindows.set(owner, {
    cancelTimers: new Map<string, number>(),
    controllers: new Map<string, AbortController>(),
    disposed: false,
    window: openedWindow,
  });
  return openedWindow;
}

export function initializeLocalOllamaModelWindow(
  modelWindow: Window,
  owner: _ZoteroTypes.MainWindow,
) {
  let state = localModelWindows.get(owner);
  if (!state || state.window !== modelWindow) {
    state = {
      cancelTimers: new Map<string, number>(),
      controllers: new Map<string, AbortController>(),
      disposed: false,
      window: modelWindow,
    };
    localModelWindows.set(owner, state);
  }
  state.disposed = false;

  const doc = modelWindow.document;
  const root = doc.getElementById(
    LOCAL_MODEL_WINDOW_ROOT_ID,
  ) as HTMLElement | null;
  if (!root) return;

  doc.documentElement.classList.add("zai-local-model-document");
  doc.body?.classList.add("zai-local-model-body");
  syncLocalModelWindowAppearance(modelWindow, owner, root);
  const context = { owner, window: modelWindow };
  const { elements, fragment } = createWindowContent(context, state);
  root.replaceChildren(fragment);
  void refreshInstalledModels(context, state, elements);

  state.cleanup?.();
  const removeResizeGuard = installFixedSizeGuard(modelWindow);
  state.cleanup = () => {
    abortActiveDownloads(state);
    removeResizeGuard();
  };

  return state.cleanup;
}

export function handleLocalOllamaModelWindowUnload(
  modelWindow: Window,
  owner: Window,
) {
  const state = localModelWindows.get(owner);
  if (state?.window === modelWindow) {
    state.disposed = true;
    abortActiveDownloads(state);
    state.cleanup?.();
    localModelWindows.delete(owner);
  }
}

function getLiveLocalModelWindow(owner: Window) {
  const state = localModelWindows.get(owner);
  if (!state || state.window.closed) {
    if (state) localModelWindows.delete(owner);
    return null;
  }

  return state;
}

function createWindowContent(
  context: LocalModelWindowContext,
  state: LocalModelWindowState,
) {
  const doc = context.window.document;
  const fragment = doc.createDocumentFragment();
  const header = createHtmlElement(
    doc,
    "header",
    "zai-local-model-window-header",
  );
  const title = createHtmlElement(doc, "h1", "zai-local-model-window-title");
  const description = createHtmlElement(
    doc,
    "p",
    "zai-local-model-window-description",
  );
  const content = createHtmlElement(
    doc,
    "section",
    "zai-local-model-window-content",
  );
  const notice = createHtmlElement(doc, "section", "zai-local-model-notice");
  const noticeText = createHtmlElement(doc, "p", "zai-local-model-notice-text");
  const noticeActions = createHtmlElement(
    doc,
    "div",
    "zai-local-model-notice-actions",
  );
  const setupButton = createHtmlButton(
    doc,
    "zai-local-model-secondary-button",
    "Setup öffnen",
  );
  const refreshButton = createHtmlButton(
    doc,
    "zai-local-model-secondary-button",
    "Erneut prüfen",
  );
  const footer = createHtmlElement(
    doc,
    "footer",
    "zai-local-model-window-footer",
  );
  const libraryLink = createHtmlElement(
    doc,
    "a",
    "zai-local-model-library-link",
    "Ollama Library öffnen",
  ) as HTMLAnchorElement;

  title.textContent = "Lokales Modell hinzufügen";
  description.textContent =
    "Wähle ein Ollama-Modell aus. Große Modelle benötigen mehr Speicherplatz und Downloadzeit.";

  const rows = LOCAL_OLLAMA_MODEL_CATALOG.map((model) =>
    createModelRow(context, model),
  );
  content.append(...rows.map((row) => row.row));

  setupButton.addEventListener("click", () => {
    void launchSetupAndRefresh(context, state, elements);
  });
  refreshButton.addEventListener("click", () => {
    void refreshInstalledModels(context, state, elements);
  });

  noticeActions.append(setupButton, refreshButton);
  notice.append(noticeText, noticeActions);
  libraryLink.href = "https://ollama.com/library";
  libraryLink.addEventListener("click", (event) => {
    event.preventDefault();
    Zotero.launchURL(libraryLink.href);
  });
  footer.append(libraryLink);

  header.append(title, description);
  fragment.append(header, notice, content, footer);

  const elements: LocalModelWindowElements = {
    notice,
    noticeActions,
    noticeText,
    refreshButton,
    rows,
    setupButton,
  };
  for (const row of rows) {
    row.button.addEventListener("click", () => {
      if (row.installed) {
        selectInstalledModel(context, row);
        return;
      }

      void downloadModel(context, state, elements, row);
    });
    row.cancelButton.addEventListener("click", () => {
      cancelDownload(context, state, elements, row);
    });
    row.deleteButton.addEventListener("click", () => {
      void deleteInstalledModel(context, state, elements, row);
    });
  }
  setNotice(elements, "Modelle werden geprüft...", "info", {
    showActions: false,
  });
  setRowsChecking(elements.rows);

  return { elements, fragment };
}

function createModelRow(
  context: LocalModelWindowContext,
  model: (typeof LOCAL_OLLAMA_MODEL_CATALOG)[number],
) {
  const doc = context.window.document;
  const row = createHtmlElement(doc, "article", "zai-local-model-row");
  const meta = createHtmlElement(doc, "div", "zai-local-model-meta");
  const name = createHtmlElement(doc, "strong", "zai-local-model-name");
  const size = createHtmlElement(doc, "span", "zai-local-model-size");
  const actions = createHtmlElement(doc, "div", "zai-local-model-actions");
  const button = createHtmlButton(
    doc,
    "zai-local-model-download-button",
    "Download",
  );
  const cancelButton = createHtmlButton(
    doc,
    "zai-local-model-cancel-button",
    "Abbrechen",
  );
  const deleteButton = createHtmlButton(
    doc,
    "zai-local-model-delete-button",
    "Löschen",
  );
  const progress = createHtmlElement(doc, "div", "zai-local-model-progress");
  const progressFill = createHtmlElement(
    doc,
    "span",
    "zai-local-model-progress-fill",
  );
  const status = createHtmlElement(doc, "p", "zai-local-model-status");
  const rowElements: LocalModelRowElements = {
    button,
    cancelButton,
    deleteButton,
    installed: false,
    model: model.id,
    operationId: 0,
    progress,
    progressFill,
    row,
    status,
  };

  button.dataset.state = "idle";
  button.setAttribute("aria-label", `${model.id} herunterladen, ${model.size}`);
  button.title = `${model.id} herunterladen (${model.size})`;
  cancelButton.hidden = true;
  deleteButton.hidden = true;
  name.textContent = model.id;
  size.textContent = model.size;
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  progress.hidden = true;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;

  meta.append(name, size);
  progress.append(progressFill);
  actions.append(button, deleteButton, cancelButton);
  row.append(meta, actions, progress, status);
  return rowElements;
}

async function refreshInstalledModels(
  context: LocalModelWindowContext,
  state: LocalModelWindowState,
  elements: LocalModelWindowElements,
) {
  setNotice(elements, "Modelle werden geprüft...", "info", {
    showActions: false,
  });
  setRowsChecking(elements.rows);

  try {
    const installedModels = await waitForInstalledModels(context, 1);
    if (!isLocalModelWindowActive(context, state)) return;

    const installedModelIds = new Set(
      installedModels.map((model) => model.id.trim()).filter(Boolean),
    );
    syncInstalledRows(context, elements.rows, installedModelIds);
    setNotice(elements, "Ollama ist erreichbar.", "success", {
      hidden: true,
    });
  } catch (error) {
    if (!isLocalModelWindowActive(context, state)) return;

    logLocalModelError(error);
    setRowsUnavailable(elements.rows);
    setNotice(elements, getFriendlyErrorMessage(error), "error", {
      showActions: true,
    });
  } finally {
    if (isLocalModelWindowActive(context, state)) {
      syncOperationLocks(context, state, elements.rows);
    }
  }
}

async function launchSetupAndRefresh(
  _context: LocalModelWindowContext,
  _state: LocalModelWindowState,
  elements: LocalModelWindowElements,
) {
  try {
    if (typeof addon.api.launchOllamaSetup !== "function") {
      throw new Error("setup-unavailable");
    }

    await addon.api.launchOllamaSetup(
      addon.data.settings.embeddingSearchEnabled
        ? "local-with-embedding"
        : "local",
    );
    setNotice(
      elements,
      "Das Ollama-Setup wurde geöffnet. Prüfe danach erneut.",
      "warning",
      { showActions: true },
    );
  } catch (error) {
    logLocalModelError(error);
    setNotice(elements, getFriendlyErrorMessage(error), "error", {
      showActions: true,
    });
  }
}

async function waitForInstalledModels(
  context: LocalModelWindowContext,
  attempts: number,
) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await listInstalledModels();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await wait(context.window, 1500);
      }
    }
  }

  throw lastError;
}

async function listInstalledModels() {
  const provider = addon.api.ai.getProvider("ollama");
  if (typeof provider.listModels !== "function") {
    throw new Error("list-models-unavailable");
  }

  return (await provider.listModels()) as Array<{ id: string }>;
}

async function downloadModel(
  context: LocalModelWindowContext,
  state: LocalModelWindowState,
  elements: LocalModelWindowElements,
  row: LocalModelRowElements,
) {
  if (state.activeOperationModel || state.controllers.has(row.model)) return;

  const provider = addon.api.ai.getProvider("ollama");
  if (typeof provider.pullModel !== "function") {
    setStatus(row.status, "Ollama unterstützt keine Modelldownloads.", "error");
    return;
  }

  const controller = createWindowAbortController(context.window);
  const operationId = beginRowOperation(state, row);
  state.controllers.set(row.model, controller);
  setRowDownloading(row);
  syncOperationLocks(context, state, elements.rows);

  try {
    await provider.pullModel(row.model, {
      inactivityTimeout: 120_000,
      signal: controller.signal,
      onProgress: (progress: LocalModelProgress) => {
        if (!isRowOperationActive(context, state, row, operationId)) return;
        updateDownloadProgress(row, progress);
      },
    });
    if (!isRowOperationActive(context, state, row, operationId)) return;

    row.installed = true;
    notifyModelInstalled(context, row.model);
    notifyModelsChanged(context);
    setProgress(row, 100);
    setStatus(
      row.status,
      `${row.model} ist installiert und ausgewählt.`,
      "success",
    );
    syncInstalledRow(context, row);
  } catch (error) {
    if (!isRowOperationActive(context, state, row, operationId)) return;

    if (isAbortError(error)) {
      setStatus(row.status, "Download abgebrochen.", "warning");
      resetDownloadRow(context, row);
      return;
    }

    logLocalModelError(error);
    setStatus(row.status, getFriendlyErrorMessage(error), "error");
    resetDownloadRow(context, row, "Erneut versuchen");
  } finally {
    const operationStillActive = isRowOperationActive(
      context,
      state,
      row,
      operationId,
    );
    if (state.controllers.get(row.model) === controller) {
      clearCancelTimer(context, state, row.model);
      state.controllers.delete(row.model);
    }
    if (operationStillActive && state.activeOperationModel === row.model) {
      state.activeOperationModel = undefined;
    }
    if (operationStillActive) {
      row.cancelButton.hidden = true;
      row.cancelButton.disabled = false;
    }
    if (operationStillActive) {
      syncUnlockedRows(context, elements.rows);
    }
  }
}

function cancelDownload(
  context: LocalModelWindowContext,
  state: LocalModelWindowState,
  elements: LocalModelWindowElements,
  row: LocalModelRowElements,
) {
  const controller = state.controllers.get(row.model);
  if (!controller) return;

  row.cancelButton.disabled = true;
  setStatus(row.status, "Download wird abgebrochen...", "warning");
  controller.abort();
  clearCancelTimer(context, state, row.model);
  const operationId = row.operationId;
  const timer = context.window.setTimeout(() => {
    void forceStopUnresponsiveDownloadCancel(
      context,
      state,
      elements,
      row,
      operationId,
      controller,
    );
  }, 2500);
  state.cancelTimers.set(row.model, timer);
}

async function forceStopUnresponsiveDownloadCancel(
  context: LocalModelWindowContext,
  state: LocalModelWindowState,
  elements: LocalModelWindowElements,
  row: LocalModelRowElements,
  operationId: number,
  controller: AbortController,
) {
  if (!isRowOperationActive(context, state, row, operationId)) return;
  if (state.controllers.get(row.model) !== controller) return;

  setStatus(row.status, "Download wird beendet...", "warning");

  try {
    if (typeof addon.api.stopOllama === "function") {
      await addon.api.stopOllama();
    }

    if (!isRowOperationActive(context, state, row, operationId)) return;

    state.controllers.delete(row.model);
    if (state.activeOperationModel === row.model) {
      state.activeOperationModel = undefined;
    }
    row.operationId += 1;
    resetDownloadRow(context, row);
    setRowsUnavailable(elements.rows);
    setStatus(row.status, "Download abgebrochen.", "warning");
    setNotice(elements, "Download wurde abgebrochen.", "warning", {
      showActions: true,
    });
  } catch (error) {
    if (!isRowOperationActive(context, state, row, operationId)) return;

    logLocalModelError(error);
    setStatus(
      row.status,
      "Download konnte nicht vollständig abgebrochen werden.",
      "error",
    );
    row.cancelButton.disabled = false;
  }
}

function selectInstalledModel(
  context: LocalModelWindowContext,
  row: LocalModelRowElements,
) {
  notifyModelInstalled(context, row.model);
  setStatus(row.status, `${row.model} wurde ausgewählt.`, "success");
  row.button.textContent = "Ausgewählt";
  row.button.disabled = true;
  row.button.dataset.state = "installed";
}

async function deleteInstalledModel(
  context: LocalModelWindowContext,
  state: LocalModelWindowState,
  elements: LocalModelWindowElements,
  row: LocalModelRowElements,
) {
  if (!row.installed || state.activeOperationModel) return;

  const selected = getSelectedLocalModel() === row.model;
  const confirmed = context.window.confirm(
    selected
      ? `${row.model} ist aktuell ausgewählt. Modell wirklich von Ollama löschen?`
      : `${row.model} wirklich von Ollama löschen?`,
  );
  if (!confirmed) return;

  const provider = addon.api.ai.getProvider("ollama");
  if (typeof provider.deleteModel !== "function") {
    setStatus(
      row.status,
      "Ollama unterstützt kein Löschen von Modellen.",
      "error",
    );
    return;
  }

  const operationId = beginRowOperation(state, row);
  setRowDeleting(row);
  syncOperationLocks(context, state, elements.rows);

  try {
    await provider.deleteModel(row.model);
    if (!isRowOperationActive(context, state, row, operationId)) return;

    const installedModels = await waitForInstalledModels(context, 1);
    if (!isRowOperationActive(context, state, row, operationId)) return;

    const installedModelIds = new Set(
      installedModels.map((model) => model.id.trim()).filter(Boolean),
    );
    row.installed = false;
    syncInstalledRows(context, elements.rows, installedModelIds);
    notifyModelsChanged(context);

    if (selected) {
      setNotice(
        elements,
        `${row.model} wurde gelöscht. Installiere oder wähle ein anderes Modell.`,
        "warning",
        { showActions: false },
      );
    } else {
      setNotice(elements, `${row.model} wurde gelöscht.`, "success", {
        showActions: false,
      });
    }
  } catch (error) {
    if (!isRowOperationActive(context, state, row, operationId)) return;

    logLocalModelError(error);
    setStatus(row.status, getFriendlyErrorMessage(error), "error");
    resetDeleteRow(row);
  } finally {
    const operationStillActive = isRowOperationActive(
      context,
      state,
      row,
      operationId,
    );
    if (operationStillActive && state.activeOperationModel === row.model) {
      state.activeOperationModel = undefined;
    }
    if (operationStillActive) {
      syncUnlockedRows(context, elements.rows);
    }
  }
}

function syncInstalledRows(
  context: LocalModelWindowContext,
  rows: LocalModelRowElements[],
  installedModelIds: Set<string>,
) {
  for (const row of rows) {
    row.installed = installedModelIds.has(row.model);
    syncInstalledRow(context, row);
  }
}

function syncInstalledRow(
  _context: LocalModelWindowContext,
  row: LocalModelRowElements,
) {
  const selected = getSelectedLocalModel() === row.model;
  row.cancelButton.hidden = true;
  row.cancelButton.disabled = false;
  row.deleteButton.hidden = !row.installed;
  row.deleteButton.disabled = false;
  row.deleteButton.textContent = "Löschen";
  setProgress(row, null);

  if (row.installed) {
    row.button.disabled = selected;
    row.button.textContent = selected ? "Ausgewählt" : "Auswählen";
    row.button.dataset.state = "installed";
    setStatus(
      row.status,
      selected
        ? `${row.model} ist ausgewählt.`
        : `${row.model} ist installiert.`,
      "success",
    );
    return;
  }

  row.button.disabled = false;
  row.button.textContent = "Download";
  row.button.dataset.state = "idle";
  row.deleteButton.hidden = true;
  row.deleteButton.disabled = false;
  row.deleteButton.textContent = "Löschen";
  clearStatus(row.status);
}

function setRowsChecking(rows: LocalModelRowElements[]) {
  for (const row of rows) {
    row.button.disabled = true;
    row.button.textContent = "Prüfen...";
    row.button.dataset.state = "idle";
    row.cancelButton.hidden = true;
    row.deleteButton.hidden = true;
    row.deleteButton.disabled = true;
    setProgress(row, null);
    clearStatus(row.status);
  }
}

function setRowsUnavailable(rows: LocalModelRowElements[]) {
  for (const row of rows) {
    row.button.disabled = true;
    row.button.textContent = row.installed ? "Auswählen" : "Download";
    row.button.dataset.state = row.installed ? "installed" : "idle";
    row.cancelButton.hidden = true;
    row.deleteButton.hidden = !row.installed;
    row.deleteButton.disabled = true;
    setProgress(row, null);
    clearStatus(row.status);
  }
}

function syncOperationLocks(
  _context: LocalModelWindowContext,
  state: LocalModelWindowState,
  rows: LocalModelRowElements[],
) {
  const activeModel = state.activeOperationModel;
  if (!activeModel) return;

  for (const row of rows) {
    row.button.disabled = true;
    row.deleteButton.disabled = true;

    if (row.model === activeModel && state.controllers.has(row.model)) {
      row.button.disabled = true;
      row.cancelButton.hidden = false;
    } else if (row.model !== activeModel) {
      row.cancelButton.hidden = true;
    }
  }
}

function syncUnlockedRows(
  context: LocalModelWindowContext,
  rows: LocalModelRowElements[],
) {
  for (const row of rows) {
    syncRowActionState(context, row);
  }
}

function syncRowActionState(
  _context: LocalModelWindowContext,
  row: LocalModelRowElements,
) {
  const selected = getSelectedLocalModel() === row.model;
  row.cancelButton.hidden = true;
  row.cancelButton.disabled = false;

  if (row.installed) {
    row.button.disabled = selected;
    row.button.textContent = selected ? "Ausgewählt" : "Auswählen";
    row.button.dataset.state = "installed";
    row.deleteButton.hidden = false;
    row.deleteButton.disabled = false;
    row.deleteButton.textContent = "Löschen";
    return;
  }

  row.button.disabled = false;
  row.button.dataset.state = "idle";
  row.button.textContent =
    row.button.textContent &&
    !/^Lädt|Prüfen|Ausgewählt|Auswählen$/i.test(row.button.textContent)
      ? row.button.textContent
      : "Download";
  row.deleteButton.hidden = true;
  row.deleteButton.disabled = false;
  row.deleteButton.textContent = "Löschen";
}

function setRowDownloading(row: LocalModelRowElements) {
  row.button.disabled = true;
  row.button.dataset.state = "loading";
  row.button.textContent = "Lädt...";
  row.cancelButton.hidden = false;
  row.cancelButton.disabled = false;
  row.deleteButton.hidden = true;
  row.deleteButton.disabled = true;
  setProgress(row, null);
  setStatus(row.status, `${row.model} wird installiert...`, "warning");
}

function setRowDeleting(row: LocalModelRowElements) {
  row.button.disabled = true;
  row.cancelButton.hidden = true;
  row.deleteButton.hidden = false;
  row.deleteButton.disabled = true;
  row.deleteButton.textContent = "Löscht...";
  setProgress(row, null);
  setStatus(row.status, `${row.model} wird gelöscht...`, "warning");
}

function updateDownloadProgress(
  row: LocalModelRowElements,
  progress: LocalModelProgress,
) {
  if (progress.percent !== null) {
    row.button.textContent = `Lädt ${progress.percent}%`;
    setProgress(row, progress.percent);
  } else {
    row.button.textContent = "Lädt...";
  }

  setStatus(row.status, formatProgressStatus(progress), "warning");
}

function resetDownloadRow(
  context: LocalModelWindowContext,
  row: LocalModelRowElements,
  buttonText = "Download",
) {
  if (row.installed) {
    syncInstalledRow(context, row);
    return;
  }

  row.button.disabled = false;
  row.button.dataset.state = "idle";
  row.button.textContent = buttonText;
  row.cancelButton.hidden = true;
  row.cancelButton.disabled = false;
  row.deleteButton.hidden = !row.installed;
  row.deleteButton.disabled = false;
  row.deleteButton.textContent = "Löschen";
  setProgress(row, null);
}

function resetDeleteRow(row: LocalModelRowElements) {
  row.button.disabled = getSelectedLocalModel() === row.model;
  row.button.textContent =
    getSelectedLocalModel() === row.model ? "Ausgewählt" : "Auswählen";
  row.button.dataset.state = "installed";
  row.cancelButton.hidden = true;
  row.cancelButton.disabled = false;
  row.deleteButton.hidden = false;
  row.deleteButton.disabled = false;
  row.deleteButton.textContent = "Löschen";
  setProgress(row, null);
}

function beginRowOperation(
  state: LocalModelWindowState,
  row: LocalModelRowElements,
) {
  clearCancelTimerForModel(state, row.model);
  state.activeOperationModel = row.model;
  row.operationId += 1;
  return row.operationId;
}

function isRowOperationActive(
  context: LocalModelWindowContext,
  state: LocalModelWindowState,
  row: LocalModelRowElements,
  operationId: number,
) {
  return (
    isLocalModelWindowActive(context, state) && row.operationId === operationId
  );
}

function clearCancelTimer(
  context: LocalModelWindowContext,
  state: LocalModelWindowState,
  model: string,
) {
  const timer = state.cancelTimers.get(model);
  if (timer !== undefined) {
    context.window.clearTimeout(timer);
    state.cancelTimers.delete(model);
  }
}

function clearCancelTimerForModel(state: LocalModelWindowState, model: string) {
  const timer = state.cancelTimers.get(model);
  if (timer !== undefined) {
    state.window.clearTimeout(timer);
    state.cancelTimers.delete(model);
  }
}

function setProgress(row: LocalModelRowElements, percent: number | null) {
  if (percent === null) {
    row.progress.hidden = true;
    row.progress.removeAttribute("aria-valuenow");
    row.progressFill.style.width = "0%";
    return;
  }

  const value = Math.max(0, Math.min(100, Math.round(percent)));
  row.progress.hidden = false;
  row.progress.setAttribute("aria-valuenow", String(value));
  row.progressFill.style.width = `${value}%`;
}

export function formatProgressStatus(progress: LocalModelProgress) {
  if (progress.done) return "Download abgeschlossen.";

  if (progress.percent !== null) {
    const size =
      progress.completed !== null && progress.total !== null
        ? ` (${formatBytes(progress.completed)} / ${formatBytes(progress.total)})`
        : "";
    return `Download läuft: ${progress.percent}%${size}`;
  }

  const status = progress.status.toLowerCase();
  if (status.includes("manifest")) return "Manifest wird geladen...";
  if (status.includes("verifying")) return "Download wird geprüft...";
  if (status.includes("writing")) return "Modell wird gespeichert...";
  if (status.includes("pulling")) return "Modelldaten werden geladen...";
  return "Download läuft...";
}

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const decimals = unitIndex <= 1 || size >= 10 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function setNotice(
  elements: LocalModelWindowElements,
  text: string,
  state: LocalModelNoticeState,
  options: { hidden?: boolean; showActions?: boolean } = {},
) {
  elements.notice.hidden = options.hidden === true;
  elements.notice.dataset.state = state;
  elements.noticeText.textContent = text;
  elements.noticeActions.hidden = options.showActions !== true;
  elements.setupButton.hidden =
    typeof addon.api.launchOllamaSetup !== "function";
  elements.refreshButton.hidden = false;
  elements.setupButton.disabled = false;
  elements.refreshButton.disabled = false;
}

export function getFriendlyErrorMessage(error: unknown) {
  if (isAbortError(error)) return "Download abgebrochen.";

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const details =
    error && typeof error === "object" && "details" in error
      ? (error as { details?: unknown }).details
      : undefined;
  const issue =
    details && typeof details === "object" && "issue" in details
      ? String((details as { issue?: unknown }).issue)
      : "";

  if (issue === "timeout" || name === "HttpTimeoutError") {
    return "Der Download wurde wegen fehlendem Fortschritt unterbrochen.";
  }
  if (issue === "network" || name === "HttpNetworkError") {
    return "Der Download wurde unterbrochen. Prüfe Ollama und die Verbindung.";
  }
  if (/model|not found|invalid|pull/i.test(message)) {
    return "Ollama hat das Modell abgelehnt oder nicht gefunden.";
  }
  if (/setup-unavailable/i.test(message)) {
    return "Das Ollama-Setup ist in dieser Umgebung nicht verfügbar.";
  }
  if (
    /network|fetch|failed|refused|unreachable|offline/i.test(message) ||
    name === "AIProviderResponseError"
  ) {
    return "Ollama konnte nicht automatisch erreicht werden. Prüfe die Installation und versuche es erneut.";
  }

  return "Die Aktion konnte nicht abgeschlossen werden.";
}

export function isAbortError(error: unknown) {
  return (
    error !== null &&
    error !== undefined &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function logLocalModelError(error: unknown) {
  if (isAbortError(error)) return;

  const logError = Zotero?.logError;
  if (typeof logError === "function") {
    logError(error instanceof Error ? error : new Error(String(error)));
  }
}

function getSelectedLocalModel() {
  return typeof addon.data.settings.ollamaModel === "string"
    ? addon.data.settings.ollamaModel.trim()
    : "";
}

function clearStatus(element: HTMLElement) {
  element.textContent = "";
  element.dataset.state = "";
  element.hidden = true;
}

function wait(win: Window, ms: number) {
  return new Promise<void>((resolve) => {
    win.setTimeout(resolve, ms);
  });
}

function abortActiveDownloads(state: LocalModelWindowState) {
  for (const timer of state.cancelTimers.values()) {
    state.window.clearTimeout(timer);
  }
  state.cancelTimers.clear();

  for (const controller of state.controllers.values()) {
    controller.abort();
  }
  state.controllers.clear();
  state.activeOperationModel = undefined;
}

function isLocalModelWindowActive(
  context: LocalModelWindowContext,
  state: LocalModelWindowState,
) {
  return !state.disposed && !context.window.closed;
}

function notifyModelInstalled(context: LocalModelWindowContext, model: string) {
  context.owner.dispatchEvent(
    new context.owner.CustomEvent(LOCAL_OLLAMA_MODEL_INSTALLED_EVENT, {
      detail: { model },
    }),
  );
}

function notifyModelsChanged(context: LocalModelWindowContext) {
  context.owner.dispatchEvent(
    new context.owner.CustomEvent(LOCAL_OLLAMA_MODELS_CHANGED_EVENT),
  );
}

function setStatus(
  element: HTMLElement,
  text: string,
  state: "success" | "warning" | "error" | "" = "",
) {
  element.textContent = text;
  element.dataset.state = state;
  element.hidden = false;
}

function syncLocalModelWindowAppearance(
  modelWindow: Window,
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

  const targetRoot = modelWindow.document.documentElement;
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
  if (modelWindow.document.body) {
    modelWindow.document.body.style.background = "inherit";
    modelWindow.document.body.style.color = "inherit";
    modelWindow.document.body.style.font = "inherit";
  }
  root.style.background = "inherit";
  root.style.color = "inherit";
}

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

function setStyleProperty(
  targetStyle: CSSStyleDeclaration,
  property: string,
  value: string,
) {
  if (value.trim()) {
    targetStyle.setProperty(property, value.trim());
  }
}

function installFixedSizeGuard(win: Window) {
  let pendingFrame: number | undefined;

  const enforceFixedSize = () => {
    if (pendingFrame !== undefined) {
      return;
    }

    pendingFrame = win.requestAnimationFrame(() => {
      pendingFrame = undefined;
      const width = LOCAL_MODEL_WINDOW_DEFAULT_WIDTH;
      const height = LOCAL_MODEL_WINDOW_DEFAULT_HEIGHT;
      if (width !== win.outerWidth || height !== win.outerHeight) {
        win.resizeTo(width, height);
      }
    });
  };

  win.addEventListener("resize", enforceFixedSize);
  enforceFixedSize();

  return () => {
    if (pendingFrame !== undefined) {
      win.cancelAnimationFrame(pendingFrame);
    }
    win.removeEventListener("resize", enforceFixedSize);
  };
}

function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tagName: K,
  className?: string,
  text?: string,
) {
  const element = doc.createElementNS(HTML_NS, tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function createHtmlButton(doc: Document, className: string, text: string) {
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.className = className;
  button.textContent = text;
  button.type = "button";
  return button;
}
