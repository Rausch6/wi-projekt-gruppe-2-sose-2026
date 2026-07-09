/**
 * Polyfill for AbortController.
 * Zotero's background environment might not provide a global AbortController.
 */

class PolyfillAbortSignal {
  public aborted = false;
  public reason: any = undefined;
  public onabort: ((this: AbortSignal, ev: Event) => any) | null = null;
  private listeners: Function[] = [];

  public throwIfAborted(): void {
    if (this.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  }

  public addEventListener(type: string, listener: Function): void {
    if (type === "abort") {
      this.listeners.push(listener);
    }
  }

  public removeEventListener(type: string, listener: Function): void {
    if (type === "abort") {
      this.listeners = this.listeners.filter((l) => l !== listener);
    }
  }

  public dispatchEvent(event: Event): boolean {
    return true;
  }

  public _trigger(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        // ignore errors in listeners
      }
    }
  }
}

class PolyfillAbortController {
  public readonly signal = new PolyfillAbortSignal();

  public abort(reason?: any): void {
    this.signal.reason = reason;
    this.signal._trigger();
  }
}

export function createAbortController(): AbortController {
  if (typeof globalThis.AbortController === "function") {
    return new globalThis.AbortController();
  }
  return new PolyfillAbortController() as unknown as AbortController;
}
