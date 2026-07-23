import { config } from "../../../package.json";
import { LibraryScopeManager } from "../../core/LibraryScopeManager";
import type {
  IndexManagerElements,
  IndexManagerState,
  BackgroundIndexerService,
  VectorStore,
  LibraryFilterOption,
  PaperRecord,
} from "./types";
import {
  syncSelectedLibraries,
  trimQueuedItems,
  trimSelections,
  getSelectedPapers,
  getSelectedLibraryIDs,
  normalizeSearchText,
} from "./state";
import {
  setBusy,
  setStatus,
  renderLibraryFilter,
  updateFilterOptions,
  renderIndexManager,
} from "./render";
import {
  isIndexableItem,
  getItemTitle,
  getItemCreators,
  getItemField,
  getItemType,
  loadItemCompletely,
} from "./zoteroUtils";

declare const Zotero: any;

/**
 * Reloads Zotero papers, index membership, filters, and selections.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Mutable index manager state.
 * @param vectorStoreService - Vector store used to resolve indexed item IDs.
 * @param backgroundIndexerService - Background indexer used for running state.
 * @returns Promise resolved after the manager has been refreshed.
 */
export async function reloadPapers(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  vectorStoreService: VectorStore,
  backgroundIndexerService: BackgroundIndexerService,
): Promise<void> {
  setBusy(window, elements, state, true);
  setStatus(elements.status, "Paper werden geladen ...", "");

  try {
    const result = await collectPapers(vectorStoreService);
    state.libraries = result.libraries;
    state.papers = result.papers;
    state.fullIndexRunning = backgroundIndexerService.isFullIndexRunning();
    syncSelectedLibraries(state);
    trimQueuedItems(state);
    trimSelections(state);
    renderLibraryFilter(window, elements, state);
    updateFilterOptions(window, elements, state);
    renderIndexManager(window, elements, state);

    if (backgroundIndexerService.indexingState.status === "running") {
      setStatus(
        elements.status,
        "Indexierung läuft im Hintergrund. Aktualisiere die Liste bei Bedarf erneut.",
        "warning",
      );
    } else {
      setStatus(
        elements.status,
        `${state.papers.length} Paper geladen.`,
        "success",
      );
    }
  } catch (error) {
    logError(error);
    setStatus(elements.status, "Paper konnten nicht geladen werden.", "error");
  } finally {
    setBusy(window, elements, state, false);
  }
}

/**
 * Collects indexable papers from every accessible Zotero library.
 *
 * @param vectorStoreService - Vector store used to mark indexed papers.
 * @returns Available library scopes and sorted paper records.
 */
export async function collectPapers(
  vectorStoreService: VectorStore,
): Promise<{ libraries: LibraryFilterOption[]; papers: PaperRecord[] }> {
  const indexedItemIds = vectorStoreService.getIndexedItemIds();
  const libraries = LibraryScopeManager.listLibraryScopes().map((scope) => ({
    libraryID: scope.libraryID,
    name: scope.name,
    type: scope.type,
  }));
  const papers: PaperRecord[] = [];

  for (const library of libraries) {
    let items: any[] = [];
    try {
      items = await Zotero.Items.getAll(library.libraryID, false, false, false);
    } catch (error) {
      logError(error);
      continue;
    }

    const loadedItems = await Promise.all(items.map(loadItemCompletely));

    papers.push(
      ...loadedItems.filter(isIndexableItem).map((item: any) => {
        const title = getItemTitle(item);
        const author = getItemCreators(item);
        const year = getItemField(item, "year", "-");
        const itemType = getItemType(item);
        const indexed = indexedItemIds.has(String(item.id));

        return {
          itemID: item.id,
          libraryID: library.libraryID,
          libraryName: library.name,
          title,
          author,
          year,
          itemType,
          indexed,
          searchText: normalizeSearchText([
            title,
            author,
            year,
            itemType,
            library.name,
          ]),
        };
      }),
    );
  }

  return {
    libraries,
    papers: papers.sort(
      (left: PaperRecord, right: PaperRecord) =>
        left.libraryName.localeCompare(right.libraryName, undefined, {
          sensitivity: "base",
        }) ||
        left.title.localeCompare(right.title, undefined, {
          sensitivity: "base",
        }),
    ),
  };
}

