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

export const VECTOR_SIZE = 1024;

const mySchema = {
  id: "string",
  zoteroItemId: "string",
  sourceType: "string",
  content: "string",
  pageNumber: "number",
  embedding: `vector[${VECTOR_SIZE}]`,
} as const;

/**
 * Typ der indizierten Quellen in der Vektordatenbank.
 */
export type IndexedSourceType = "abstract" | "fulltext";

/**
 * Indexierungseintrag für ein Zotero-Item mit Hash und Verarbeitungsstatus.
 */
export interface IndexRecord {
  hash: string;
  status: "INDEXING" | "DONE";
}

/**
 * Einzelner Chunk-Datensatz in der Vektordatenbank.
 */
export type ChunkDocument = {
  id: string;
  zoteroItemId: string;
  sourceType: IndexedSourceType;
  content: string;
  pageNumber: number;
  embedding: number[];
};

type VectorDB = Orama<typeof mySchema>;

/**
 * Kapselt alle Datenbankoperationen der Orama-Vektordatenbank.
 * Verwaltet das Speichern und Laden des Index sowie die Index-Records
 * mit Hashwerten zur Änderungserkennung.
 */
export class OramaService {
  private db!: VectorDB;
  private isInitialized = false;
  private saveTimeout: any = null;
  private readonly SAVE_DELAY_MS = 2000;
  private indexRecords = new Map<string, IndexRecord>();
  private saveSuspended = false;
  private savePendingWhileSuspended = false;

  /**
   * Startet die Orama-Datenbank und lädt ggf. einen gespeicherten Index von der Festplatte.
   */
  async initialize() {
    if (this.isInitialized) return;

    this.db = (await create({
      schema: mySchema,
    })) as VectorDB;

    this.isInitialized = true;
    await this.loadIndex();

    Zotero.debug("[OramaService]: Datenbank initialisiert.");
  }

  /**
   * Fügt eine Liste von Text-Chunks inklusive Embeddings in Orama ein.
   *
   * @param chunks - Die einzufügenden Chunk-Dokumente.
   */
  async addChunks(chunks: ChunkDocument[]) {
    this.checkInit();

    await insertMultiple(this.db, chunks as any);

    this.scheduleSave();
  }

  /**
   * Führt eine kombinierte Vektor- und/oder Keyword-Suche in Orama durch.
   *
   * @param queryVector - Embedding-Vektor der Suchanfrage oder null für reine Keyword-Suche.
   * @param limit - Maximale Anzahl zurückgegebener Treffer.
   * @param whereFilter - Optionaler Orama-Filter (z. B. nach Zotero-Item-ID).
   * @param term - Optionaler Keyword-Suchbegriff für Fulltext- oder Hybrid-Suche.
   * @returns Liste der Suchtreffer.
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
      searchParams.similarity = 0.1;
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
   * Löscht alle Chunks, die zu einer bestimmten Zotero-Item-ID gehören.
   * Wird aufgerufen, wenn der Nutzer ein PDF aus Zotero entfernt.
   *
   * @param zoteroItemId - Die Zotero-Item-ID als String.
   */
  async deleteByZoteroItemId(zoteroItemId: string) {
    this.checkInit();
    this.deleteIndexRecord(zoteroItemId);

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
        `[OramaService]: ${idsToRemove.length} Chunks für Item ${zoteroItemId} gelöscht.`,
      );

      let paperTitle;
      try {
        const item = await Zotero.Items.getAsync(parseInt(zoteroItemId, 10));
        if (item && item._loaded !== false) {
          paperTitle =
            item.getField("title") ||
            (item.isAttachment() ? (item as any).getFilename() : undefined);
        }
      } catch (e) {}

