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
} from "./zoteroUtils";

declare const Zotero: any;

/**
 * Lädt alle Paper aus allen bekannten Bibliotheken neu und aktualisiert die Ansicht des IndexManagers.
 * Zeigt während des Ladevorgangs einen Busy-Zustand an und gibt nach Abschluss eine Statusmeldung aus.
 *
 * @param window - Das aktive Browserfenster.
 * @param elements - Die DOM-Elemente des IndexManagers.
 * @param state - Der aktuelle Zustand des IndexManagers.
 * @param vectorStoreService - Der Dienst für den Vektorindex.
 * @param backgroundIndexerService - Der Hintergrund-Indexierungsdienst.
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
 * Sammelt alle indexierbaren Paper aus sämtlichen bekannten Bibliotheken.
 *
 * Die Items werden in zwei Schritten geladen:
 * Zunächst werden nur die Item-IDs der jeweiligen Bibliothek abgefragt,
 * anschließend werden die vollständigen Item-Objekte per Batch über
 * Zotero.Items.getAsync aus der Datenbank geladen.
 * Dieses Vorgehen stellt sicher, dass Metadaten auch dann
 * korrekt verfügbar sind, wenn die Bibliothek noch nicht in der
 * Zotero-Seitenleiste geöffnet wurde.
 * 
 * @param vectorStoreService - Der Dienst für den Vektorindex,
 *                             der die bereits indexierten Item-IDs liefert.
 * @returns Ein Objekt mit der Liste der Bibliotheken und den zugehörigen PaperRecords.
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
    let loadedItems: any[] = [];
    try {
      const itemIDs: number[] = await Zotero.Items.getAllIDs(library.libraryID);
      loadedItems = await Zotero.Items.getAsync(itemIDs);
    } catch (error) {
      logError(error);
      continue;
    }

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
 * Startet die Indexierung aller ausgewählten, noch nicht indexierten Paper.
 * Zeigt eine Warnung, falls keine Paper ausgewählt sind.
 *
 * @param window - Das aktive Browserfenster.
 * @param elements - Die DOM-Elemente des IndexManagers.
 * @param state - Der aktuelle Zustand des IndexManagers.
 * @param backgroundIndexerService - Der Hintergrund-Indexierungsdienst.
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
 * Entfernt alle ausgewählten, bereits indexierten Paper aus dem ZAIA-Index.
 * Der Nutzer muss den Vorgang zuvor in einem Bestätigungsdialog bestätigen.
 * Die Zotero-Einträge selbst bleiben dabei erhalten.
 *
 * @param window - Das aktive Browserfenster.
 * @param elements - Die DOM-Elemente des IndexManagers.
 * @param state - Der aktuelle Zustand des IndexManagers.
 * @param vectorStoreService - Der Dienst für den Vektorindex.
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
 * Baut den ZAIA-Index für die ausgewählten Bibliotheken vollständig neu auf.
 * Der Nutzer muss den Vorgang zuvor in einem Bestätigungsdialog bestätigen.
 * Gibt eine Warnung aus, falls bereits eine Indexierung läuft oder keine
 * Bibliothek ausgewählt ist.
 *
 * @param window - Das aktive Browserfenster.
 * @param elements - Die DOM-Elemente des IndexManagers.
 * @param state - Der aktuelle Zustand des IndexManagers.
 * @param backgroundIndexerService - Der Hintergrund-Indexierungsdienst.
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

  if (state.libraries.length === 0) {
    setStatus(
      elements.status,
      "Es ist keine Bibliothek für den Neuaufbau verfügbar.",
      "warning",
    );
    renderIndexManager(window, elements, state);
    return;
  }

  const result = await showLibrarySelectionPrompt(window, state.libraries, {
    title: "ZAIA-Index für ausgewählte Bibliotheken neu aufbauen?",
    confirmLabel: "Index neu aufbauen",
    description:
      "Die bestehenden Indexdaten dieser Bibliotheken werden gelöscht und neu aufgebaut. Das kann einige Minuten dauern.",
    selectedLibraryIDs: state.selectedLibraryIDs,
  });
  if (!result.confirmed) {
    renderIndexManager(window, elements, state);
    return;
  }

  const libraryIDs = result.libraryIDs;
  if (libraryIDs.length === 0) {
    setStatus(
      elements.status,
      "Wähle mindestens eine Bibliothek für den Neuaufbau aus.",
      "warning",
    );
    renderIndexManager(window, elements, state);
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
 * Leert den gesamten ZAIA-Index aller Paper.
 * Der Nutzer muss den Vorgang zuvor in einem Bestätigungsdialog bestätigen.
 * Die Zotero-Einträge selbst bleiben dabei erhalten.
 *
 * @param window - Das aktive Browserfenster.
 * @param elements - Die DOM-Elemente des IndexManagers.
 * @param state - Der aktuelle Zustand des IndexManagers.
 * @param vectorStoreService - Der Dienst für den Vektorindex.
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
 * Zeigt beim ersten Öffnen des IndexManagers einen Dialog an,
 * der den Nutzer fragt, ob die gesamte Bibliothek indexiert werden soll.
 * Wurde der Dialog bereits einmal angezeigt, wird er nicht erneut geöffnet.
 *
 * @param window - Das aktive Browserfenster.
 * @param elements - Die DOM-Elemente des IndexManagers.
 * @param state - Der aktuelle Zustand des IndexManagers.
 * @param backgroundIndexerService - Der Hintergrund-Indexierungsdienst.
 */
