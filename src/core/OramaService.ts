import {
  create,
  insertMultiple,
  search,
  removeMultiple,
  Orama,
  save,
  load,
} from "@orama/orama";

declare const Zotero: any;
declare const IOUtils: any;
declare const OS: any;
declare const PathUtils: any;

const VECTOR_SIZE = 1024;

const mySchema = {
  id: "string",
  zoteroItemId: "string",
  sourceType: "string",
  content: "string",
  pageNumber: "number",
  embedding: `vector[${VECTOR_SIZE}]`,
} as const;

export type IndexedSourceType = "abstract" | "fulltext";

export type ChunkDocument = {
  id: string;
  zoteroItemId: string;
  sourceType: IndexedSourceType;
  content: string;
  pageNumber: number;
  embedding: number[];
};

type VectorDB = Orama<typeof mySchema>;

export class OramaService {
  private db!: VectorDB;
  private isInitialized = false;
  private saveTimeout: any = null;
  private readonly SAVE_DELAY_MS = 2000;
  private textHashes = new Map<string, string>();
  private indexedItemIds = new Set<string>();

  /**
   * Startet die Orama-Datenbank und lädt ggf. einen gespeicherten Index von der Festplatte.
   */
  async initialize() {
    if (this.isInitialized) return;

    this.db = (await create({
      schema: mySchema,
    })) as VectorDB;

    await this.loadIndex();

    this.isInitialized = true;
    Zotero.debug("[OramaService]: Database initialized.");
  }

  /**
   * Fügt eine Liste von Text-Chunks inklusive Embeddings in Orama ein.
   */
  async addChunks(chunks: ChunkDocument[]) {
    this.checkInit();

    await insertMultiple(this.db, chunks as any);
    for (const chunk of chunks) {
      this.indexedItemIds.add(chunk.zoteroItemId);
    }

    this.scheduleSave();
  }

  /**
   * Führt eine kombinierte Vektor- und/oder Keyword-Suche in Orama durch.
   */
  async searchSimilar(
    queryVector: number[] | null,
    limit: number = 5,
    whereFilter?: any,
    term?: string,
  ) {
    this.checkInit();

    let mode = "vector";
    if (queryVector && term) mode = "hybrid";
    else if (!queryVector && term) mode = "fulltext";

    const searchParams: any = {
      mode: mode,
      limit: limit,
    };

    if (queryVector) {
      searchParams.vector = {
        value: queryVector,
        property: "embedding",
      };
      searchParams.similarity = 0.1; // Ensure we get the closest hits even if absolute similarity is low
    }

    if (term) {
      searchParams.term = term;
      searchParams.properties = ["content"];
    }

    if (whereFilter) {
      searchParams.where = whereFilter;
    }

    const results = await search(this.db, searchParams);

    Zotero.debug(
      `[OramaService] Suche ausgeführt (Mode: ${searchParams.mode}, Filter: ${whereFilter ? JSON.stringify(whereFilter) : "keine"}, Term: ${term || "keiner"}). Treffer: ${results.hits.length}`,
    );

    return results.hits;
  }

  /**
   * Löscht alle Chunks, die zu einer bestimmten Zotero-ID gehören.
   * Wichtig, wenn der Nutzer ein PDF aus Zotero löscht.
   */
  async deleteByZoteroItemId(zoteroItemId: string) {
    this.checkInit();
    this.deleteTextHash(zoteroItemId);
    this.indexedItemIds.delete(zoteroItemId);

    const results = await search(this.db, {
      term: "",
      where: {
        zoteroItemId: zoteroItemId,
      },
      limit: 10000,
    });

    if (results.hits.length > 0) {
      const idsToRemove = results.hits.map((hit) => hit.id);
      await removeMultiple(this.db, idsToRemove);

      this.scheduleSave();
      Zotero.debug(
        `[OramaService]: Deleted ${idsToRemove.length} chunks for item ${zoteroItemId}`,
      );

      // Versuche den Titel für die UI-Benachrichtigung zu laden
      let paperTitle;
      try {
        const item = await Zotero.Items.getAsync(parseInt(zoteroItemId, 10));
        if (item) {
          paperTitle =
            item.getField("title") ||
            (item.isAttachment() ? (item as any).getFilename() : undefined);
        }
      } catch (e) {}

      // Emit deleted event to update UI stats dynamically
      import("./IndexingEventBus")
        .then(({ indexingEvents }) => {
          indexingEvents.emit("deleted", { mode: "single", paperTitle });
        })
        .catch(() => {});
    }
  }

