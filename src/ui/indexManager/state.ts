import type { IndexManagerState, PaperRecord, IndexSide } from "./types";

/**
 * Keeps selected library IDs valid when Zotero's available scopes change.
 *
 * @param state - Mutable index manager state.
 * @returns Nothing.
 */
export function syncSelectedLibraries(state: IndexManagerState): void {
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

/**
 * Preserves a string-filter selection while replacing its available values.
 *
 * A previous "all selected" state expands to include newly discovered values;
 * otherwise only values that no longer exist are removed.
 *
 * @param selectedValues - Mutable set of selected filter values.
 * @param nextValues - Newly available values.
 * @param previousValues - Values from the previous render.
 * @param initialized - Whether the filter has already been initialized.
 * @returns Nothing.
 */
export function syncStringFilterSelection(
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

/**
 * Deduplicates and naturally sorts user-facing filter values.
 *
 * @param values - Raw values to normalize.
 * @param descending - Whether to reverse the resulting order.
 * @returns Unique values in locale-aware order.
 */
export function uniqueSorted(values: string[], descending = false): string[] {
  const sortedValues = Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
  return descending ? sortedValues.reverse() : sortedValues;
}

/**
 * Applies library, text, type, and year filters to all papers.
 *
 * @param state - Current index manager state and filter selection.
 * @returns Papers visible in either index-manager column.
 */
export function getVisiblePapers(state: IndexManagerState): PaperRecord[] {
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

/**
 * Applies only the active library filter to the paper collection.
 *
 * @param state - Current index manager state.
 * @returns Papers from selected Zotero libraries.
 */
export function getLibraryFilteredPapers(
  state: IndexManagerState,
): PaperRecord[] {
  return filterPapersByLibrary(state.papers, state.selectedLibraryIDs);
}

/**
 * Converts the selected-library set into finite IDs for indexing calls.
 *
 * @param state - Current index manager state.
 * @returns Selected Zotero library IDs.
 */
export function getSelectedLibraryIDs(state: IndexManagerState): number[] {
  return [...state.selectedLibraryIDs].filter(Number.isFinite);
}

/**
 * Filters any library-scoped record collection by selected library IDs.
 *
 * @param papers - Records carrying a Zotero library ID.
 * @param selectedLibraryIDs - Library IDs included by the current filter.
 * @returns Records belonging to selected libraries.
 */
export function filterPapersByLibrary<T extends { libraryID: number }>(
  papers: T[],
  selectedLibraryIDs: Set<number>,
): T[] {
  if (selectedLibraryIDs.size === 0) return [];
  return papers.filter((paper) => selectedLibraryIDs.has(paper.libraryID));
}

/**
 * Toggles one paper in the indexed or unindexed selection set.
 *
 * @param state - Mutable index manager state.
 * @param side - Column containing the paper.
 * @param itemID - Zotero item ID to toggle.
 * @returns Nothing.
 */
export function togglePaperSelection(
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

/**
 * Selects the state set associated with an index-manager column.
 *
 * @param state - Current index manager state.
 * @param side - Indexed or unindexed column.
 * @returns Mutable item-ID selection set for the column.
 */
export function getSelectionSet(
  state: IndexManagerState,
  side: IndexSide,
): Set<number> {
  return side === "indexed" ? state.selectedIndexed : state.selectedUnindexed;
}

/**
 * Resolves currently selected papers that are eligible for a column action.
 *
 * @param state - Current index manager state.
 * @param side - Indexed or unindexed column.
 * @returns Selected papers, excluding unindexed papers already queued.
 */
export function getSelectedPapers(
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

/**
 * Removes selections that no longer match a paper's current index state.
 *
 * @param state - Mutable index manager state.
 * @returns Nothing.
 */
export function trimSelections(state: IndexManagerState): void {
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

/**
 * Removes queued IDs for papers no longer waiting to be indexed.
 *
 * @param state - Mutable index manager state.
 * @returns Nothing.
 */
export function trimQueuedItems(state: IndexManagerState): void {
  const pendingIDs = new Set(
    state.papers.filter((paper) => !paper.indexed).map((paper) => paper.itemID),
  );
  state.queuedItemIDs = new Set(
    [...state.queuedItemIDs].filter((itemID) => pendingIDs.has(itemID)),
  );
}

/**
 * Clears selections in both paper columns.
 *
 * @param state - Mutable index manager state.
 * @returns Nothing.
 */
export function clearSelections(state: IndexManagerState): void {
  state.selectedIndexed.clear();
  state.selectedUnindexed.clear();
}

/**
 * Builds the normalized search haystack stored on each paper record.
 *
 * @param values - Metadata values searchable in the index manager.
 * @returns Lowercase text containing all supplied values.
 */
export function normalizeSearchText(values: string[]): string {
  return values.join(" ").toLowerCase();
}
