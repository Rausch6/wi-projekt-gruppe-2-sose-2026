import { backgroundIndexer } from "../core/BackgroundIndexer";
import { indexingEvents } from "../core/IndexingEventBus";
import { vectorStore } from "../core/OramaService";
import type {
  IndexManagerElements,
  IndexManagerState,
  VectorStore,
  BackgroundIndexerService,
} from "./indexManager/types";
import { clearSelections } from "./indexManager/state";
import {
  renderIndexManager,
  setStatus,
  showIndexingActive,
  updateFilterOptions,
  formatDuration,
  ALL_FILTER_VALUE,
} from "./indexManager/render";
import {
  reloadPapers,
  indexSelectedPapers,
  unindexSelectedPapers,
  rebuildIndex,
  clearIndex,
  maybeShowInitialIndexPrompt,
  logError,
} from "./indexManager/actions";

/**
 * Event-bus cleanup callback associated with each open index manager window.
 */
const indexingEventCleanups = new WeakMap<Window, () => void>();

/**
 * Initializes index-manager state, DOM bindings, and indexing subscriptions.
 *
 * @param window - Index manager dialog window.
 * @param _owner - Owning Zotero window supplied by the XHTML bootstrap hook.
 * @returns Promise resolved after papers and filter data have been loaded.
 */
export async function initializeIndexManagerWindow(
  window: Window,
  _owner: any,
): Promise<void> {
  const document = window.document;
  const elements = getRequiredElements(document);
  if (!elements) {
    logError("[ZAIA] Index Manager window is missing required UI elements");
    return;
  }

  await document.l10n?.ready;

  const state: IndexManagerState = {
    papers: [],
    libraries: [],
    selectedLibraryIDs: new Set<number>(),
    libraryFilterInitialized: false,
    availableTypes: [],
    availableYears: [],
    selectedItemTypes: new Set<string>(),
    selectedYears: new Set<string>(),
    typeFilterInitialized: false,
    yearFilterInitialized: false,
    queuedItemIDs: new Set<number>(),
    selectedIndexed: new Set<number>(),
    selectedUnindexed: new Set<number>(),
    search: "",
    busy: false,
    fullIndexRunning: backgroundIndexer.isFullIndexRunning(),
  };

  indexingEventCleanups.get(window)?.();
  indexingEventCleanups.set(
    window,
    bindIndexingEvents(window, elements, state, vectorStore, backgroundIndexer),
  );

  bindEvents(window, elements, state, vectorStore, backgroundIndexer);
  await reloadPapers(window, elements, state, vectorStore, backgroundIndexer);
  void maybeShowInitialIndexPrompt(window, elements, state, backgroundIndexer);
}

/**
 * Releases index event subscriptions when the dialog is unloaded.
 *
 * @param window - Index manager dialog being closed.
 * @param _owner - Optional owning Zotero window.
 * @returns Nothing.
 */
export function handleIndexManagerWindowUnload(
  window: Window,
  _owner?: Window,
): void {
  indexingEventCleanups.get(window)?.();
  indexingEventCleanups.delete(window);
}

/**
 * Resolves and validates all DOM elements required by the index manager.
 *
 * @param document - Index manager document to query.
 * @returns Typed element collection, or null when the XHTML is incomplete.
 */
function getRequiredElements(document: Document): IndexManagerElements | null {
  const elements = {
    searchInput: document.getElementById(
      "index-search-input",
    ) as HTMLInputElement | null,
    libraryFilter: document.getElementById(
      "index-library-filter",
    ) as HTMLSelectElement | null,
    typeFilter: document.getElementById(
      "index-type-filter",
    ) as HTMLSelectElement | null,
    yearFilter: document.getElementById(
      "index-year-filter",
    ) as HTMLSelectElement | null,
    status: document.getElementById("index-action-status"),
    indexingBanner: document.getElementById("indexing-banner"),
    indexingBannerActive: document.getElementById("indexing-banner-active"),
    indexingBannerActiveText: document.getElementById(
      "indexing-banner-active-text",
    ),
    refreshButton: document.getElementById(
      "btn-refresh",
    ) as HTMLButtonElement | null,
    rebuildButton: document.getElementById(
      "btn-rebuild-index",
    ) as HTMLButtonElement | null,
    cancelIndexingButton: document.getElementById(
      "btn-cancel-indexing",
    ) as HTMLButtonElement | null,
    clearIndexButton: document.getElementById(
      "btn-clear-index",
    ) as HTMLButtonElement | null,
    indexSelectedButton: document.getElementById(
      "btn-index-selected",
    ) as HTMLButtonElement | null,
    unindexSelectedButton: document.getElementById(
      "btn-unindex-selected",
    ) as HTMLButtonElement | null,
    unindexedList: document.getElementById("unindexed-list"),
    indexedList: document.getElementById("indexed-list"),
    unindexedEmpty: document.getElementById("unindexed-empty"),
    indexedEmpty: document.getElementById("indexed-empty"),
    unindexedCount: document.getElementById("unindexed-count"),
    indexedCount: document.getElementById("indexed-count"),
  };

  if (Object.values(elements).some((element) => !element)) {
    return null;
  }

  return elements as IndexManagerElements;
}