/**
 * Enqueues selected unindexed papers for background indexing.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Mutable index manager state.
 * @param backgroundIndexerService - Background indexer receiving item IDs.
 * @returns Promise resolved after selected papers have been queued.
 */
export async function indexSelectedPapers(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  backgroundIndexerService: BackgroundIndexerService,
): Promise<void> {
  const selectedPapers = getSelectedPapers(state, "unindexed");
  if (selectedPapers.length === 0) {
    setStatus(
      elements.status,
      "Wähle links mindestens ein Paper aus.",
      "warning",
    );
    return;
  }

  setBusy(window, elements, state, true);
  try {
    backgroundIndexerService.enqueue(
      selectedPapers.map((paper) => paper.itemID),
    );
    const selectedIDs = new Set(selectedPapers.map((paper) => paper.itemID));
    for (const itemID of selectedIDs) {
      state.queuedItemIDs.add(itemID);
    }
    state.selectedUnindexed.clear();
    trimSelections(state);
    renderIndexManager(window, elements, state);
    setStatus(
      elements.status,
      `Indexierung für ${selectedPapers.length} Paper gestartet. Sie erscheinen erst nach Abschluss rechts als indexiert.`,
      "success",
    );
  } catch (error) {
    logError(error);
    setStatus(
      elements.status,
      error instanceof Error
        ? error.message
        : "Ausgewählte Paper konnten nicht zur Indexierung übergeben werden.",
      "error",
    );
  } finally {
    setBusy(window, elements, state, false);
  }
}

/**
 * Removes selected indexed papers from the vector store after confirmation.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Mutable index manager state.
 * @param vectorStoreService - Vector store from which papers are removed.
 * @returns Promise resolved after selected papers have been removed.
 */
export async function unindexSelectedPapers(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  vectorStoreService: VectorStore,
): Promise<void> {
  const selectedPapers = getSelectedPapers(state, "indexed");
  if (selectedPapers.length === 0) {
    setStatus(
      elements.status,
      "Wähle rechts mindestens ein Paper aus.",
      "warning",
    );
    return;
  }

  const confirmed = window.confirm(
    `${selectedPapers.length} ausgewählte Paper aus dem ZAIA-Index entfernen? Die Zotero-Einträge bleiben erhalten.`,
  );
  if (!confirmed) {
    return;
  }

  setBusy(window, elements, state, true);
  try {
    await Promise.all(
      selectedPapers.map((paper) =>
        vectorStoreService.deleteByZoteroItemId(String(paper.itemID)),
      ),
    );
    const selectedIDs = new Set(selectedPapers.map((paper) => paper.itemID));
    state.papers = state.papers.map((paper) =>
      selectedIDs.has(paper.itemID) ? { ...paper, indexed: false } : paper,
    );
    for (const itemID of selectedIDs) {
      state.queuedItemIDs.delete(itemID);
    }
    state.selectedIndexed.clear();
    trimSelections(state);
    renderIndexManager(window, elements, state);
    setStatus(
      elements.status,
      `${selectedPapers.length} Paper aus dem Index entfernt.`,
      "success",
    );
  } catch (error) {
    logError(error);
    setStatus(
      elements.status,
      "Ausgewählte Paper konnten nicht aus dem Index entfernt werden.",
      "error",
    );
  } finally {
    setBusy(window, elements, state, false);
  }
}

/**
 * Rebuilds the vector index for all currently selected Zotero libraries.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Mutable index manager state.
 * @param backgroundIndexerService - Background indexer performing the rebuild.
 * @returns Promise resolved once the rebuild has been started.
 */
