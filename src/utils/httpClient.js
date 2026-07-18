// Gemeinsamer HTTP-Transport für lokale und cloudbasierte KI-Provider.

/**
 * Transportmodus für automatische, lokale oder cloudbasierte Anfragen.
 *
 * @typedef {"auto" | "local" | "cloud"} TransportMode
 */

/**
 * Gemeinsame Optionen für normale und gestreamte HTTP-Anfragen.
 *
 * @typedef {Object} RequestOptions
 * @property {Record<string, string>} [headers] Zusätzliche HTTP-Header.
 * @property {unknown} [body] Zu serialisierender Anfrageinhalt.
 * @property {number} [timeout] Timeout in Millisekunden.
 * @property {AbortSignal} [signal] Optionales Signal zum Abbrechen.
 * @property {TransportMode} [mode] Auswahl des Transportwegs.
 */

/**
 * Einheitliche Antwortschnittstelle für Fetch und Zotero.HTTP.
 *
 * @typedef {Object} HttpResponse
 * @property {number} status HTTP-Statuscode.
 * @property {boolean} ok Ob der Statuscode zwischen 200 und 299 liegt.
 * @property {Record<string, string>} headers Normalisierte Antwort-Header.
 * @property {() => Promise<unknown>} json Liest die Antwort als JSON.
 * @property {() => Promise<string>} text Liest die Antwort als Text.
 * @property {() => AsyncGenerator<string>} [streamText] Optionaler Textstream.
 */

/** Prüft, ob eine URL zu einem lokalen Dienst wie Ollama gehört. */
function isLocalUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

/** Wandelt die rohe Zotero-Headerdarstellung in ein normalisiertes Objekt um. */
function parseHeaders(rawHeaders) {
  const headers = {};

  for (const line of rawHeaders.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;

    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name) headers[name] = value;
  }

  return headers;
}

/** Erstellt die gemeinsame gepufferte Antwortschnittstelle. */
function createResponse(status, headers, bodyText) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    json: async () => {
      if (!bodyText) return null;

      try {
        return JSON.parse(bodyText);
      } catch (cause) {
        throw new HttpParseError(status, bodyText, cause);
      }
    },
    text: async () => bodyText,
  };
}

/**
 * Sendet eine gepufferte Anfrage über Fetch und vereinheitlicht Transportfehler.
 */
async function sendWithFetch(method, url, options) {
  try {
    const { response, bodyText } = await fetchTextWithTimeout(
      method,
      url,
      options,
    );
    const headers = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });

    return createResponse(response.status, headers, bodyText);
  } catch (cause) {
    if (options.signal?.aborted && cause?.name === "AbortError") {
      throw cause;
    }
    if (cause instanceof HttpTimeoutError || cause?.name === "AbortError") {
      throw new HttpTimeoutError(url, options.timeout);
    }
    throw new HttpNetworkError(url, cause);
  }
}

/**
 * Liest eine Fetch-Antwort vollständig ein und verbindet Benutzerabbruch mit
 * einem eigenen Timeout-Controller.
 */
async function fetchTextWithTimeout(method, url, options) {
  const controller = createAbortController();
  const userSignal = options.signal;
  const fetchSignal = controller?.signal ?? userSignal;
  let timedOut = false;
  let timer;

  const onUserAbort = () => {
    if (controller) controller.abort();
  };

  if (userSignal) {
    if (userSignal.aborted) throw new DOMException("Aborted", "AbortError");
    userSignal.addEventListener("abort", onUserAbort);
  }

  try {
    if (controller) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeout);

      const response = await fetch(url, {
        method,
        headers: options.headers,
        body: options.body,
        signal: fetchSignal,
      });
      return { response, bodyText: await response.text() };
    }

    return await raceWithTimeout(
      (async () => {
        const response = await fetch(url, {
          method,
          headers: options.headers,
          body: options.body,
          ...(fetchSignal ? { signal: fetchSignal } : {}),
        });
        return { response, bodyText: await response.text() };
      })(),
      url,
      options.timeout,
    );
  } catch (cause) {
    if (userSignal?.aborted) throw cause;
    if (timedOut || cause instanceof HttpTimeoutError) {
      throw new HttpTimeoutError(url, options.timeout);
    }
    throw cause;
  } finally {
    if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
    if (timer) clearTimeout(timer);
  }
}