/**
 * Connects filters and command buttons to state transitions and index actions.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Mutable index manager state.
 * @param vectorStoreService - Vector-store service used for delete operations.
 * @param backgroundIndexerService - Background indexing service.
 * @returns Nothing.
 */
function bindEvents(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  vectorStoreService: VectorStore,
  backgroundIndexerService: BackgroundIndexerService,
): void {
  elements.searchInput.addEventListener("input", () => {
    state.search = elements.searchInput.value.trim().toLowerCase();
    clearSelections(state);
    renderIndexManager(window, elements, state);
  });

  elements.libraryFilter.addEventListener("change", () => {
    const value = elements.libraryFilter.value;
    state.selectedLibraryIDs =
      value === ALL_FILTER_VALUE
        ? new Set(state.libraries.map((library) => library.libraryID))
        : new Set([Number.parseInt(value, 10)].filter(Number.isFinite));
    clearSelections(state);
    updateFilterOptions(window, elements, state);
    renderIndexManager(window, elements, state);
  });

  elements.typeFilter.addEventListener("change", () => {
    const value = elements.typeFilter.value;
    state.selectedItemTypes =
      value === ALL_FILTER_VALUE
        ? new Set(state.availableTypes)
        : new Set([value]);
    clearSelections(state);
    renderIndexManager(window, elements, state);
  });

  elements.yearFilter.addEventListener("change", () => {
    const value = elements.yearFilter.value;
    state.selectedYears =
      value === ALL_FILTER_VALUE
        ? new Set(state.availableYears)
        : new Set([value]);
    clearSelections(state);
    renderIndexManager(window, elements, state);
  });

  /**
   * Prevents duplicate button activation until the asynchronous action updates
   * the complete manager state.
   */
  function bindAsyncButton(
    button: HTMLButtonElement | null,
    handler: () => Promise<void> | void,
  ) {
    if (!button) return;
    button.addEventListener("click", () => {
      if (button.disabled) return;
      button.disabled = true;
      void handler();
    });
  }

  bindAsyncButton(elements.refreshButton, () =>
    reloadPapers(
      window,
      elements,
      state,
      vectorStoreService,
      backgroundIndexerService,
    ),
  );
  bindAsyncButton(elements.rebuildButton, () =>
    rebuildIndex(window, elements, state, backgroundIndexerService),
  );
  bindAsyncButton(elements.cancelIndexingButton, () => {
    backgroundIndexerService.abort();
    setStatus(elements.status, "Abbruch angefordert ...", "warning");
  });
  bindAsyncButton(elements.clearIndexButton, () =>
    clearIndex(window, elements, state, vectorStoreService),
  );
  bindAsyncButton(elements.indexSelectedButton, () =>
    indexSelectedPapers(window, elements, state, backgroundIndexerService),
  );
  bindAsyncButton(elements.unindexSelectedButton, () =>
    unindexSelectedPapers(window, elements, state, vectorStoreService),
  );
}

/**
 * Formats the optional count of papers skipped during text extraction.
 *
 * @param skippedCount - Number of skipped papers reported by the indexer.
 * @returns Empty text or a sentence suffix describing skipped papers.
 */
function formatSkippedSuffix(skippedCount?: number): string {
  if (!skippedCount) return "";
  return ` ${skippedCount} Paper ohne extrahierbaren Text übersprungen.`;
}

/**
 * Mirrors background-indexer lifecycle events into the dialog state and banner.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Mutable index manager state.
 * @param vectorStoreService - Vector-store service used while reloading papers.
 * @param backgroundIndexerService - Background indexing service.
 * @returns Cleanup callback that unsubscribes every indexing event listener.
 */
