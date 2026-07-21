/**
 * Provides an AbortSignal-compatible fallback for Zotero environments without AbortController.
 */
class PolyfillAbortSignal {
  public aborted = false;
  public reason: any = undefined;
  public onabort: ((this: AbortSignal, ev: Event) => any) | null = null;
  private listeners: Function[] = [];

  /**
   * Throws an AbortError when the signal has already been aborted.
   *
   * @returns Nothing.
   */
  public throwIfAborted(): void {
    if (this.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  }

  /**
   * Registers an abort event listener.
   *
   * @param type - Event type to listen for.
   * @param listener - Listener invoked when the abort event is triggered.
   * @returns Nothing.
   */
  public addEventListener(type: string, listener: Function): void {
    if (type === "abort") {
      this.listeners.push(listener);
    }
  }

  /**
   * Removes a previously registered abort event listener.
   *
   * @param type - Event type to remove.
   * @param listener - Listener to remove.
   * @returns Nothing.
   */
  public removeEventListener(type: string, listener: Function): void {
    if (type === "abort") {
      this.listeners = this.listeners.filter((l) => l !== listener);
    }
  }

  /**
   * Implements the EventTarget dispatch signature for AbortSignal compatibility.
   *
   * @param event - Event to dispatch.
   * @returns True to indicate that dispatch completed.
   */
  public dispatchEvent(event: Event): boolean {
    void event;
    return true;
  }

  /**
   * Marks the signal as aborted and notifies registered listeners.
   *
   * @returns Nothing.
   */
  public _trigger(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }
}

/**
 * Provides an AbortController-compatible fallback implementation.
 */
class PolyfillAbortController {
  public readonly signal = new PolyfillAbortSignal();

  /**
   * Aborts the controller and forwards the abort reason to the signal.
   *
   * @param reason - Optional reason associated with the abort.
   * @returns Nothing.
   */
  public abort(reason?: any): void {
    this.signal.reason = reason;
    this.signal._trigger();
  }
}

/**
 * Creates an AbortController using the native global implementation when available.
 *
 * @returns Native or polyfilled AbortController instance.
 */
export function createAbortController(): AbortController {
  if (typeof globalThis.AbortController === "function") {
    return new globalThis.AbortController();
  }
  return new PolyfillAbortController() as unknown as AbortController;
}

/**
 * Creates an AbortController from the given window's own global.
 *
 * @param win - Window whose AbortController constructor should be used.
 * @returns AbortController instance compatible with the given window.
 */
export function createWindowAbortController(win: Window): AbortController {
  const AbortControllerCtor = (
    win as Window & { AbortController?: typeof AbortController }
  ).AbortController;

  if (typeof AbortControllerCtor === "function") {
    return new AbortControllerCtor();
  }

  return createAbortController();
}