export async function maybeShowInitialIndexPrompt(
  window: Window,
  elements: IndexManagerElements,
  state: IndexManagerState,
  backgroundIndexerService: BackgroundIndexerService,
): Promise<void> {
  if (!shouldShowInitialIndexPrompt() || state.libraries.length === 0) return;

  const result = await showLibrarySelectionPrompt(window, state.libraries);
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
 * Prüft, ob der Erststart-Indexierungsdialog dem Nutzer noch angezeigt werden soll.
 *
 * @returns `true`, wenn der Dialog noch nicht angezeigt wurde, sonst `false`.
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
 * Speichert in den Zotero-Einstellungen, dass der Erststart-Indexierungsdialog
 * bereits angezeigt wurde, damit er nicht erneut erscheint.
 */
export function markInitialIndexPromptShown(): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.initialIndexPromptShown`, true, true);
}

/**
 * Zeigt einen modalen Dialog an, in dem der Nutzer auswählen kann,
 * welche Bibliotheken initial indexiert werden sollen.
 *
 * @param window - Das aktive Browserfenster.
 * @param libraries - Die zur Auswahl stehenden Bibliotheken.
 * @returns Ein Promise, das mit dem Bestätigungsstatus und den ausgewählten Bibliotheks-IDs aufgelöst wird.
 */
export function showLibrarySelectionPrompt(
  window: Window,
  libraries: LibraryFilterOption[],
  options: { title?: string; description?: string; confirmLabel?: string; selectedLibraryIDs?: Set<number> } = {},
): Promise<{ confirmed: boolean; libraryIDs: number[] }> {
  const doc = window.document;
  const selectedLibraryIDs = options.selectedLibraryIDs
    ? new Set(options.selectedLibraryIDs)
    : null;
  const overlay = doc.createElement("div");
  overlay.className = "initial-index-prompt-backdrop";
  overlay.setAttribute("role", "presentation");

  const dialog = doc.createElement("section");
  dialog.className = "initial-index-prompt";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "initial-index-prompt-title");
  if (options.description) {
    dialog.setAttribute("aria-describedby", "initial-index-prompt-description");
  }

  const title = doc.createElement("h2");
  title.id = "initial-index-prompt-title";
  title.textContent =
    options.title ?? "Indexierung der gesamten Library starten?";

  const description = doc.createElement("p");
  description.id = "initial-index-prompt-description";
  description.className = "initial-index-prompt-description";
  description.textContent = options.description ?? "";
  description.hidden = !options.description;

  const list = doc.createElement("div");
  list.className = "initial-index-library-list";

  for (const library of libraries) {
    const label = doc.createElement("label");
    label.className = "initial-index-library-option";

    const checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(library.libraryID);
    checkbox.checked =
      selectedLibraryIDs === null || selectedLibraryIDs.has(library.libraryID);

    const text = doc.createElement("span");
    text.textContent = library.name;

    label.append(checkbox, text);
    list.append(label);
  }

  const actions = doc.createElement("div");
  actions.className = "initial-index-actions";

  const startButton = doc.createElement("button");
  startButton.type = "button";
  startButton.textContent = options.confirmLabel ?? "Indexierung starten";

  const skipButton = doc.createElement("button");
  skipButton.type = "button";
  skipButton.textContent = "Nicht jetzt";

  actions.append(skipButton, startButton);
  dialog.append(title, description, list, actions);
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
 * Protokolliert einen Fehler über die Zotero-interne Fehlerprotokollierung.
 *
 * @param error - Der zu protokollierende Fehler.
 */
export function logError(error: unknown): void {
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
}