function bindIndexingEvents(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  vectorStoreService: VectorStore,
  backgroundIndexerService: BackgroundIndexerService,
): () => void {
  /**
   * Reloads both paper columns before showing a terminal operation message.
   */
  const reloadAndShowStatus = (
    message: string,
    type: "" | "success" | "warning" | "error",
  ) => {
    void reloadPapers(
      window,
      elements,
      state,
      vectorStoreService,
      backgroundIndexerService,
    ).then(() => setStatus(elements.status, message, type));
  };

  const unsubStarted = indexingEvents.on("started", ({ mode }) => {
    if (mode === "full") {
      state.fullIndexRunning = true;
      renderIndexManager(window, elements, state);
    }
    showIndexingActive(
      elements,
      mode === "full"
        ? "Bibliotheks-Indexierung läuft ..."
        : "Indexierung läuft ...",
    );
  });

  const unsubProgress = indexingEvents.on(
    "progress",
    ({ indexed, total, estimatedRemainingMs, paperTitle }) => {
      let message = paperTitle
        ? `"${paperTitle}" wird indexiert - ${indexed} / ${total} Paper im Index`
        : `Indexierung läuft - ${indexed} / ${total} Paper im Index`;
      if (estimatedRemainingMs !== undefined && estimatedRemainingMs > 0) {
        message += `, noch ca. ${formatDuration(estimatedRemainingMs)}`;
      }
      showIndexingActive(elements, message);
    },
  );

  const unsubSingleStarted = indexingEvents.on(
    "singleStarted",
    ({ itemID, paperTitle }) => {
      if (itemID !== undefined) {
        state.queuedItemIDs.add(itemID);
      }
      renderIndexManager(window, elements, state);
      showIndexingActive(
        elements,
        paperTitle
          ? `"${paperTitle}" wird indexiert ...`
          : "Paper wird indexiert ...",
      );
    },
  );

  const unsubSingleDone = indexingEvents.on(
    "singleDone",
    ({ itemID, paperTitle, skipped, unchanged }) => {
      if (itemID !== undefined) {
        state.queuedItemIDs.delete(itemID);
      }

      const label = paperTitle ? `"${paperTitle}"` : "Paper";
      if (unchanged) {
        reloadAndShowStatus(
          `${label} war bereits aktuell indexiert.`,
          "success",
        );
        return;
      }
      if (skipped) {
        reloadAndShowStatus(
          `${label} konnte nicht indexiert werden.`,
          "warning",
        );
        return;
      }
      reloadAndShowStatus(`${label} wurde indexiert.`, "success");
    },
  );

  const unsubDeleted = indexingEvents.on("deleted", ({ paperTitle }) => {
    reloadAndShowStatus(
      paperTitle
        ? `"${paperTitle}" wurde aus dem Index entfernt.`
        : "Paper wurde aus dem Index entfernt.",
      "success",
    );
  });

  const unsubError = indexingEvents.on(
    "error",
    ({ itemID, message, paperTitle }) => {
      if (itemID !== undefined) {
        state.queuedItemIDs.delete(itemID);
      }
      renderIndexManager(window, elements, state);
      const title = paperTitle ? `"${paperTitle}"` : "Paper";
      setStatus(elements.status, `Fehler bei ${title}: ${message}`, "error");
    },
  );

  const unsubFinished = indexingEvents.on(
    "finished",
    ({ indexed, total, skippedCount }) => {
      state.queuedItemIDs.clear();
      state.fullIndexRunning = false;
      reloadAndShowStatus(
        `Indexierung abgeschlossen - ${indexed ?? 0} / ${total ?? "?"} Paper im Index.` +
          formatSkippedSuffix(skippedCount),
        "success",
      );
    },
  );

  const unsubAborted = indexingEvents.on(
    "aborted",
    ({ indexed, total, skippedCount }) => {
      state.queuedItemIDs.clear();
      state.fullIndexRunning = false;
      reloadAndShowStatus(
        `Indexierung durch Nutzer abgebrochen - ${indexed ?? 0} / ${total ?? "?"} Paper im Index.` +
          formatSkippedSuffix(skippedCount),
        "warning",
      );
    },
  );

  const initialState = backgroundIndexerService.indexingState;
  if (initialState.status === "running") {
    let message = `Indexierung läuft - ${initialState.indexed} / ${initialState.total} Paper im Index`;
    if (
      initialState.estimatedRemainingMs !== undefined &&
      initialState.estimatedRemainingMs > 0
    ) {
      message += `, noch ca. ${formatDuration(initialState.estimatedRemainingMs)}`;
    }
    showIndexingActive(elements, message);
  } else if (initialState.status === "done" && initialState.newlyIndexed > 0) {
    setStatus(
      elements.status,
      `Indexierung abgeschlossen - ${initialState.indexed} / ${initialState.total} Paper im Index.`,
      "success",
    );
  } else if (initialState.status === "aborted") {
    setStatus(
      elements.status,
      `Indexierung durch Nutzer abgebrochen - ${initialState.indexed} / ${initialState.total} Paper im Index.`,
      "warning",
    );
  }

  return () => {
    unsubStarted();
    unsubProgress();
    unsubSingleStarted();
    unsubSingleDone();
    unsubDeleted();
    unsubError();
    unsubFinished();
    unsubAborted();
  };
}