/**
 * Öffnet eine Fetch-Anfrage mit lesbarem Textstream. Der Timeout wird nach jedem
 * empfangenen Chunk neu gestartet und misst dadurch echte Inaktivität.
 */
async function sendStreamWithFetch(method, url, options) {
  if (typeof fetch !== "function") {
    throw new HttpStreamingUnsupportedError(url, "fetch is not available");
  }
  if (typeof TextDecoder !== "function") {
    throw new HttpStreamingUnsupportedError(
      url,
      "TextDecoder is not available",
    );
  }

  const controller = createAbortController();
  const userSignal = options.signal;
  const fetchSignal = controller?.signal ?? userSignal;
  let timedOut = false;
  let timer;
  let reader;

  const resetInactivityTimer = () => {
    if (timer) clearTimeout(timer);
    if (!controller || options.timeout <= 0) return;

    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeout);
  };

  const onUserAbort = () => {
    if (controller) controller.abort();
    reader?.cancel?.().catch?.(() => {});
  };

  if (userSignal) {
    if (userSignal.aborted) throw new DOMException("Aborted", "AbortError");
    userSignal.addEventListener("abort", onUserAbort);
  }

  try {
    const request = fetch(url, {
      method,
      headers: options.headers,
      body: options.body,
      ...(fetchSignal ? { signal: fetchSignal } : {}),
    });
    if (controller) {
      resetInactivityTimer();
    }

    const response = controller
      ? await request
      : await raceWithTimeout(request, url, options.timeout);
    const headers = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    resetInactivityTimer();
    let cachedBodyText;
    // Fehlerantworten können weiterhin einmal vollständig als Text oder JSON
    // gelesen werden, bevor ein Stream-Reader angelegt wurde.
    const readBodyText = async () => {
      if (cachedBodyText === undefined) {
        cachedBodyText = await response.text();
      }
      if (timer) clearTimeout(timer);
      return cachedBodyText;
    };

    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers,
      json: async () => {
        const text = await readBodyText();
        if (!text) return null;

        try {
          return JSON.parse(text);
        } catch (cause) {
          throw new HttpParseError(response.status, text, cause);
        }
      },
      text: readBodyText,
      streamText: async function* () {
        // TextDecoder bewahrt mehrbyteige UTF-8-Zeichen über Chunk-Grenzen hinweg.
        if (!response.body || typeof response.body.getReader !== "function") {
          if (timer) clearTimeout(timer);
          throw new HttpStreamingUnsupportedError(
            url,
            "ReadableStream is not available",
          );
        }

        reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            if (userSignal?.aborted) {
              throw createAbortError();
            }

            const result = controller
              ? await reader.read()
              : await raceWithTimeout(reader.read(), url, options.timeout);

            if (userSignal?.aborted) {
              throw createAbortError();
            }

            if (result.done) break;
            resetInactivityTimer();

            const text = decoder.decode(result.value, { stream: true });
            if (text) yield text;
          }

          const finalText = decoder.decode();
          if (finalText) yield finalText;
        } catch (cause) {
          if (userSignal?.aborted) {
            throw createAbortError();
          }
          if (timedOut || cause instanceof HttpTimeoutError) {
            throw new HttpTimeoutError(url, options.timeout);
          }
          throw new HttpNetworkError(url, cause);
        } finally {
          if (timer) clearTimeout(timer);
          reader.releaseLock?.();
          reader = undefined;
        }
      },
    };
  } catch (cause) {
    if (timer) clearTimeout(timer);
    if (userSignal?.aborted) {
      throw createAbortError();
    }
    if (cause instanceof HttpTimeoutError || timedOut) {
      throw new HttpTimeoutError(url, options.timeout);
    }
    if (cause?.name === "AbortError") {
      throw new HttpTimeoutError(url, options.timeout);
    }
    if (
      cause instanceof HttpStreamingUnsupportedError ||
      cause instanceof HttpNetworkError
    ) {
      throw cause;
    }
    throw new HttpNetworkError(url, cause);
  } finally {
    if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
  }
}

