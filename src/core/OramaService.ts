import { create, insertMultiple, search, removeMultiple, Orama, save, load } from '@orama/orama';

declare const Zotero: any;
declare const IOUtils: any;  
declare const OS: any;     

const VECTOR_SIZE = 1024; 

const mySchema = {
    id: 'string',
    zoteroItemId: 'string',
    content: 'string',
    pageNumber: 'number',
    embedding: `vector[${VECTOR_SIZE}]`, 
} as const;

export type ChunkDocument = {
    id: string;
    zoteroItemId: string;
    content: string;
    pageNumber: number;
    embedding: number[]; 
};

type VectorDB = Orama<typeof mySchema>;

export class OramaService {
    private db!: VectorDB;
    private isInitialized = false;

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

        await this.saveIndex();
    }

    /**
     * Führt eine kombinierte Vektor- und/oder Keyword-Suche in Orama durch.
     */
    async searchSimilar(queryVector: number[] | null, limit: number = 5, whereFilter?: any, term?: string) {
        this.checkInit();

        let mode = 'vector';
        if (queryVector && term) mode = 'hybrid';
        else if (!queryVector && term) mode = 'fulltext';

        const searchParams: any = {
            mode: mode,
            limit: limit,
        };

        if (queryVector) {
            searchParams.vector = {
                value: queryVector,
                property: 'embedding',
            };
            searchParams.similarity = 0.1; // Ensure we get the closest hits even if absolute similarity is low
        }

        if (term) {
            searchParams.term = term;
            searchParams.properties = ['content'];
        }

        if (whereFilter) {
            searchParams.where = whereFilter;
        }

        const results = await search(this.db, searchParams);

        Zotero.debug(`[OramaService] Suche ausgeführt (Mode: ${searchParams.mode}, Filter: ${whereFilter ? JSON.stringify(whereFilter) : 'keine'}, Term: ${term || 'keiner'}). Treffer: ${results.hits.length}`);

        return results.hits;
    }

    /**
     * Löscht alle Chunks, die zu einer bestimmten Zotero-ID gehören.
     * Wichtig, wenn der Nutzer ein PDF aus Zotero löscht.
     */
    async deleteByZoteroItemId(zoteroItemId: string) {
        this.checkInit();

        const results = await search(this.db, {
            term: '',
            where: {
                zoteroItemId: zoteroItemId
            },
            limit: 10000,
        });

        if (results.hits.length > 0) {
            const idsToRemove = results.hits.map(hit => hit.id);
            await removeMultiple(this.db, idsToRemove);
            
            await this.saveIndex();
            Zotero.debug(`[OramaService]: Deleted ${idsToRemove.length} chunks for item ${zoteroItemId}`);
        }
    }

    /**
     * Prüft ob für ein Zotero-Item bereits Chunks in Orama gespeichert sind.
     * überspringt bei der Erst-Indexierung bereits vorhandene Items.
     */
    async isItemIndexed(zoteroItemId: string): Promise<boolean> {
        this.checkInit();
        
        // Debug: Log the number of total documents in DB
        const allDocs = await search(this.db, { term: '', limit: 0 });
        Zotero.debug(`[OramaService] isItemIndexed called for ${zoteroItemId}. Total DB size: ${allDocs.count}`);
        
        const results = await search(this.db, {
            term: '',
            where: { zoteroItemId },
            limit: 1,
        });
        
        Zotero.debug(`[OramaService] isItemIndexed(${zoteroItemId}) -> ${results.hits.length > 0}`);
        return results.hits.length > 0;
    }

    /**
     * Gibt alle indexierten PDFs im Debug-Kanal aus.
     */
    async logIndexedDocuments() {
        this.checkInit();
        const allDocs = await search(this.db, { term: '', limit: 100000 });
        const uniqueIds = new Set<string>();
        
        for (const hit of allDocs.hits) {
            uniqueIds.add((hit.document as any).zoteroItemId);
        }

        Zotero.debug(`[OramaService] ==============================================`);
        Zotero.debug(`[OramaService] Vektordatenbank enthält Chunks für ${uniqueIds.size} eindeutige PDFs:`);
        
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
                    Zotero.debug(`[OramaService]  -> [Unbekannt] ItemID: ${itemId} (Nicht in Zotero gefunden)`);
                }
            } catch (err) {
                Zotero.debug(`[OramaService]  -> Fehler beim Laden von ItemID ${idStr}: ${err}`);
            }
        }
        Zotero.debug(`[OramaService] ==============================================`);
    }

    private checkInit() {
        if (!this.isInitialized) throw new Error("OramaService ist nicht initialisiert! Bitte rufe initialize() auf.");
    }

    private get dbFilePath() {
        return Zotero.getZoteroDirectory().path + '/orama_vector_index.json';
    }

    private async saveIndex() {
        try {
            const indexData = await save(this.db);
            const indexString = JSON.stringify(indexData);
            
            await Zotero.File.putContentsAsync(this.dbFilePath, indexString);
            Zotero.debug("[OramaService] Index erfolgreich gespeichert.");
        } catch (e) {
            Zotero.debug(`[OramaService] Fehler beim Speichern des Index: ${e}`);
        }
    }

    private async loadIndex() {
        try {
            const contents = await Zotero.File.getContentsAsync(this.dbFilePath, "utf-8");
            if (typeof contents === "string" && contents.trim().length > 0) {
                const parsedData = JSON.parse(contents);
                await load(this.db, parsedData);
                Zotero.debug("[OramaService] Index erfolgreich von Festplatte geladen.");
            }
        } catch (e) {
            Zotero.debug(`[OramaService] Kein existierender Index gefunden oder Fehler beim Laden: ${e}`);
        }
    }
}

export const vectorStore = new OramaService();
