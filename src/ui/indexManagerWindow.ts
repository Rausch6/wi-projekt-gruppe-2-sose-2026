import { backgroundIndexer } from "../core/BackgroundIndexer";
import { indexingEvents } from "../core/IndexingEventBus";
import { vectorStore } from "../core/OramaService";

type VectorStore = typeof vectorStore;
type BackgroundIndexerService = typeof backgroundIndexer;

const STATUS_AUTO_HIDE_DELAY_MS = 5000;

type IndexSide = "indexed" | "unindexed";

type PaperRecord = {
  itemID: number;
  title: string;
  author: string;
  year: string;
  itemType: string;
  indexed: boolean;
  searchText: string;
};

type IndexManagerElements = {
  searchInput: HTMLInputElement;
  typeFilter: HTMLSelectElement;
  yearFilter: HTMLSelectElement;
  status: HTMLElement;
  refreshButton: HTMLButtonElement;
  rebuildButton: HTMLButtonElement;
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
  queuedItemIDs: Set<number>;
  selectedIndexed: Set<number>;
  selectedUnindexed: Set<number>;
  search: string;
  itemType: string;
  year: string;
  busy: boolean;
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
    queuedItemIDs: new Set<number>(),
    selectedIndexed: new Set<number>(),
    selectedUnindexed: new Set<number>(),
    search: "",
    itemType: "all",
    year: "all",
    busy: false,
  };

  indexingEventCleanups.get(window)?.();
  indexingEventCleanups.set(
    window,
    bindIndexingEvents(window, elements, state, vectorStore, backgroundIndexer),
  );

  bindEvents(window, elements, state, vectorStore, backgroundIndexer);
  await reloadPapers(window, elements, state, vectorStore, backgroundIndexer);
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
    typeFilter: document.getElementById("index-type-filter"),
    yearFilter: document.getElementById("index-year-filter"),
    status: document.getElementById("index-action-status"),
    refreshButton: document.getElementById("btn-refresh"),
    rebuildButton: document.getElementById("btn-rebuild-index"),
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

  elements.typeFilter.addEventListener("change", () => {
    state.itemType = elements.typeFilter.value;
    clearSelections(state);
    renderIndexManager(window, elements, state);
  });

  elements.yearFilter.addEventListener("change", () => {
    state.year = elements.yearFilter.value;
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
    void rebuildIndex(
      window,
      elements,
      state,
      vectorStoreService,
      backgroundIndexerService,
    );
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
    setStatus(
      elements.status,
      mode === "full"
        ? "Bibliotheks-Indexierung läuft ..."
        : "Indexierung läuft ...",
      "warning",
    );
  });

  const unsubProgress = indexingEvents.on(
    "progress",
    ({ indexed, total, estimatedRemainingMs }) => {
      let message = `Indexierung läuft - ${indexed} / ${total} Paper im Index`;
      if (estimatedRemainingMs !== undefined && estimatedRemainingMs > 0) {
        message += `, noch ca. ${formatDuration(estimatedRemainingMs)}`;
      }
      setStatus(elements.status, message, "warning");
    },
  );

  const unsubSingleStarted = indexingEvents.on(
    "singleStarted",
    ({ itemID, paperTitle }) => {
      if (itemID !== undefined) {
        state.queuedItemIDs.add(itemID);
      }
      renderIndexManager(window, elements, state);
      setStatus(
        elements.status,
        paperTitle
          ? `"${paperTitle}" wird indexiert ...`
          : "Paper wird indexiert ...",
        "warning",
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
    reloadAndShowStatus(
      `Indexierung abgeschlossen - ${indexed ?? 0} / ${total ?? "?"} Paper im Index.`,
      "success",
    );
  });

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
    state.papers = await collectPapers(vectorStoreService);
    trimQueuedItems(state);
    trimSelections(state);
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
): Promise<PaperRecord[]> {
  const items = await Zotero.Items.getAll(
    Zotero.Libraries.userLibraryID,
    false,
    false,
    false,
  );
  const indexedItemIds = vectorStoreService.getIndexedItemIds();

  return items
    .filter(isIndexableItem)
    .map((item: any) => {
      const title = getItemTitle(item);
      const author = getItemCreators(item);
      const year = getItemField(item, "year", "-");
      const itemType = getItemType(item);
      const indexed = indexedItemIds.has(String(item.id));

      return {
        itemID: item.id,
        title,
        author,
        year,
        itemType,
        indexed,
        searchText: normalizeSearchText([title, author, year, itemType]),
      };
    })
    .sort((left: PaperRecord, right: PaperRecord) =>
      left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
    );
}

