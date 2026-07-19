/**
 * Mögliche Modi einer Indexierungsoperation.
 */
export type IndexingMode = "full" | "single";

/**
 * Ereignisdaten für Fortschrittsmeldungen während der Indexierung.
 */
export interface IndexingProgressEvent {
  mode: IndexingMode;
  indexed: number;
  total: number;
  estimatedRemainingMs?: number;
  paperTitle?: string;
}

/**
 * Ereignisdaten für Statusmeldungen rund um die Indexierung (Start, Ende, Fehler).
 */
export interface IndexingStatusEvent {
  mode: IndexingMode;
  indexed?: number;
  total?: number;
  newlyIndexed?: number;
  itemID?: number;
  skipped?: boolean;
  unchanged?: boolean;
  paperTitle?: string;
  /** Anzahl Papers ohne extrahierbaren Text, die bei einem Bibliotheks-Lauf übersprungen wurden. */
  skippedCount?: number;
}

type IndexingEventMap = {
  started: IndexingStatusEvent;
  progress: IndexingProgressEvent;
  singleStarted: IndexingStatusEvent;
  singleDone: IndexingStatusEvent;
  deleted: IndexingStatusEvent;
  error: { message: string; itemID?: number; paperTitle?: string };
  finished: IndexingStatusEvent;
  aborted: IndexingStatusEvent;
};

type Listener<T> = (event: T) => void;

/**
 * Zentraler Event-Bus für Indexierungsstatus.
 * Entkoppelt die UI vom BackgroundIndexer, indem Indexierungsereignisse
 * über typisierte Callbacks kommuniziert werden.
 */
class IndexingEventBus {
  private listeners = new Map<string, Set<Listener<any>>>();

  /**
   * Registriert einen Listener für ein bestimmtes Indexierungsereignis.
   *
   * @param event - Name des Ereignisses.
   * @param listener - Callback-Funktion, die beim Eintreten des Ereignisses aufgerufen wird.
   * @returns Eine Funktion, die den Listener wieder entfernt.
   */
  on<K extends keyof IndexingEventMap>(
    event: K,
    listener: Listener<IndexingEventMap[K]>,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.off(event, listener);
  }

  /**
   * Entfernt einen zuvor registrierten Listener.
   *
   * @param event - Name des Ereignisses.
   * @param listener - Der zu entfernende Callback.
   */
  off<K extends keyof IndexingEventMap>(
    event: K,
    listener: Listener<IndexingEventMap[K]>,
  ) {
    this.listeners.get(event)?.delete(listener);
  }

  /**
   * Löst ein Ereignis aus und benachrichtigt alle registrierten Listener.
   * Fehler einzelner Listener werden still unterdrückt.
   *
   * @param event - Name des Ereignisses.
   * @param data - Ereignisdaten passend zum Ereignistyp.
   */
  emit<K extends keyof IndexingEventMap>(event: K, data: IndexingEventMap[K]) {
    this.listeners.get(event)?.forEach((listener) => {
      try {
        listener(data);
      } catch (_e) {}
    });
  }
}

export const indexingEvents = new IndexingEventBus();