/**
 * Sendet eine gepufferte Anfrage über Zotero.HTTP. Außerhalb von Zotero wird
 * automatisch auf Fetch zurückgefallen.
 */
async function sendWithZotero(method, url, options) {
  if (
    typeof Zotero === "undefined" ||
    typeof Zotero.HTTP?.request !== "function"
  ) {
    return sendWithFetch(method, url, options);
  }

  try {
    const xhr = await Zotero.HTTP.request(method, url, {
      headers: options.headers,
      body: options.body,
      timeout: options.timeout,
      successCodes: false,
      errorDelayMax: 0,
    });

    return createResponse(
      xhr.status,
      parseHeaders(xhr.getAllResponseHeaders?.() ?? ""),
      xhr.responseText ?? "",
    );
  } catch (cause) {
    if (cause && typeof cause.status === "number") {
      return createResponse(
        cause.status,
        parseHeaders(cause.getAllResponseHeaders?.() ?? ""),
        cause.responseText ?? "",
      );
    }

    if (/timeout/i.test(cause?.message ?? "")) {
      throw new HttpTimeoutError(url, options.timeout);
    }
    throw new HttpNetworkError(url, cause);
  }
}

/** Serialisiert Objektinhalte als JSON und lässt Strings unverändert. */
function serializeBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

/**
 * Sendet eine HTTP-Anfrage über Fetch für lokale URLs und über Zotero.HTTP für
 * Cloud-URLs. Der explizite Transportmodus kann diese automatische Wahl
 * überschreiben.
 *
 * @param {string} method - HTTP-Methode.
 * @param {string} url - Ziel-URL.
 * @param {RequestOptions} [options] - Header, Body, Timeout und Transportmodus.
 * @returns {Promise<HttpResponse>} Vereinheitlichte HTTP-Antwort.
 */
async function request(method, url, options = {}) {
  const timeout = options.timeout ?? 30_000;
  const mode = options.mode ?? "auto";
  const body = serializeBody(options.body);
  const headers = {
    Accept: "application/json",
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };

  const transportOptions = { timeout, body, headers };
  transportOptions.signal = options.signal;
  const useFetch = mode === "local" || (mode === "auto" && isLocalUrl(url));

  return useFetch
    ? sendWithFetch(method, url, transportOptions)
    : sendWithZotero(method, url, transportOptions);
}

/**
 * Sendet eine HTTP-Anfrage und stellt den Antwortinhalt als Textstream bereit.
 * Da Zotero.HTTP Antworten vollständig puffert, verwendet echtes Streaming
 * eine Fetch-Implementierung mit ReadableStream-Unterstützung.
 *
 * @param {string} method - HTTP-Methode.
 * @param {string} url - Ziel-URL.
 * @param {RequestOptions} [options] - Header, Body, Timeout und Abbruchsignal.
 * @returns {Promise<HttpResponse>} HTTP-Antwort mit optionalem Textstream.
 */
async function streamRequest(method, url, options = {}) {
  const timeout = options.timeout ?? 30_000;
  const body = serializeBody(options.body);
  const headers = {
    Accept: "text/event-stream",
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };

  return sendStreamWithFetch(method, url, {
    timeout,
    body,
    headers,
    signal: options.signal,
  });
}

/** Erstellt einen AbortController, sofern die Laufzeit ihn unterstützt. */
function createAbortController() {
  if (typeof AbortController !== "function") return null;
  return new AbortController();
}

/** Erstellt einen plattformübergreifend erkennbaren AbortError. */
function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Aborted", "AbortError");
  }

  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/** Begrenzt ein Promise in Laufzeiten ohne AbortController zeitlich. */
