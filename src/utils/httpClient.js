// src/utils/httpClient.js
//
// HTTP-Wrapper für die Zotero-Plugin-Sandbox.
//
// WARUM dieser Wrapper existiert:
//   Zotero 7 läuft auf Firefox 115+. Natives fetch() funktioniert für
//   externe URLs grundsätzlich, respektiert aber keine Proxy-Einstellungen
//   des Nutzers. Zotero.HTTP.request() nutzt den Firefox-Netzwerkstack
//   vollständig (inkl. Proxy, Zertifikate, Zotero-eigenes Cookie-Handling).
//
//   Für localhost (Ollama, LM Studio) ist das egal — dort nehmen wir fetch()
//   direkt, weil es einfacher zu debuggen ist und keine Sandbox-Probleme hat.
//   Für Cloud-APIs (DeepSeek) nutzen wir Zotero.HTTP.request().
//
// VERWENDUNG:
//   import { httpClient } from "../utils/httpClient.js";
//
//   const res = await httpClient.get("http://localhost:11434/api/tags");
//   const data = await res.json();
//
//   const res = await httpClient.post("https://api.deepseek.com/v1/chat/completions", {
//     body: { model: "deepseek-chat", messages: [...] },
//     headers: { Authorization: "Bearer sk-..." },
//   });

/**
 * @typedef {Object} RequestOptions
 * @property {Record<string, string>} [headers]   - Zusätzliche HTTP-Header
 * @property {unknown}                [body]       - Request-Body (wird zu JSON serialisiert)
 * @property {number}                 [timeout]    - Timeout in ms (default: 30000)
 * @property {"local"|"cloud"|"auto"} [mode]       - Erzwingt fetch() oder Zotero.HTTP
 */

/**
 * @typedef {Object} HttpResponse
 * @property {number}                    status     - HTTP-Statuscode
 * @property {boolean}                   ok         - true wenn status 200–299
 * @property {Record<string, string>}    headers    - Response-Header
 * @property {() => Promise<unknown>}    json       - Parst Body als JSON
 * @property {() => Promise<string>}     text       - Gibt Body als String zurück
 */

// ─── Interne Hilfsfunktionen ───────────────────────────────────────────────

/**
 * Erkennt ob eine URL lokal ist (kein API-Key nötig, fetch() bevorzugt).
 * @param {string} url
 * @returns {boolean}
 */
function isLocalUrl(url) {
  try {
    const { hostname } = new URL(url);
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

/**
 * Erstellt ein einheitliches HttpResponse-Objekt aus einem fetch()-Response.
 * @param {Response} fetchResponse
 * @returns {HttpResponse}
 */
function wrapFetchResponse(fetchResponse) {
  const headers = {};
  fetchResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status:  fetchResponse.status,
    ok:      fetchResponse.ok,
    headers,
    json:    () => fetchResponse.json(),
    text:    () => fetchResponse.text(),
  };
}

/**
 * Erstellt ein einheitliches HttpResponse-Objekt aus einer Zotero.HTTP-Antwort.
 * Zotero.HTTP.request() gibt ein XMLHttpRequest-Objekt zurück.
 * @param {XMLHttpRequest} xhr
 * @returns {HttpResponse}
 */
function wrapZoteroResponse(xhr) {
  // Header aus dem rohen Header-String parsen
  const headers = {};
  const rawHeaders = xhr.getAllResponseHeaders?.() ?? "";
  rawHeaders.split("\r\n").forEach((line) => {
    const idx = line.indexOf(": ");
    if (idx > 0) {
      headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 2);
    }
  });

  const status = xhr.status;
  const bodyText = xhr.responseText ?? "";

  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    json: async () => {
      try {
        return JSON.parse(bodyText);
      } catch (e) {
        throw new Error(
          `httpClient: JSON-Parse-Fehler (Status ${status}): ${bodyText.slice(0, 200)}`
        );
      }
    },
    text: async () => bodyText,
  };
}

// ─── Kernfunktion ──────────────────────────────────────────────────────────

/**
 * Sendet einen HTTP-Request. Wählt automatisch fetch() für localhost
 * und Zotero.HTTP.request() für externe URLs.
 *
 * @param {string}        method  - "GET" | "POST" | "PUT" | "DELETE"
 * @param {string}        url
 * @param {RequestOptions} [opts]
 * @returns {Promise<HttpResponse>}
 */