  async deleteByZoteroItemIds(zoteroItemIds: Iterable<string | number>) {
    const normalizedIds = [...new Set([...zoteroItemIds].map(String))];
    for (const zoteroItemId of normalizedIds) {
      await this.deleteByZoteroItemId(zoteroItemId);
    }
  }

  /**
   * Prüft ob für ein Zotero-Item bereits Chunks in Orama gespeichert sind.
   * überspringt bei der Erst-Indexierung bereits vorhandene Items.
   */
  async isItemIndexed(zoteroItemId: string): Promise<boolean> {
    this.checkInit();

    // Debug: Log the number of total documents in DB
    const allDocs = await search(this.db, { term: "", limit: 0 });
    Zotero.debug(
      `[OramaService] isItemIndexed called for ${zoteroItemId}. Total DB size: ${allDocs.count}`,
    );

    const results = await search(this.db, {
      term: "",
      where: { zoteroItemId },
      limit: 1,
    });

    Zotero.debug(
      `[OramaService] isItemIndexed(${zoteroItemId}) -> ${results.hits.length > 0}`,
    );
    return results.hits.length > 0;
  }

  /**
   * Gibt alle indexierten PDFs im Debug-Kanal aus.
   */
  async logIndexedDocuments() {
    this.checkInit();
    const allDocs = await search(this.db, { term: "", limit: 100000 });
    const uniqueIds = new Set<string>();

    for (const hit of allDocs.hits) {
      uniqueIds.add((hit.document as any).zoteroItemId);
    }

    Zotero.debug(
      `[OramaService] ==============================================`,
    );
    Zotero.debug(
      `[OramaService] Vektordatenbank enthält Chunks für ${uniqueIds.size} eindeutige PDFs:`,
    );

    for (const idStr of uniqueIds) {
      try {
        const itemId = parseInt(idStr, 10);
        const item = await Zotero.Items.getAsync(itemId);
        if (item) {
          let title = "Ohne Titel";
          if (item.isRegularItem()) {
            title = item.getField("title") || "Ohne Titel";
          } else if (item.isAttachment()) {
            title = `[Attachment] ${item.getField("title") || item.getFilename()}`;
          }
          Zotero.debug(`[OramaService]  -> "${title}" (ItemID: ${itemId})`);
        } else {
          Zotero.debug(
            `[OramaService]  -> [Unbekannt] ItemID: ${itemId} (Nicht in Zotero gefunden)`,
          );
        }
      } catch (err) {
        Zotero.debug(
          `[OramaService]  -> Fehler beim Laden von ItemID ${idStr}: ${err}`,
        );
      }
    }
    Zotero.debug(
      `[OramaService] ==============================================`,
    );
  }

  /**
   * Gibt eine Zusammenfassung der Datenbank-Statistiken zurück.
   */
  async getDatabaseStats(): Promise<{ chunks: number; papers: number }> {
    this.checkInit();
    const papers = this.textHashes.size;
    const result = await search(this.db, { term: "", limit: 0 });
    return { chunks: result.count, papers };
  }

  /**
   * Gibt die Menge aller Zotero-Item-IDs zurück, die aktuell indexiert sind.
   */
  getIndexedItemIds(): Set<string> {
    return new Set(this.indexedItemIds);
  }

  private checkInit() {
    if (!this.isInitialized)
      throw new Error(
        "OramaService ist nicht initialisiert! Bitte rufe initialize() auf.",
      );
  }

  public getTextHash(zoteroItemId: string): string | undefined {
    return this.textHashes.get(zoteroItemId);
  }

  public setTextHash(zoteroItemId: string, hash: string) {
    this.textHashes.set(zoteroItemId, hash);
    this.scheduleSave();
  }

  public deleteTextHash(zoteroItemId: string) {
    if (this.textHashes.has(zoteroItemId)) {
      this.textHashes.delete(zoteroItemId);
      this.scheduleSave();
    }
  }