function raceWithTimeout(promise, url, timeout) {
  return new Promise((resolve, reject) => {
    if (timeout <= 0) {
      reject(new HttpTimeoutError(url, timeout));
      return;
    }

    const timer = setTimeout(() => {
      reject(new HttpTimeoutError(url, timeout));
    }, timeout);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Gemeinsame Basisklasse aller Transport- und Antwortfehler. */
export class HttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "HttpError";
    this.url = options.url;
    this.status = options.status;
    this.cause = options.cause;
  }
}

/** Fehler für eine Anfrage oder Stream-Inaktivität nach Ablauf des Timeouts. */
export class HttpTimeoutError extends HttpError {
  constructor(url, timeoutMs) {
    super(`HTTP request timed out after ${timeoutMs} ms: ${url}`, { url });
    this.name = "HttpTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Fehler für Netzwerk- oder Laufzeitprobleme ohne gültige HTTP-Antwort. */
export class HttpNetworkError extends HttpError {
  constructor(url, cause) {
    super(`HTTP network error for ${url}: ${cause?.message ?? cause}`, {
      url,
      cause,
    });
    this.name = "HttpNetworkError";
  }
}

/** Fehler, wenn die Laufzeit keinen lesbaren Fetch-Stream bereitstellt. */
export class HttpStreamingUnsupportedError extends HttpError {
  constructor(url, reason) {
    super(`HTTP streaming is not supported for ${url}: ${reason}`, { url });
    this.name = "HttpStreamingUnsupportedError";
    this.reason = reason;
  }
}

/** Fehler beim Parsen einer erwarteten JSON-Antwort. */
export class HttpParseError extends HttpError {
  constructor(status, bodyText, cause) {
    super(`Could not parse HTTP ${status} response as JSON`, {
      status,
      cause,
    });
    this.name = "HttpParseError";
    this.bodyPreview = bodyText.slice(0, 300);
  }
}

/** Fehler für eine vorhandene HTTP-Antwort mit nicht erfolgreichem Status. */
export class HttpResponseError extends HttpError {
  constructor(url, response, message, details) {
    super(message || `HTTP ${response.status} for ${url}`, {
      url,
      status: response.status,
    });
    this.name = "HttpResponseError";
    this.response = response;
    this.details = details;
  }
}

/**
 * Prüft den HTTP-Status und bewahrt eine von der API gelieferte JSON- oder
 * Textfehlermeldung im resultierenden Fehlerobjekt auf.
 *
 * @param {string} url - Angefragte URL.
 * @param {HttpResponse} response - Zu prüfende Antwort.
 * @returns {Promise<HttpResponse>} Unveränderte erfolgreiche Antwort.
 */
export async function assertHttpOk(url, response) {
  if (response.ok) return response;

  let details;
  try {
    details = await response.json();
  } catch {
    details = await response.text();
  }

  const apiMessage =
    details?.error?.message ||
    details?.message ||
    (typeof details === "string" ? details.slice(0, 300) : "");

  throw new HttpResponseError(
    url,
    response,
    apiMessage
      ? `HTTP ${response.status} for ${url}: ${apiMessage}`
      : undefined,
    details,
  );
}

/**
 * Öffentliche Komfortschnittstelle für normale und gestreamte HTTP-Methoden.
 */
export const httpClient = {
  request,
  streamRequest,

  get(url, options = {}) {
    return request("GET", url, options);
  },

  post(url, body, options = {}) {
    return request("POST", url, { ...options, body });
  },

  streamPost(url, body, options = {}) {
    return streamRequest("POST", url, { ...options, body });
  },

  put(url, body, options = {}) {
    return request("PUT", url, { ...options, body });
  },

  delete(url, options = {}) {
    return request("DELETE", url, options);
  },

  async ping(url, timeout = 3_000, options = {}) {
    try {
      const response = await request("GET", url, { ...options, timeout });
      return response.ok;
    } catch {
      return false;
    }
  },
};
