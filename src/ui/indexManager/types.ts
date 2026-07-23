import { type LibraryScope } from "../../core/LibraryScopeManager";
import { vectorStore } from "../../core/OramaService";
import { backgroundIndexer } from "../../core/BackgroundIndexer";

/**
 * Concrete vector-store service type used by the application singleton.
 */
export type VectorStore = typeof vectorStore;

/**
 * Concrete background-indexer service type used by the application singleton.
 */
export type BackgroundIndexerService = typeof backgroundIndexer;

/**
 * Index-manager column containing a paper.
 */
export type IndexSide = "indexed" | "unindexed";

/**
 * UI-friendly representation of a Zotero paper and its index state.
 */
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

/**
 * Library data required by the index manager's scope filter.
 */
export type LibraryFilterOption = Pick<
  LibraryScope,
  "libraryID" | "name" | "type"
>;

/**
 * Required DOM elements of the index manager window.
 */
export type IndexManagerElements = {
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

/**
 * Mutable filter, selection, queue, and loading state for the index manager.
 */
export type IndexManagerState = {
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