export async function rebuildIndex(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  backgroundIndexerService: BackgroundIndexerService,
): Promise<void> {
  if (backgroundIndexerService.isFullIndexRunning()) {
    setStatus(
      elements.status,
      "Es läuft bereits eine Indexierung. Bitte warten oder abbrechen.",
      "warning",
    );
    return;
  }

  const libraryIDs = getSelectedLibraryIDs(state);
  if (libraryIDs.length === 0) {
    setStatus(
      elements.status,
      "Wähle mindestens eine Bibliothek für den Neuaufbau aus.",
      "warning",
    );
    return;
  }

  const confirmed = window.confirm(
    "Den ZAIA-Index für die ausgewählten Bibliotheken komplett neu aufbauen? Das kann einige Minuten dauern.",
  );
  if (!confirmed) {
    return;
  }

  setBusy(window, elements, state, true);
  setStatus(elements.status, "Index wird neu aufgebaut ...", "");

  try {
    void backgroundIndexerService
      .indexAllLibraryItems({ libraryIDs, rebuild: true })
      .catch((error: unknown) => {
        logError(error);
        setStatus(
          elements.status,
          error instanceof Error
            ? error.message
            : "Neu-Indexierung konnte nicht abgeschlossen werden.",
          "error",
        );
      })
      .finally(() => {
        state.fullIndexRunning = backgroundIndexerService.isFullIndexRunning();
        renderIndexManager(window, elements, state);
      });
    const selectedLibraryIDs = new Set(libraryIDs);
    state.papers = state.papers.map((paper) =>
      selectedLibraryIDs.has(paper.libraryID)
        ? { ...paper, indexed: false }
        : paper,
    );
    state.queuedItemIDs.clear();
    state.selectedIndexed.clear();
    state.selectedUnindexed.clear();
    renderIndexManager(window, elements, state);
    setStatus(
      elements.status,
      "Index wird im Hintergrund neu aufgebaut.",
      "success",
    );
  } catch (error) {
    logError(error);
    setStatus(
      elements.status,
      "Index konnte nicht neu aufgebaut werden.",
      "error",
    );
  } finally {
    setBusy(window, elements, state, false);
  }
}

/**
 * Clears the complete vector index without deleting Zotero items.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Mutable index manager state.
 * @param vectorStoreService - Vector store to clear.
 * @returns Promise resolved after the vector index has been cleared.
 */
export async function clearIndex(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  vectorStoreService: VectorStore,
): Promise<void> {
  const confirmed = window.confirm(
    "Den gesamten ZAIA-Index leeren? Die Zotero-Einträge bleiben erhalten.",
  );
  if (!confirmed) {
    return;
  }

  setBusy(window, elements, state, true);
  setStatus(elements.status, "Index wird geleert ...", "");

  try {
    await vectorStoreService.clearIndex();
    state.papers = state.papers.map((paper) => ({ ...paper, indexed: false }));
    state.queuedItemIDs.clear();
    state.selectedIndexed.clear();
    state.selectedUnindexed.clear();
    renderIndexManager(window, elements, state);
    setStatus(elements.status, "Index geleert.", "success");
  } catch (error) {
    logError(error);
    setStatus(elements.status, "Index konnte nicht geleert werden.", "error");
  } finally {
    setBusy(window, elements, state, false);
  }
}

/**
 * Offers a one-time full-library indexing prompt to first-time users.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Mutable index manager state.
 * @param backgroundIndexerService - Background indexer used when confirmed.
 * @returns Promise resolved after the prompt decision has been handled.
 */
