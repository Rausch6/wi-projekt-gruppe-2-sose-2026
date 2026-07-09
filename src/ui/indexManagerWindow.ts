import { backgroundIndexer } from "../core/BackgroundIndexer";
import { indexingEvents } from "../core/IndexingEventBus";
import {
  LibraryScopeManager,
  type LibraryScope,
} from "../core/LibraryScopeManager";
import { vectorStore } from "../core/OramaService";
import { config } from "../../package.json";

type VectorStore = typeof vectorStore;
type BackgroundIndexerService = typeof backgroundIndexer;

const STATUS_AUTO_HIDE_DELAY_MS = 5000;
const ALL_FILTER_VALUE = "__all__";

type IndexSide = "indexed" | "unindexed";

export type PaperRecord = {
  itemID: number;
  libraryID: number;
  libraryName: string;
  title: string;
  author: string;
  year: string;
  itemType: string;
  indexed: boolean;
  searchText: string;
};

type LibraryFilterOption = Pick<LibraryScope, "libraryID" | "name" | "type">;

type IndexManagerElements = {
  searchInput: HTMLInputElement;
  libraryFilter: HTMLSelectElement;
  typeFilter: HTMLSelectElement;
  yearFilter: HTMLSelectElement;
  status: HTMLElement;
  indexingBanner: HTMLElement;
  indexingBannerActive: HTMLElement;
  indexingBannerActiveText: HTMLElement;
  refreshButton: HTMLButtonElement;
  rebuildButton: HTMLButtonElement;
  cancelIndexingButton: HTMLButtonElement;
  clearIndexButton: HTMLButtonElement;
  indexSelectedButton: HTMLButtonElement;
  unindexSelectedButton: HTMLButtonElement;
  unindexedList: HTMLElement;
  indexedList: HTMLElement;
  unindexedEmpty: HTMLElement;
  indexedEmpty: HTMLElement;
  unindexedCount: HTMLElement;
  indexedCount: HTMLElement;
};

type IndexManagerState = {
  papers: PaperRecord[];
  libraries: LibraryFilterOption[];
  selectedLibraryIDs: Set<number>;
  libraryFilterInitialized: boolean;
  availableTypes: string[];
  availableYears: string[];
  selectedItemTypes: Set<string>;
  selectedYears: Set<string>;
  typeFilterInitialized: boolean;
  yearFilterInitialized: boolean;
  queuedItemIDs: Set<number>;
  selectedIndexed: Set<number>;
  selectedUnindexed: Set<number>;
  search: string;
  busy: boolean;
  fullIndexRunning: boolean;
};

const indexingEventCleanups = new WeakMap<Window, () => void>();
const statusHideTimers = new WeakMap<HTMLElement, number>();

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

export function handleIndexManagerWindowUnload(
  window: Window,
  _owner?: Window,
): void {
  indexingEventCleanups.get(window)?.();
  indexingEventCleanups.delete(window);
}

function getRequiredElements(document: Document): IndexManagerElements | null {
  const elements = {
    searchInput: document.getElementById("index-search-input"),
    libraryFilter: document.getElementById("index-library-filter"),
    typeFilter: document.getElementById("index-type-filter"),
    yearFilter: document.getElementById("index-year-filter"),
    status: document.getElementById("index-action-status"),
    indexingBanner: document.getElementById("indexing-banner"),
    indexingBannerActive: document.getElementById("indexing-banner-active"),
    indexingBannerActiveText: document.getElementById(
      "indexing-banner-active-text",
    ),
    refreshButton: document.getElementById("btn-refresh"),
    rebuildButton: document.getElementById("btn-rebuild-index"),
    cancelIndexingButton: document.getElementById("btn-cancel-indexing"),
    clearIndexButton: document.getElementById("btn-clear-index"),
    indexSelectedButton: document.getElementById("btn-index-selected"),
    unindexSelectedButton: document.getElementById("btn-unindex-selected"),
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

  elements.refreshButton.addEventListener("click", () => {
    void reloadPapers(
      window,
      elements,
      state,
      vectorStoreService,
      backgroundIndexerService,
    );
  });

  elements.rebuildButton.addEventListener("click", () => {
    void rebuildIndex(window, elements, state, backgroundIndexerService);
  });

  elements.cancelIndexingButton.addEventListener("click", () => {
    backgroundIndexerService.abort();
    setStatus(elements.status, "Abbruch angefordert ...", "warning");
  });

  elements.clearIndexButton.addEventListener("click", () => {
    void clearIndex(window, elements, state, vectorStoreService);
  });

  elements.indexSelectedButton.addEventListener("click", () => {
    void indexSelectedPapers(window, elements, state, backgroundIndexerService);
  });

  elements.unindexSelectedButton.addEventListener("click", () => {
    void unindexSelectedPapers(window, elements, state, vectorStoreService);
  });
}

function bindIndexingEvents(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  vectorStoreService: VectorStore,
  backgroundIndexerService: BackgroundIndexerService,
): () => void {
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

  const unsubError = indexingEvents.on("error", ({ itemID, message }) => {
    if (itemID !== undefined) {
      state.queuedItemIDs.delete(itemID);
    }
    renderIndexManager(window, elements, state);
    setStatus(elements.status, `Indexierungsfehler: ${message}`, "error");
  });

  const unsubFinished = indexingEvents.on("finished", ({ indexed, total }) => {
    state.queuedItemIDs.clear();
    state.fullIndexRunning = false;
    reloadAndShowStatus(
      `Indexierung abgeschlossen - ${indexed ?? 0} / ${total ?? "?"} Paper im Index.`,
      "success",
    );
  });

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
  }

  return () => {
    unsubStarted();
    unsubProgress();
    unsubSingleStarted();
    unsubSingleDone();
    unsubDeleted();
    unsubError();
    unsubFinished();
  };
}