  private get dbFilePath() {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      "orama_vector_index_v2.json",
    );
  }

  private get hashFilePath() {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      "orama_text_hashes_v2.json",
    );
  }

  private scheduleSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      Zotero.debug(
        `[OramaService] Speichern verzögert: Timer zurückgesetzt (${this.SAVE_DELAY_MS}ms).`,
      );
    } else {
      Zotero.debug(
        `[OramaService] Änderungen am Index erkannt. Starte Debounce-Timer für Speicherung (${this.SAVE_DELAY_MS}ms)...`,
      );
    }

    this.saveTimeout = setTimeout(async () => {
      this.saveTimeout = null;
      Zotero.debug(
        "[OramaService] Timer abgelaufen: Führe eigentliche Index-Speicherung aus...",
      );
      await this.saveIndex();
    }, this.SAVE_DELAY_MS);
  }

  public async forceSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.saveIndex();
  }

  /**
   * Löscht den gesamten In-Memory-Index und die gespeicherten Dateien auf der Festplatte.
   * Nützlich wenn der Nutzer einen Neuaufbau des Index erzwingen möchte.
   */
  public async clearIndex() {
    this.checkInit();

    // Neues leeres DB-Objekt erstellen
    this.db = (await create({ schema: mySchema })) as VectorDB;
    this.textHashes = new Map<string, string>();
    this.indexedItemIds = new Set<string>();

    // Debounce-Timer abbrechen
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    try {
      await this.saveIndex();
      Zotero.debug("[OramaService] Index auf Festplatte geleert.");
    } catch (e) {
      Zotero.debug(`[OramaService] Fehler beim Leeren der Index-Dateien: ${e}`);
    }

    Zotero.debug("[OramaService] In-Memory-Index geleert.");
  }

  private async saveIndex() {
    try {
      const indexData = await save(this.db);
      const indexString = JSON.stringify(indexData);

      await Zotero.File.putContentsAsync(this.dbFilePath, indexString);

      const hashesObj = Object.fromEntries(this.textHashes);
      await Zotero.File.putContentsAsync(
        this.hashFilePath,
        JSON.stringify(hashesObj),
      );

      Zotero.debug("[OramaService] Index erfolgreich gespeichert.");
    } catch (e) {
      Zotero.debug(`[OramaService] Fehler beim Speichern des Index: ${e}`);
    }
  }

  private async loadIndex() {
    try {
      const contents = await Zotero.File.getContentsAsync(
        this.dbFilePath,
        "utf-8",
      );
      if (typeof contents === "string" && contents.trim().length > 0) {
        const parsedData = JSON.parse(contents);
        await load(this.db, parsedData);
        Zotero.debug(
          "[OramaService] Index erfolgreich von Festplatte geladen.",
        );
      }
    } catch (e) {
      Zotero.debug(
        `[OramaService] Kein existierender Index gefunden oder Fehler beim Laden: ${e}`,
      );
    }

    try {
      const hashContents = await Zotero.File.getContentsAsync(
        this.hashFilePath,
        "utf-8",
      );
      if (typeof hashContents === "string" && hashContents.trim().length > 0) {
        const parsedHashes = JSON.parse(hashContents);
        this.textHashes = new Map(Object.entries(parsedHashes));
        Zotero.debug(
          `[OramaService] Text-Hashes erfolgreich von Festplatte geladen.`,
        );
      }
    } catch (e) {
      Zotero.debug(`[OramaService] Keine existierenden Text-Hashes gefunden.`);
    }

    await this.reconcileIndexedItemIds();
  }

  private async reconcileIndexedItemIds() {
    this.indexedItemIds = new Set<string>();

    try {
      const allDocs = await search(this.db, { term: "", limit: 100000 });
      for (const hit of allDocs.hits) {
        const zoteroItemId = (hit.document as any).zoteroItemId;
        if (zoteroItemId) this.indexedItemIds.add(String(zoteroItemId));
      }
    } catch (error) {
      Zotero.debug(
        `[OramaService] Index-IDs konnten nicht aus Orama rekonstruiert werden: ${error}`,
      );
    }

    for (const zoteroItemId of [...this.textHashes.keys()]) {
      if (!this.indexedItemIds.has(zoteroItemId)) {
        this.textHashes.delete(zoteroItemId);
      }
    }
  }
}

export const vectorStore = new OramaService();
