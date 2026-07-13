import type { IndexManagerState, PaperRecord, IndexSide } from "./types";

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

export function uniqueSorted(values: string[], descending = false): string[] {
  const sortedValues = Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
  return descending ? sortedValues.reverse() : sortedValues;
}

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

export function getLibraryFilteredPapers(state: IndexManagerState): PaperRecord[] {
  return filterPapersByLibrary(state.papers, state.selectedLibraryIDs);
}

export function getSelectedLibraryIDs(state: IndexManagerState): number[] {
  return [...state.selectedLibraryIDs].filter(Number.isFinite);
}

export function filterPapersByLibrary<T extends { libraryID: number }>(
  papers: T[],
  selectedLibraryIDs: Set<number>,
): T[] {
  if (selectedLibraryIDs.size === 0) return [];
  return papers.filter((paper) => selectedLibraryIDs.has(paper.libraryID));
}

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

export function getSelectionSet(
  state: IndexManagerState,
  side: IndexSide,
): Set<number> {
  return side === "indexed" ? state.selectedIndexed : state.selectedUnindexed;
}

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

export function trimQueuedItems(state: IndexManagerState): void {
  const pendingIDs = new Set(
    state.papers.filter((paper) => !paper.indexed).map((paper) => paper.itemID),
  );
  state.queuedItemIDs = new Set(
    [...state.queuedItemIDs].filter((itemID) => pendingIDs.has(itemID)),
  );
}

export function clearSelections(state: IndexManagerState): void {
  state.selectedIndexed.clear();
  state.selectedUnindexed.clear();
}

export function normalizeSearchText(values: string[]): string {
  return values.join(" ").toLowerCase();
}