async function reloadPapers(
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

async function collectPapers(
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

    papers.push(
      ...items.filter(isIndexableItem).map((item: any) => {
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

function isIndexableItem(item: any): boolean {
  if (isDeletedItem(item)) {
    return false;
  }

  if (item.isNote?.()) {
    return false;
  }

  if (item.isAttachment?.() && item.parentID) {
    return false;
  }

  if (item.isRegularItem?.()) {
    return true;
  }

  if (
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf"
  ) {
    return true;
  }

  return Boolean(item.isPDFAttachment?.());
}

function isDeletedItem(item: any): boolean {
  try {
    return Boolean(item.deleted ?? item.getField?.("deleted"));
  } catch {
    return false;
  }
}

function getItemTitle(item: any): string {
  const title = getItemField(item, "title", "");
  if (title) {
    return title;
  }

  try {
    const filename = item.getFilename?.();
    return filename ? String(filename) : "Ohne Titel";
  } catch {
    return "Ohne Titel";
  }
}

function getItemField(item: any, field: string, fallback: string): string {
  try {
    const value = item.getField?.(field);
    return value ? String(value) : fallback;
  } catch {
    return fallback;
  }
}

function getItemCreators(item: any): string {
  try {
    const creators = item.getCreators?.();
    if (!Array.isArray(creators) || creators.length === 0) {
      return "Unbekannt";
    }

    return creators
      .slice(0, 3)
      .map(
        (creator: any) => creator.lastName || creator.name || creator.firstName,
      )
      .filter(Boolean)
      .join(", ");
  } catch {
    return "Unbekannt";
  }
}

function getItemType(item: any): string {
  if (item.isPDFAttachment?.()) {
    return "PDF";
  }

  if (
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf"
  ) {
    return "PDF";
  }

  try {
    const rawType = item.itemType || item.getField?.("itemType");
    if (rawType) {
      return String(rawType);
    }
  } catch {
    // Fall through to the generic label.
  }

  return "Eintrag";
}

function updateFilterOptions(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
): void {
  const libraryFilteredPapers = getLibraryFilteredPapers(state);
  const types = uniqueSorted(
    libraryFilteredPapers.map((paper) => paper.itemType).filter(Boolean),
  );
  const years = uniqueSorted(
    libraryFilteredPapers
      .map((paper) => paper.year)
      .filter((year) => year && year !== "-"),
    true,
  );

  syncStringFilterSelection(
    state.selectedItemTypes,
    types,
    state.availableTypes,
    state.typeFilterInitialized,
  );
  syncStringFilterSelection(
    state.selectedYears,
    years,
    state.availableYears,
    state.yearFilterInitialized,
  );
  state.availableTypes = types;
  state.availableYears = years;
  state.typeFilterInitialized = true;
  state.yearFilterInitialized = true;

  renderAllFilterDropdowns(window, elements, state);
}

function syncSelectedLibraries(state: IndexManagerState): void {
  const libraryIDs = new Set(
    state.libraries.map((library) => library.libraryID),
  );
  if (!state.libraryFilterInitialized) {
    state.selectedLibraryIDs = new Set(libraryIDs);
    state.libraryFilterInitialized = true;
    return;
  }

  const filteredLibraryIDs = new Set(
    [...state.selectedLibraryIDs].filter((libraryID) =>
      libraryIDs.has(libraryID),
    ),
  );
  state.selectedLibraryIDs =
    filteredLibraryIDs.size > 0 ? filteredLibraryIDs : new Set(libraryIDs);
}

function syncStringFilterSelection(
  selectedValues: Set<string>,
  nextValues: string[],
  previousValues: string[],
  initialized: boolean,
): void {
  const wasAllSelected =
    initialized &&
    previousValues.length > 0 &&
    previousValues.every((value) => selectedValues.has(value));
  const nextValueSet = new Set(nextValues);

  if (!initialized || wasAllSelected) {
    selectedValues.clear();
    for (const value of nextValues) selectedValues.add(value);
    return;
  }

  for (const value of [...selectedValues]) {
    if (!nextValueSet.has(value)) selectedValues.delete(value);
  }
}

function renderLibraryFilter(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
): void {
  const isAllSelected =
    state.selectedLibraryIDs.size === state.libraries.length;
  replaceSelectOptions(
    window,
    elements.libraryFilter,
    [
      { value: ALL_FILTER_VALUE, label: "Alle Bibliotheken" },
      ...state.libraries.map((library) => ({
        value: String(library.libraryID),
        label: library.name,
      })),
    ],
    isAllSelected
      ? ALL_FILTER_VALUE
      : String([...state.selectedLibraryIDs][0] ?? ALL_FILTER_VALUE),
  );
}

function renderAllFilterDropdowns(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
): void {
  renderLibraryFilter(window, elements, state);

  const isTypeAllSelected =
    state.selectedItemTypes.size === state.availableTypes.length;
  replaceSelectOptions(
    window,
    elements.typeFilter,
    [
      { value: ALL_FILTER_VALUE, label: "Alle Typen" },
      ...toOptions(state.availableTypes),
    ],
    isTypeAllSelected
      ? ALL_FILTER_VALUE
      : ([...state.selectedItemTypes][0] ?? ALL_FILTER_VALUE),
  );

  const isYearAllSelected =
    state.selectedYears.size === state.availableYears.length;
  replaceSelectOptions(
    window,
    elements.yearFilter,
    [
      { value: ALL_FILTER_VALUE, label: "Alle Jahre" },
      ...toOptions(state.availableYears),
    ],
    isYearAllSelected
      ? ALL_FILTER_VALUE
      : ([...state.selectedYears][0] ?? ALL_FILTER_VALUE),
  );
}

function toOptions(values: string[]): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: value }));
}

function replaceSelectOptions(
  window: Window,
  select: HTMLSelectElement,
  options: { value: string; label: string }[],
  selectedValue: string,
): void {
  select.replaceChildren();
  for (const option of options) {
    const optionElement = window.document.createElement("option");
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    optionElement.selected = option.value === selectedValue;
    select.append(optionElement);
  }
}

function uniqueSorted(values: string[], descending = false): string[] {
  const sortedValues = Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
  return descending ? sortedValues.reverse() : sortedValues;
}

function renderIndexManager(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
): void {
  renderAllFilterDropdowns(window, elements, state);
  const libraryFilteredPapers = getLibraryFilteredPapers(state);
  const visiblePapers = getVisiblePapers(state);
  const unindexedPapers = visiblePapers.filter((paper) => !paper.indexed);
  const indexedPapers = visiblePapers.filter((paper) => paper.indexed);

  renderPaperList(
    window,
    elements.unindexedList,
    unindexedPapers,
    "unindexed",
    state,
    () => renderIndexManager(window, elements, state),
  );
  renderPaperList(
    window,
    elements.indexedList,
    indexedPapers,
    "indexed",
    state,
    () => renderIndexManager(window, elements, state),
  );

  elements.unindexedEmpty.hidden = unindexedPapers.length > 0;
  elements.indexedEmpty.hidden = indexedPapers.length > 0;
  elements.unindexedCount.textContent = formatCount(
    unindexedPapers.length,
    libraryFilteredPapers.filter((paper) => !paper.indexed).length,
  );
  elements.indexedCount.textContent = formatCount(
    indexedPapers.length,
    libraryFilteredPapers.filter((paper) => paper.indexed).length,
  );

  elements.indexSelectedButton.disabled =
    state.busy ||
    state.fullIndexRunning ||
    getSelectedPapers(state, "unindexed").length === 0;
  elements.unindexSelectedButton.disabled =
    state.busy ||
    state.fullIndexRunning ||
    getSelectedPapers(state, "indexed").length === 0;
  elements.refreshButton.disabled = state.busy;
  elements.rebuildButton.disabled =
    state.busy ||
    state.fullIndexRunning ||
    state.selectedLibraryIDs.size === 0 ||
    libraryFilteredPapers.length === 0;
  elements.clearIndexButton.disabled =
    state.busy ||
    state.fullIndexRunning ||
    state.papers.every((paper) => !paper.indexed);
}

function renderPaperList(
  window: Window,
  list: HTMLElement,
  papers: PaperRecord[],
  side: IndexSide,
  state: IndexManagerState,
  onSelectionChange: () => void,
): void {
  list.replaceChildren();

  for (const paper of papers) {
    const row = window.document.createElement("button");
    const selected = getSelectionSet(state, side).has(paper.itemID);
    const queued =
      side === "unindexed" && state.queuedItemIDs.has(paper.itemID);
    row.type = "button";
    row.className = `paper-row${selected ? " selected" : ""}${queued ? " is-queued" : ""}`;
    row.disabled = queued;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(selected));
    if (queued) {
      row.setAttribute("aria-disabled", "true");
    }
    row.dataset.itemId = String(paper.itemID);

    const title = window.document.createElement("span");
    title.className = "paper-row-title";
    title.textContent = paper.title;
    title.title = paper.title;

    const meta = window.document.createElement("span");
    meta.className = "paper-row-meta";
    meta.textContent = formatMeta(paper, queued);

    row.append(title, meta);
    row.addEventListener("click", () => {
      togglePaperSelection(state, side, paper.itemID);
      onSelectionChange();
    });

    list.append(row);
  }
}

