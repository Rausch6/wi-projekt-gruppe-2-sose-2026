import type {
  IndexManagerElements,
  IndexManagerState,
  PaperRecord,
  IndexSide,
} from "./types";
import {
  getLibraryFilteredPapers,
  getVisiblePapers,
  getSelectionSet,
  getSelectedPapers,
  syncStringFilterSelection,
  uniqueSorted,
  togglePaperSelection,
} from "./state";

/**
 * Sentinel select value representing every available filter option.
 */
export const ALL_FILTER_VALUE = "__all__";

/**
 * Time a completed action status remains visible.
 */
export const STATUS_AUTO_HIDE_DELAY_MS = 5000;

/**
 * Pending status-dismiss timers keyed by their status element.
 */
export const statusHideTimers = new WeakMap<HTMLElement, number>();

/**
 * Rebuilds type and year options from papers in the selected libraries.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Mutable index manager state.
 * @returns Nothing.
 */
export function updateFilterOptions(
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

/**
 * Renders the Zotero library filter and restores its current selection.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Current index manager state.
 * @returns Nothing.
 */
export function renderLibraryFilter(
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

/**
 * Renders library, type, and year select controls from current state.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Current index manager state.
 * @returns Nothing.
 */
export function renderAllFilterDropdowns(
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

/**
 * Maps plain strings to value-label pairs for HTML select options.
 *
 * @param values - Values to convert.
 * @returns Select option descriptors.
 */
export function toOptions(
  values: string[],
): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: value }));
}

/**
 * Replaces a select's options and marks the active value as selected.
 *
 * @param window - Window whose document creates the option elements.
 * @param select - Select control to update.
 * @param options - Option value-label pairs.
 * @param selectedValue - Value that should remain selected.
 * @returns Nothing.
 */
export function replaceSelectOptions(
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

/**
 * Renders both paper columns, counts, filters, and action availability.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Current index manager state.
 * @returns Nothing.
 */
export function renderIndexManager(
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

/**
 * Renders selectable paper rows for one side of the index manager.
 *
 * @param window - Index manager dialog window.
 * @param list - List container receiving paper rows.
 * @param papers - Papers visible in this column.
 * @param side - Indexed or unindexed column.
 * @param state - Mutable index manager state.
 * @param onSelectionChange - Callback used to rerender after a selection.
 * @returns Nothing.
 */
export function renderPaperList(
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

/**
 * Updates the global busy flag and rerenders all controls.
 *
 * @param window - Index manager dialog window.
 * @param elements - Required index manager controls.
 * @param state - Mutable index manager state.
 * @param busy - Whether a blocking UI action is in progress.
 * @returns Nothing.
 */
export function setBusy(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  busy: boolean,
): void {
  state.busy = busy;
  renderIndexManager(window, elements, state);
}

/**
 * Displays a temporary terminal status and hides active progress content.
 *
 * @param statusEl - Status element to update.
 * @param message - User-facing status text, or empty text to clear it.
 * @param type - Visual status variant.
 * @returns Nothing.
 */
export function setStatus(
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
 * Displays persistent active-indexing progress in the status banner.
 *
 * @param elements - Required index manager controls.
 * @param text - Current indexing progress text.
 * @returns Nothing.
 */
export function showIndexingActive(
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

/**
 * Applies the appropriate visual class and visibility to the status banner.
 *
 * @param banner - Status banner to update.
 * @param state - Active or terminal visual state; null hides the banner.
 * @returns Nothing.
 */
export function setBannerVisualState(
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

/**
 * Cancels a pending automatic status dismissal.
 *
 * @param statusEl - Status element whose timer should be cleared.
 * @returns Nothing.
 */
export function clearStatusHideTimer(statusEl: HTMLElement): void {
  const timerID = statusHideTimers.get(statusEl);
  if (timerID === undefined) {
    return;
  }

  statusEl.ownerDocument.defaultView?.clearTimeout(timerID);
  statusHideTimers.delete(statusEl);
}

/**
 * Formats the metadata subtitle shown below a paper title.
 *
 * @param paper - Paper record to format.
 * @param queued - Whether to append an active-indexing label.
 * @returns Human-readable metadata segments separated by middle dots.
 */
export function formatMeta(paper: PaperRecord, queued = false): string {
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

/**
 * Formats milliseconds as compact minutes and seconds.
 *
 * @param ms - Duration in milliseconds.
 * @returns Compact duration string.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Formats a filtered count relative to the total available records.
 *
 * @param visible - Number of records visible after all filters.
 * @param total - Total records in the selected libraries.
 * @returns Total alone or a "visible of total" label.
 */
export function formatCount(visible: number, total: number): string {
  return visible === total ? String(total) : `${visible} von ${total}`;
}