function isIndexableItem(item: any): boolean {
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
  const types = uniqueSorted(
    state.papers.map((paper) => paper.itemType).filter(Boolean),
  );
  const years = uniqueSorted(
    state.papers
      .map((paper) => paper.year)
      .filter((year) => year && year !== "-"),
    true,
  );

  replaceSelectOptions(window, elements.typeFilter, [
    { value: "all", label: "Alle Typen" },
    ...toOptions(types),
  ]);
  replaceSelectOptions(window, elements.yearFilter, [
    { value: "all", label: "Alle Jahre" },
    ...toOptions(years),
  ]);

  if (!types.includes(state.itemType)) {
    state.itemType = "all";
  }
  if (!years.includes(state.year)) {
    state.year = "all";
  }

  elements.typeFilter.value = state.itemType;
  elements.yearFilter.value = state.year;
}

function replaceSelectOptions(
  window: Window,
  select: HTMLSelectElement,
  options: { value: string; label: string }[],
): void {
  select.replaceChildren();
  for (const option of options) {
    const optionElement = window.document.createElement("option");
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    select.append(optionElement);
  }
}

function toOptions(values: string[]): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: value }));
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
    state.papers.filter((paper) => !paper.indexed).length,
  );
  elements.indexedCount.textContent = formatCount(
    indexedPapers.length,
    state.papers.filter((paper) => paper.indexed).length,
  );

  elements.indexSelectedButton.disabled =
    state.busy || getSelectedPapers(state, "unindexed").length === 0;
  elements.unindexSelectedButton.disabled =
    state.busy || getSelectedPapers(state, "indexed").length === 0;
  elements.refreshButton.disabled = state.busy;
  elements.rebuildButton.disabled = state.busy || state.papers.length === 0;
  elements.clearIndexButton.disabled =
    state.busy || state.papers.every((paper) => !paper.indexed);
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
  return state.papers.filter((paper) => {
    const matchesSearch =
      !state.search || paper.searchText.includes(state.search);
    const matchesType =
      state.itemType === "all" || paper.itemType === state.itemType;
    const matchesYear = state.year === "all" || paper.year === state.year;
    return matchesSearch && matchesType && matchesYear;
  });
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
      "Ausgewählte Paper konnten nicht zur Indexierung übergeben werden.",
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
  vectorStoreService: VectorStore,
  backgroundIndexerService: BackgroundIndexerService,
): Promise<void> {
  const confirmed = window.confirm(
    "Den gesamten ZAIA-Index neu aufbauen? Das kann einige Minuten dauern.",
  );
  if (!confirmed) {
    return;
  }

  setBusy(window, elements, state, true);
  setStatus(elements.status, "Index wird neu aufgebaut ...", "");

  try {
    await vectorStoreService.clearIndex();
    void backgroundIndexerService
      .indexAllLibraryItems()
      .catch((error: unknown) => {
        logError(error);
        setStatus(
          elements.status,
          "Neu-Indexierung konnte nicht abgeschlossen werden.",
          "error",
        );
      });
    state.papers = state.papers.map((paper) => ({ ...paper, indexed: false }));
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

function setStatus(
  statusEl: HTMLElement,
  message: string,
  type: "" | "success" | "warning" | "error",
): void {
  clearStatusHideTimer(statusEl);
  statusEl.textContent = message;
  statusEl.className = type ? `action-status ${type}` : "action-status";

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
    statusEl.className = "action-status";
  }, STATUS_AUTO_HIDE_DELAY_MS);
  statusHideTimers.set(statusEl, timerID);
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
  const chunks = [paper.author, paper.year, paper.itemType].filter(Boolean);
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