function getVisiblePapers(state: IndexManagerState): PaperRecord[] {
  return getLibraryFilteredPapers(state).filter((paper) => {
    const matchesSearch =
      !state.search || paper.searchText.includes(state.search);
    const matchesType = state.selectedItemTypes.has(paper.itemType);
    const matchesYear =
      paper.year === "-"
        ? state.selectedYears.size === state.availableYears.length
        : state.selectedYears.has(paper.year);
    return matchesSearch && matchesType && matchesYear;
  });
}

function getLibraryFilteredPapers(state: IndexManagerState): PaperRecord[] {
  return filterPapersByLibrary(state.papers, state.selectedLibraryIDs);
}

function getSelectedLibraryIDs(state: IndexManagerState): number[] {
  return [...state.selectedLibraryIDs].filter(Number.isFinite);
}

export function filterPapersByLibrary<T extends { libraryID: number }>(
  papers: T[],
  selectedLibraryIDs: Set<number>,
): T[] {
  if (selectedLibraryIDs.size === 0) return [];
  return papers.filter((paper) => selectedLibraryIDs.has(paper.libraryID));
}

function togglePaperSelection(
  state: IndexManagerState,
  side: IndexSide,
  itemID: number,
): void {
  const selection = getSelectionSet(state, side);
  if (selection.has(itemID)) {
    selection.delete(itemID);
  } else {
    selection.add(itemID);
  }
}