export async function maybeShowInitialIndexPrompt(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  backgroundIndexerService: BackgroundIndexerService,
): Promise<void> {
  if (!shouldShowInitialIndexPrompt() || state.libraries.length === 0) return;

  const result = await showInitialIndexPrompt(window, state.libraries);
  markInitialIndexPromptShown();

  if (!result.confirmed) return;
  if (result.libraryIDs.length === 0) {
    setStatus(
      elements.status,
      "Keine Bibliothek ausgewählt. Es wurde nichts indexiert.",
      "warning",
    );
    return;
  }

  setStatus(elements.status, "Indexierung wird gestartet ...", "warning");
  void backgroundIndexerService
    .indexAllLibraryItems({ libraryIDs: result.libraryIDs })
    .catch((error: unknown) => {
      logError(error);
      setStatus(
        elements.status,
        error instanceof Error
          ? error.message
          : "Indexierung konnte nicht gestartet werden.",
        "error",
      );
    })
    .finally(() => {
      state.fullIndexRunning = backgroundIndexerService.isFullIndexRunning();
      renderIndexManager(window, elements, state);
    });
}

/**
 * Reads whether the one-time initial indexing prompt is still pending.
 *
 * @returns True when the prompt should be displayed.
 */
export function shouldShowInitialIndexPrompt(): boolean {
  try {
    return (
      Zotero.Prefs.get(
        `${config.prefsPrefix}.initialIndexPromptShown`,
        true,
      ) !== true
    );
  } catch {
    return true;
  }
}

/**
 * Persists that the initial indexing prompt has already been displayed.
 *
 * @returns Nothing.
 */
export function markInitialIndexPromptShown(): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.initialIndexPromptShown`, true, true);
}

/**
 * Renders an accessible library-selection dialog for initial indexing.
 *
 * @param window - Index manager dialog window hosting the overlay.
 * @param libraries - Zotero libraries offered for selection.
 * @returns Prompt result containing confirmation and selected library IDs.
 */
export function showInitialIndexPrompt(
  window: Window,
  libraries: LibraryFilterOption[],
): Promise<{ confirmed: boolean; libraryIDs: number[] }> {
  const doc = window.document;
  const overlay = doc.createElement("div");
  overlay.className = "initial-index-prompt-backdrop";
  overlay.setAttribute("role", "presentation");

  const dialog = doc.createElement("section");
  dialog.className = "initial-index-prompt";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "initial-index-prompt-title");

  const title = doc.createElement("h2");
  title.id = "initial-index-prompt-title";
  title.textContent = "Indexierung der gesamten Library starten?";

  const list = doc.createElement("div");
  list.className = "initial-index-library-list";

  for (const library of libraries) {
    const label = doc.createElement("label");
    label.className = "initial-index-library-option";

    const checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(library.libraryID);
    checkbox.checked = true;

    const text = doc.createElement("span");
    text.textContent = library.name;

    label.append(checkbox, text);
    list.append(label);
  }

  const actions = doc.createElement("div");
  actions.className = "initial-index-actions";

  const startButton = doc.createElement("button");
  startButton.type = "button";
  startButton.textContent = "Indexierung starten";

  const skipButton = doc.createElement("button");
  skipButton.type = "button";
  skipButton.textContent = "Nicht jetzt";

  actions.append(skipButton, startButton);
  dialog.append(title, list, actions);
  overlay.append(dialog);
  doc.body.append(overlay);

  return new Promise((resolve) => {
    const cleanup = (confirmed: boolean) => {
      const inputs = Array.from(
        list.querySelectorAll("input[type='checkbox']"),
      ) as HTMLInputElement[];
      const libraryIDs = inputs
        .filter((input) => input.checked)
        .map((input) => Number.parseInt(input.value, 10))
        .filter(Number.isFinite);

      window.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve({ confirmed, libraryIDs });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cleanup(false);
    };

    startButton.addEventListener("click", () => cleanup(true), { once: true });
    skipButton.addEventListener("click", () => cleanup(false), { once: true });
    window.addEventListener("keydown", onKeyDown);
    startButton.focus();
  });
}

/**
 * Forwards an unknown UI error to Zotero's error log.
 *
 * @param error - Error-like value to record.
 * @returns Nothing.
 */
export function logError(error: unknown): void {
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
}