      import("./IndexingEventBus")
        .then(({ indexingEvents }) => {
          indexingEvents.emit("deleted", { mode: "single", paperTitle });
        })
        .catch(() => {});
    }
  }

  /**
   * Löscht alle Chunks für eine Menge von Zotero-Item-IDs.
   *
   * @param zoteroItemIds - Menge von Zotero-Item-IDs (als Strings oder Zahlen).
   */
  async deleteByZoteroItemIds(zoteroItemIds: Iterable<string | number>) {
    const normalizedIds = [...new Set([...zoteroItemIds].map(String))];
    for (const zoteroItemId of normalizedIds) {
      await this.deleteByZoteroItemId(zoteroItemId);
    }
  }

  /**
   * Schnelle Prüfung, ob ein Index-Record für eine Zotero-Item-ID existiert (ohne DB-Suche).
   *
   * @param zoteroItemId - Die zu prüfende Zotero-Item-ID.
   * @returns True, wenn ein Record vorhanden ist.
   */
  public hasIndexRecord(zoteroItemId: string): boolean {
    return this.indexRecords.has(zoteroItemId);
  }

  /**
   * Prüft, ob ein Item vollständig indexiert ist (Status DONE).
   * Nutzt die In-Memory-Index-Records für eine schnelle Prüfung ohne DB-Zugriff.
   *
   * @param zoteroItemId - Die zu prüfende Zotero-Item-ID.
   * @returns True, wenn das Item mit Status DONE indexiert ist.
   */
  async isItemIndexed(zoteroItemId: string): Promise<boolean> {
    this.checkInit();
    const record = this.indexRecords.get(zoteroItemId);
    return record?.status === "DONE";
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
      `[OramaService] Vektordatenbank enthält Chunks für ${uniqueIds.size} eindeutige PDFs.`,
    );
    Zotero.debug(
      `[OramaService] ==============================================`,
    );
  }

  /**
   * Gibt eine Zusammenfassung der Datenbank-Statistiken zurück.
   *
   * @returns Gesamtanzahl der Chunks und der vollständig indizierten Paper.
   */
  async getDatabaseStats(): Promise<{ chunks: number; papers: number }> {
    this.checkInit();
    let papers = 0;
    for (const record of this.indexRecords.values()) {
      if (record.status === "DONE") papers++;
    }
    const result = await search(this.db, { term: "", limit: 0 });
    return { chunks: result.count, papers };
  }

  /**
   * Gibt die Menge aller Zotero-Item-IDs zurück, die aktuell vollständig indexiert sind.
   *
   * @returns Set mit den indexierten Zotero-Item-IDs.
   */
  getIndexedItemIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, record] of this.indexRecords.entries()) {
      if (record.status === "DONE") {
        ids.add(id);
      }
    }
    return ids;
  }

  /**
   * Wirft einen Fehler, wenn die Datenbank noch nicht initialisiert wurde.
   */
  private checkInit() {
    if (!this.isInitialized)
      throw new Error(
        "OramaService ist nicht initialisiert! Bitte rufe initialize() auf.",
      );
  }

  /**
   * Gibt den gespeicherten Texthash eines indizierten Items zurück.
   *
   * @param zoteroItemId - Die Zotero-Item-ID.
   * @returns Der gespeicherte Hash oder undefined, wenn kein Record vorhanden ist.
   */
  public getTextHash(zoteroItemId: string): string | undefined {
    return this.indexRecords.get(zoteroItemId)?.hash;
  }

  /**
   * Markiert ein Item als "wird gerade indexiert" mit dem aktuellen Texthash.
   *
   * @param zoteroItemId - Die Zotero-Item-ID.
   * @param hash - Texthash des zu indexierenden Inhalts.
   */
  public markAsIndexing(zoteroItemId: string, hash: string) {
    this.indexRecords.set(zoteroItemId, { hash, status: "INDEXING" });
    this.scheduleSave();
  }

  /**
   * Markiert ein Item als vollständig indexiert (Status DONE).
   *
   * @param zoteroItemId - Die Zotero-Item-ID.
   */
  public markAsIndexed(zoteroItemId: string) {
    const record = this.indexRecords.get(zoteroItemId);
    if (record) {
      record.status = "DONE";
      this.scheduleSave();
    }
  }

  /**
   * Entfernt den Index-Record eines Items.
   *
   * @param zoteroItemId - Die Zotero-Item-ID.
   */
  public deleteIndexRecord(zoteroItemId: string) {
    if (this.indexRecords.has(zoteroItemId)) {
      this.indexRecords.delete(zoteroItemId);
      this.scheduleSave();
    }
  }

  /**
   * Absoluter Pfad zur Vektordatenbank-Datei auf der Festplatte.
   */
  private get dbFilePath() {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      "orama_vector_index_v2.json",
    );
  }

  /**
   * Absoluter Pfad zur Hash-Datei auf der Festplatte.
   */
  private get hashFilePath() {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      "orama_text_hashes_v2.json",
    );
  }

  /**
   * Unterdrückt automatisches Speichern. Aufrufe von scheduleSave()
   * werden als "ausstehend" vermerkt, aber nicht ausgeführt.
   */
  public suspendSave() {
    this.saveSuspended = true;
    this.savePendingWhileSuspended = false;
  }

  /**
   * Hebt die Speicher-Unterdrückung auf. Falls während der Unterdrückung
   * mindestens ein scheduleSave() aufgerufen wurde, wird jetzt einmalig gespeichert.
   */
  public async resumeSave() {
    this.saveSuspended = false;
    if (this.savePendingWhileSuspended) {
      this.savePendingWhileSuspended = false;
      this.scheduleSave();
    }
  }

  /**
   * Plant das Speichern des Index mit Debounce-Verzögerung.
   * Bei suspendiertem Speichern wird der Aufruf nur vermerkt.
   */
  private scheduleSave() {
    if (this.saveSuspended) {
      this.savePendingWhileSuspended = true;
      return;
    }

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

  /**
   * Erzwingt sofortiges Speichern des Index (bricht laufenden Debounce-Timer ab).
   */
  public async forceSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.saveIndex();
  }

  /**
   * Löscht den gesamten In-Memory-Index und die gespeicherten Dateien auf der Festplatte.
   * Nützlich, wenn der Nutzer einen Neuaufbau des Index erzwingen möchte.
   */
  public async clearIndex() {
    this.checkInit();

    this.db = (await create({ schema: mySchema })) as VectorDB;
    this.indexRecords = new Map<string, IndexRecord>();

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

  /**
   * Schreibt den aktuellen Index und die Index-Records auf die Festplatte.
   */
  private async saveIndex() {
    try {
      const indexData = await save(this.db);
      const indexString = JSON.stringify(indexData);

      await Zotero.File.putContentsAsync(this.dbFilePath, indexString);

      const recordsObj = Object.fromEntries(this.indexRecords);
      await Zotero.File.putContentsAsync(
        this.hashFilePath,
        JSON.stringify(recordsObj),
      );

      Zotero.debug("[OramaService] Index erfolgreich gespeichert.");
    } catch (e) {
      Zotero.logError(e instanceof Error ? e : new Error(String(e)));
      Zotero.debug(`[OramaService] Fehler beim Speichern des Index: ${e}`);
    }
  }

  /**
   * Lädt den gespeicherten Index und die Index-Records von der Festplatte.
   * Migriert dabei ggf. veraltete Hash-Strings in das aktuelle IndexRecord-Format.
   */
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
        this.indexRecords = new Map();
        for (const [key, value] of Object.entries(parsedHashes)) {
          if (typeof value === "string") {
            this.indexRecords.set(key, { hash: value, status: "DONE" });
          } else if (value && typeof value === "object") {
            this.indexRecords.set(key, value as IndexRecord);
          }
        }
        Zotero.debug(
          `[OramaService] Index-Records erfolgreich von Festplatte geladen.`,
        );
      }
    } catch (e) {
      Zotero.debug(`[OramaService] Keine existierenden Index-Records gefunden.`);
    }

    await this.reconcileIndexedItemIds();
  }

  /**
   * Bereinigt Items, bei denen die Indexierung abgestürzt ist (Status INDEXING).
   * Entfernt unvollständige Einträge aus dem Index.
   */
  private async reconcileIndexedItemIds() {
    const crashedItemIds: string[] = [];

    for (const [id, record] of this.indexRecords.entries()) {
      if (record.status === "INDEXING") {
        crashedItemIds.push(id);
      }
    }

    if (crashedItemIds.length > 0) {
      Zotero.debug(
        `[OramaService] Geister-Dokumente erkannt: ${crashedItemIds.length} Items wurden nicht vollständig indexiert (Absturz). Bereinigung...`,
      );
      await this.deleteByZoteroItemIds(crashedItemIds);
      Zotero.debug(
        `[OramaService] Bereinigung von Geister-Dokumenten abgeschlossen.`,
      );
    }
  }
}

export const vectorStore = new OramaService();
