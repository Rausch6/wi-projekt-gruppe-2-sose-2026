/**
 * Zentraler Event-Bus für Indizierungsstatus.
 * Erlaubt es der UI auf Indexierungsereignisse zu reagieren,
 * ohne direkte Abhängigkeit zum BackgroundIndexer.
 */

export type IndexingMode = "full" | "single";

export interface IndexingProgressEvent {
  mode: IndexingMode;
  indexed: number;
  total: number;
  estimatedRemainingMs?: number;

  paperTitle?: string;
}

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

class IndexingEventBus {
  private listeners = new Map<string, Set<Listener<any>>>();

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

  off<K extends keyof IndexingEventMap>(
    event: K,
    listener: Listener<IndexingEventMap[K]>,
  ) {
    this.listeners.get(event)?.delete(listener);
  }

  emit<K extends keyof IndexingEventMap>(event: K, data: IndexingEventMap[K]) {
    this.listeners.get(event)?.forEach((listener) => {
      try {
        listener(data);
      } catch (_e) {}
    });
  }
}

export const indexingEvents = new IndexingEventBus();