function getSelectionSet(
  state: IndexManagerState,
  side: IndexSide,
): Set<number> {
  return side === "indexed" ? state.selectedIndexed : state.selectedUnindexed;
}

function getSelectedPapers(
  state: IndexManagerState,
  side: IndexSide,
): PaperRecord[] {
  const selection = getSelectionSet(state, side);
  return state.papers.filter(
    (paper) =>
      paper.indexed === (side === "indexed") &&
      selection.has(paper.itemID) &&
      (side === "indexed" || !state.queuedItemIDs.has(paper.itemID)),
  );
}

async function indexSelectedPapers(
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

async function unindexSelectedPapers(
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

async function rebuildIndex(
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

async function clearIndex(
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

async function maybeShowInitialIndexPrompt(
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

export function markInitialIndexPromptShown(): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.initialIndexPromptShown`, true, true);
}

function showInitialIndexPrompt(
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

function setBusy(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  busy: boolean,
): void {
  state.busy = busy;
  renderIndexManager(window, elements, state);
}

function trimSelections(state: IndexManagerState): void {
  const indexedIDs = new Set(
    state.papers.filter((paper) => paper.indexed).map((paper) => paper.itemID),
  );
  const unindexedIDs = new Set(
    state.papers.filter((paper) => !paper.indexed).map((paper) => paper.itemID),
  );

  state.selectedIndexed = new Set(
    [...state.selectedIndexed].filter((itemID) => indexedIDs.has(itemID)),
  );
  state.selectedUnindexed = new Set(
    [...state.selectedUnindexed].filter(
      (itemID) => unindexedIDs.has(itemID) && !state.queuedItemIDs.has(itemID),
    ),
  );
}

function trimQueuedItems(state: IndexManagerState): void {
  const pendingIDs = new Set(
    state.papers.filter((paper) => !paper.indexed).map((paper) => paper.itemID),
  );
  state.queuedItemIDs = new Set(
    [...state.queuedItemIDs].filter((itemID) => pendingIDs.has(itemID)),
  );
}

function clearSelections(state: IndexManagerState): void {
  state.selectedIndexed.clear();
  state.selectedUnindexed.clear();
}

/**
 * Zeigt eine einmalige Meldung (Erfolg/Warnung/Fehler/neutral) im gemeinsamen
 * Indexierungs-Banner an. Blendet dabei die persistente "aktiv"-Anzeige aus
 * und blendet die Meldung nach STATUS_AUTO_HIDE_DELAY_MS wieder aus.
 */
function setStatus(
  statusEl: HTMLElement,
  message: string,
  type: "" | "success" | "warning" | "error",
): void {
  clearStatusHideTimer(statusEl);

  const banner = statusEl.closest(".indexing-banner") as HTMLElement | null;
  const activeEl = banner?.querySelector<HTMLElement>(
    ".indexing-banner-active",
  );
  if (activeEl) activeEl.hidden = true;

  statusEl.textContent = message;
  statusEl.hidden = !message;
  statusEl.className = type ? `action-status ${type}` : "action-status";
  setBannerVisualState(banner, message ? type : null);

  if (!message) {
    return;
  }

  const statusWindow = statusEl.ownerDocument.defaultView;
  if (!statusWindow) {
    return;
  }

  const timerID = statusWindow.setTimeout(() => {
    if (statusHideTimers.get(statusEl) !== timerID) {
      return;
    }

    statusHideTimers.delete(statusEl);
    statusEl.textContent = "";
    statusEl.hidden = true;
    statusEl.className = "action-status";
    if (!activeEl || activeEl.hidden) setBannerVisualState(banner, null);
  }, STATUS_AUTO_HIDE_DELAY_MS);
  statusHideTimers.set(statusEl, timerID);
}

/**
 * Zeigt die persistente "Indexierung läuft"-Anzeige (Spinner, aktuelles
 * Paper, Abbrechen-Button) im gemeinsamen Banner. Bleibt sichtbar, bis der
 * nächste setStatus()- oder showIndexingActive()-Aufruf sie ersetzt.
 */
function showIndexingActive(
  elements: IndexManagerElements,
  text: string,
): void {
  clearStatusHideTimer(elements.status);
  elements.status.hidden = true;
  elements.status.textContent = "";
  elements.status.className = "action-status";

  elements.indexingBannerActiveText.textContent = text;
  elements.indexingBannerActive.hidden = false;
  setBannerVisualState(elements.indexingBanner, "active");
}

function setBannerVisualState(
  banner: HTMLElement | null | undefined,
  state: "active" | "success" | "warning" | "error" | "" | null,
): void {
  if (!banner) return;

  banner.classList.remove(
    "indexing-banner--active",
    "indexing-banner--success",
    "indexing-banner--warning",
    "indexing-banner--error",
  );

  if (state === null) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  if (state) banner.classList.add(`indexing-banner--${state}`);
}

function clearStatusHideTimer(statusEl: HTMLElement): void {
  const timerID = statusHideTimers.get(statusEl);
  if (timerID === undefined) {
    return;
  }

  statusEl.ownerDocument.defaultView?.clearTimeout(timerID);
  statusHideTimers.delete(statusEl);
}

function normalizeSearchText(values: string[]): string {
  return values.join(" ").toLowerCase();
}

function formatMeta(paper: PaperRecord, queued = false): string {
  const chunks = [
    paper.author,
    paper.year,
    paper.itemType,
    paper.libraryName,
  ].filter(Boolean);
  if (queued) {
    chunks.push("Indexierung läuft");
  }
  return chunks.join(" · ");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatCount(visible: number, total: number): string {
  return visible === total ? String(total) : `${visible} von ${total}`;
}

function logError(error: unknown): void {
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
}
