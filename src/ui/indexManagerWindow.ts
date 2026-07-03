import { config } from "../../package.json";

export async function initializeIndexManagerWindow(
  window: Window,
  owner: _ZoteroTypes.MainWindow,
) {
  const addonAPI = (Zotero as any)[config.addonInstance].api;
  const vectorStore = addonAPI.vectorStore;
  const backgroundIndexer = addonAPI.backgroundIndexer;

  try {
    // @ts-ignore
    window.MozXULElement?.insertFTLIfNeeded(
      `${config.addonRef}-preferences.ftl`,
    );
  } catch (e) {
    Zotero.debug(`[IndexManager] Error inserting FTL: ${e}`);
  }

  const tbody = window.document.getElementById("papers-tbody");
  const emptyState = window.document.getElementById("empty-state");
  const btnRefresh = window.document.getElementById("btn-refresh");

  if (!tbody || !emptyState || !btnRefresh) return;

  btnRefresh.addEventListener("click", () => {
    loadPapers(window, tbody, emptyState, vectorStore, backgroundIndexer);
  });

  await loadPapers(window, tbody, emptyState, vectorStore, backgroundIndexer);
}

export function handleIndexManagerWindowUnload(window: Window, owner: Window) {
}

async function loadPapers(
  window: Window,
  tbody: HTMLElement,
  emptyState: HTMLElement,
  vectorStore: any,
  backgroundIndexer: any,
) {
  tbody.innerHTML = "";
  emptyState.style.display = "none";

  const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false, false);
  const validItems = items.filter((item) => {
    if (item.isNote()) return false;
    if (item.isAttachment() && item.parentID) return false; // Child attachments handled via parent
    
    if (item.isRegularItem()) return true;
    if (item.isAttachment() && item.attachmentContentType === "application/pdf") return true;
    
    return false;
  });

  if (validItems.length === 0) {
    emptyState.style.display = "block";
    return;
  }

  const indexedItemIds = vectorStore.getIndexedItemIds();

  const fragment = window.document.createDocumentFragment();

  for (const item of validItems) {
    const isIndexed = indexedItemIds.has(item.id.toString());
    const title = item.getField("title") || (item.isAttachment() ? (item as any).getFilename() : "Unbekannter Titel");
    const author = item.firstCreator || "";
    const year = item.getField("year") || "";

    const tr = window.document.createElement("tr");

    const tdStatus = window.document.createElement("td");
    tdStatus.className = "col-status";
    const checkbox = window.document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isIndexed;
    
    checkbox.addEventListener("change", async (e) => {
      const target = e.target as HTMLInputElement;
      target.disabled = true; // prevent double clicks
      try {
        if (target.checked) {

          backgroundIndexer.enqueue([item.id]);
        } else {

          await vectorStore.deleteByZoteroItemId(item.id.toString());
        }
      } catch (err) {
        Zotero.debug(`[IndexManager] Error toggling item ${item.id}: ${err}`);
        target.checked = !target.checked; // revert
      } finally {
        target.disabled = false;
      }
    });

    tdStatus.appendChild(checkbox);
    tr.appendChild(tdStatus);

    const tdTitle = window.document.createElement("td");
    tdTitle.className = "col-title";
    tdTitle.textContent = title as string;
    tr.appendChild(tdTitle);

    const tdAuthor = window.document.createElement("td");
    tdAuthor.className = "col-author";
    tdAuthor.textContent = author as string;
    tr.appendChild(tdAuthor);

    const tdYear = window.document.createElement("td");
    tdYear.className = "col-year";
    tdYear.textContent = year as string;
    tr.appendChild(tdYear);

    fragment.appendChild(tr);
  }

  tbody.appendChild(fragment);
}
