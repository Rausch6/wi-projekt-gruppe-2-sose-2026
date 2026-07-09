// HTTP transport shared by local and cloud AI providers.

/**
 * @typedef {"auto" | "local" | "cloud"} TransportMode
 */

/**
 * @typedef {Object} RequestOptions
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body]
 * @property {number} [timeout]
 * @property {AbortSignal} [signal]
 * @property {TransportMode} [mode]
 */

/**
 * @typedef {Object} HttpResponse
 * @property {number} status
 * @property {boolean} ok
 * @property {Record<string, string>} headers
 * @property {() => Promise<unknown>} json
 * @property {() => Promise<string>} text
 * @property {() => AsyncGenerator<string>} [streamText]
 */

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

function serializeBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

/**
 * Send an HTTP request through Zotero's network stack for cloud URLs.
 *
 * @param {string} method
 * @param {string} url
 * @param {RequestOptions} [options]
 * @returns {Promise<HttpResponse>}
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
 * Send an HTTP request and expose the response body as a text stream.
 *
 * Zotero.HTTP.request buffers the whole response, so real streaming uses
 * fetch when the runtime exposes a ReadableStream-capable implementation.
 *
 * @param {string} method
 * @param {string} url
 * @param {RequestOptions} [options]
 * @returns {Promise<HttpResponse>}
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

function createAbortController() {
  if (typeof AbortController !== "function") return null;
  return new AbortController();
}

function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Aborted", "AbortError");
  }

  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

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

export class HttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "HttpError";
    this.url = options.url;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export class HttpTimeoutError extends HttpError {
  constructor(url, timeoutMs) {
    super(`HTTP request timed out after ${timeoutMs} ms: ${url}`, { url });
    this.name = "HttpTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class HttpNetworkError extends HttpError {
  constructor(url, cause) {
    super(`HTTP network error for ${url}: ${cause?.message ?? cause}`, {
      url,
      cause,
    });
    this.name = "HttpNetworkError";
  }
}

export class HttpStreamingUnsupportedError extends HttpError {
  constructor(url, reason) {
    super(`HTTP streaming is not supported for ${url}: ${reason}`, { url });
    this.name = "HttpStreamingUnsupportedError";
    this.reason = reason;
  }
}

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
 * Throw a response error while preserving a JSON API error message.
 *
 * @param {string} url
 * @param {HttpResponse} response
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
