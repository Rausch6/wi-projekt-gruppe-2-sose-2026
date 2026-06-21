import { create, insertMultiple, search, removeMultiple, Orama } from '@orama/orama';
import { persist, restore } from '@orama/plugin-data-persistence';

declare const Zotero: any;
declare const IOUtils: any;  
declare const OS: any;     

const VECTOR_SIZE = 4096; 

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
     * Führt eine Vektorsuche in Orama durch.
     */
    async searchSimilar(queryVector: number[], limit: number = 5, whereFilter?: any, term?: string) {
        this.checkInit();

        const searchParams: any = {
            mode: term ? 'hybrid' : 'vector',
            vector: {
                value: queryVector,
                property: 'embedding',
            },
            limit: limit,
        };

        if (term) {
            searchParams.term = term;
        }

        if (whereFilter) {
            searchParams.where = whereFilter;
        }

        const results = await search(this.db, searchParams);

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
        const results = await search(this.db, {
            term: '',
            where: { zoteroItemId },
            limit: 1,
        });
        return results.hits.length > 0;
    }

    private checkInit() {
        if (!this.isInitialized) throw new Error("OramaService ist nicht initialisiert! Bitte rufe initialize() auf.");
    }

    private get dbFilePath() {
        return Zotero.getZoteroDirectory().path + '/orama_vector_index.json';
    }

    private async saveIndex() {
        try {
            const indexData = await persist(this.db, 'json');
            
            if (typeof IOUtils !== 'undefined') {
                await IOUtils.writeUTF8(this.dbFilePath, indexData as string, { tmpPath: this.dbFilePath + '.tmp' });
            } else if (typeof OS !== 'undefined' && OS.File) {
                const encoder = new TextEncoder();
                const array = encoder.encode(indexData as string);
                await OS.File.writeAtomic(this.dbFilePath, array, { tmpPath: this.dbFilePath + '.tmp' });
            } else {
                Zotero.debug("[OramaService] Konnte Index nicht speichern: Keine File API gefunden.");
            }
        } catch (e) {
            Zotero.debug(`[OramaService] Fehler beim Speichern des Index: ${e}`);
        }
    }

    private async loadIndex() {
        try {
            let indexData: string | null = null;

            if (typeof IOUtils !== 'undefined') {
                const exists = await IOUtils.exists(this.dbFilePath);
                if (exists) {
                    indexData = await IOUtils.readUTF8(this.dbFilePath);
                }
            } else if (typeof OS !== 'undefined' && OS.File) {
                const exists = await OS.File.exists(this.dbFilePath);
                if (exists) {
                    const array = await OS.File.read(this.dbFilePath);
                    const decoder = new TextDecoder();
                    indexData = decoder.decode(array);
                }
            }

            if (indexData) {
                this.db = await restore('json', indexData);
                Zotero.debug("[OramaService] Index erfolgreich von Festplatte geladen.");
            }
        } catch (e) {
            Zotero.debug(`[OramaService] Kein existierender Index gefunden oder Fehler beim Laden: ${e}`);
        }
    }
}

export const vectorStore = new OramaService();