async function request(method, url, opts = {}) {
  const {
    headers = {},
    body,
    timeout = 30_000,
    mode = "auto",
  } = opts;

  const useLocal =
    mode === "local" || (mode === "auto" && isLocalUrl(url));

  const defaultHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...headers,
  };

  // ── Pfad 1: fetch() für localhost ─────────────────────────────────────
  if (useLocal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOpts = {
        method,
        headers: defaultHeaders,
        signal: controller.signal,
      };
      if (body !== undefined) {
        fetchOpts.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchOpts);
      return wrapFetchResponse(response);
    } catch (err) {
      if (err.name === "AbortError") {
        throw new HttpTimeoutError(url, timeout);
      }
      throw new HttpNetworkError(url, err);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Pfad 2: Zotero.HTTP.request() für Cloud-URLs ──────────────────────
  // Zotero.HTTP.request() wirft bei Netzwerkfehlern, gibt aber bei
  // HTTP-Fehlercodes (4xx, 5xx) trotzdem das XHR-Objekt zurück.
  // Wir fangen beides ab und normalisieren es.
  try {
    const zoteroOpts = {
      method,
      headers: defaultHeaders,
      timeout,
      // Zotero.HTTP erwartet den Body als String
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };

    // Zotero.HTTP.request() löst bei Netzwerkfehlern ab und gibt sonst
    // das XMLHttpRequest-Objekt zurück
    const xhr = await Zotero.HTTP.request(method, url, zoteroOpts);
    return wrapZoteroResponse(xhr);
  } catch (err) {
    // Zotero.HTTP wirft manchmal direkt XHR-Objekte bei HTTP-Fehlern
    if (err && typeof err.status === "number") {
      return wrapZoteroResponse(err);
    }
    if (err?.message?.includes("timeout") || err?.message?.includes("Timeout")) {
      throw new HttpTimeoutError(url, timeout);
    }
    throw new HttpNetworkError(url, err);
  }
}

// ─── Fehlerklassen ─────────────────────────────────────────────────────────

export class HttpTimeoutError extends Error {
  /**
   * @param {string} url
   * @param {number} timeoutMs
   */
  constructor(url, timeoutMs) {
    super(`httpClient: Timeout nach ${timeoutMs}ms — ${url}`);
    this.name = "HttpTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export class HttpNetworkError extends Error {
  /**
   * @param {string} url
   * @param {unknown} cause
   */
  constructor(url, cause) {
    super(`httpClient: Netzwerkfehler für ${url} — ${cause?.message ?? cause}`);
    this.name = "HttpNetworkError";
    this.url = url;
    this.cause = cause;
  }
}

export class HttpResponseError extends Error {
  /**
   * @param {string}       url
   * @param {HttpResponse} response
   */
  constructor(url, response) {
    super(
      `httpClient: HTTP ${response.status} für ${url}`
    );
    this.name = "HttpResponseError";
    this.url = url;
    this.status = response.status;
    this.response = response;
  }
}

// ─── Öffentliche API ───────────────────────────────────────────────────────

export const httpClient = {
  /**
   * GET-Request.
   * @param {string}         url
   * @param {RequestOptions} [opts]
   * @returns {Promise<HttpResponse>}
   */
  get(url, opts = {}) {
    return request("GET", url, opts);
  },

  /**
   * POST-Request mit JSON-Body.
   * @param {string}         url
   * @param {unknown}        body   - Wird zu JSON serialisiert
   * @param {RequestOptions} [opts]
   * @returns {Promise<HttpResponse>}
   */
  post(url, body, opts = {}) {
    return request("POST", url, { ...opts, body });
  },

  /**
   * PUT-Request mit JSON-Body.
   * @param {string}         url
   * @param {unknown}        body
   * @param {RequestOptions} [opts]
   * @returns {Promise<HttpResponse>}
   */
  put(url, body, opts = {}) {
    return request("PUT", url, { ...opts, body });
  },

  /**
   * DELETE-Request.
   * @param {string}         url
   * @param {RequestOptions} [opts]
   * @returns {Promise<HttpResponse>}
   */
  delete(url, opts = {}) {
    return request("DELETE", url, opts);
  },

  /**
   * Schnelltest ob eine URL erreichbar ist.
   * Gibt false zurück statt zu werfen — gut für isAvailable()-Checks.
   * @param {string} url
   * @param {number} [timeoutMs=3000]
   * @returns {Promise<boolean>}
   */
  async ping(url, timeoutMs = 3_000) {
    try {
      const res = await request("GET", url, { timeout: timeoutMs });
      return res.ok || res.status < 500;
    } catch {
      return false;
    }
  },
};