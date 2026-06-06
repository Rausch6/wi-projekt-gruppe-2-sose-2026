// HTTP transport shared by local and cloud AI providers.

/**
 * @typedef {"auto" | "local" | "cloud"} TransportMode
 */

/**
 * @typedef {Object} RequestOptions
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body]
 * @property {number} [timeout]
 * @property {TransportMode} [mode]
 */

/**
 * @typedef {Object} HttpResponse
 * @property {number} status
 * @property {boolean} ok
 * @property {Record<string, string>} headers
 * @property {() => Promise<unknown>} json
 * @property {() => Promise<string>} text
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const headers = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });

    return createResponse(response.status, headers, await response.text());
  } catch (cause) {
    if (cause?.name === "AbortError") {
      throw new HttpTimeoutError(url, options.timeout);
    }
    throw new HttpNetworkError(url, cause);
  } finally {
    clearTimeout(timer);
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
  const useFetch = mode === "local" || (mode === "auto" && isLocalUrl(url));

  return useFetch
    ? sendWithFetch(method, url, transportOptions)
    : sendWithZotero(method, url, transportOptions);
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

  get(url, options = {}) {
    return request("GET", url, options);
  },

  post(url, body, options = {}) {
    return request("POST", url, { ...options, body });
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
