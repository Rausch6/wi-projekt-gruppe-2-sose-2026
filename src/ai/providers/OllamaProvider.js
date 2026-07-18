import { AIProvider, AIProviderResponseError } from "../AIProvider.js";
import {
  assertHttpOk,
  HttpNetworkError,
  HttpParseError,
  HttpResponseError,
  HttpTimeoutError,
  httpClient,
} from "../../utils/httpClient.js";
import { ollamaLifecycleManager } from "../OllamaLifecycleManager";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "qwen2.5:3b";

/**
 * Lokaler LLM-Provider für die Ollama-HTTP-API. Die Klasse übernimmt
 * Erreichbarkeitsprüfungen, Modellverwaltung und nicht gestreamte Chat-Anfragen.
 * Der gemeinsame Ollama-Lifecycle-Manager startet den lokalen Dienst bei Bedarf.
 */
export class OllamaProvider extends AIProvider {
  /**
   * Erstellt einen lokalen Ollama-Provider.
   *
   * @param {object} [options={}] - Optionale Provider-Konfiguration.
   * @param {string} [options.baseUrl] - Basis-URL der lokalen Ollama-API.
   * @param {string} [options.model] - Standardmodell für Chat-Anfragen.
   * @param {number} [options.timeout] - Standard-Timeout in Millisekunden.
   */
  constructor(options = {}) {
    super({
      id: "ollama",
      name: "Ollama",
      baseUrl: options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
      model: options.model ?? OLLAMA_DEFAULT_MODEL,
      apiKey: "",
    });
    this.timeout = options.timeout ?? 120_000;
  }

  /**
   * Prüft, ob Ollama erreichbar ist und eine gültige Modellliste liefert.
   *
   * @returns {Promise<boolean>} `true`, wenn der lokale Provider verfügbar ist.
   */
  async isAvailable() {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ruft alle lokal installierten Ollama-Modelle ab.
   *
   * @param {object} [options={}] - Optionen für die Verfügbarkeitsprüfung.
   * @param {boolean} [options.autoStart=true] - Startet Ollama bei Bedarf automatisch.
   * @returns {Promise<Array<{id: string, name: string, ownedBy: string}>>} Normalisierte Modellliste.
   */
  async listModels(options = {}) {
    await ollamaLifecycleManager.ensureReady(this.baseUrl, {
      autoStart: options.autoStart !== false,
    });
    const url = `${this.baseUrl}/api/tags`;
    const response = await httpClient.get(url, {
      timeout: Math.min(this.timeout, 30_000),
      mode: "local",
    });
    await assertHttpOk(url, response);

    // Ollama liefert die Modelle unter `models`; ungültige Antworten werden als
    // Providerfehler weitergegeben, damit die UI sie eindeutig behandeln kann.
    const payload = await response.json();
    if (!Array.isArray(payload?.models)) {
      throw new AIProviderResponseError(
        this.id,
        "Ollama returned an invalid model list",
        { details: payload },
      );
    }

    return payload.models
      .map((model) => model?.name ?? model?.model)
      .filter((model) => typeof model === "string" && model.trim())
      .map((model) => ({
        id: model,
        name: model,
        ownedBy: "ollama",
      }));
  }

  /**
   * Lädt ein Modell über Ollamas gestreamte Pull-API herunter.
   *
   * @param {string} [model=this.model] - Name des herunterzuladenden Modells.
   * @param {object} [options={}] - Downloadoptionen.
   * @param {number} [options.timeout] - Alternativer Inaktivitäts-Timeout.
   * @param {number} [options.inactivityTimeout] - Timeout ohne neue Fortschrittsdaten.
   * @param {AbortSignal} [options.signal] - Signal zum Abbrechen des Downloads.
   * @param {Function} [options.onProgress] - Callback für normalisierte Fortschrittswerte.
   * @returns {Promise<object>} Letzte Ollama-Fortschrittsmeldung des Downloads.
   */
  async pullModel(model = this.model, options = {}) {
    await ollamaLifecycleManager.ensureReady(this.baseUrl);
    const url = `${this.baseUrl}/api/pull`;
    const body = {
      model,
      stream: true,
    };

    try {
      const response = await httpClient.streamPost(url, body, {
        timeout: options.inactivityTimeout ?? options.timeout ?? 120_000,
        signal: options.signal,
        mode: "local",
      });
      await assertHttpOk(url, response);

      if (typeof response.streamText !== "function") {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model pull streaming is not available",
        );
      }

      // Jede JSON-Zeile beschreibt einen Fortschrittsschritt. Die letzte Meldung
      // bestätigt den erfolgreichen Abschluss des Downloads.
      let finalPayload = null;
      for await (const payload of parseOllamaJsonLineStream(
        response.streamText(),
        this.id,
      )) {
        if (options.signal?.aborted) throw createAbortError();

        finalPayload = payload;
        if (payload?.error) {
          throw new AIProviderResponseError(this.id, String(payload.error), {
            details: payload,
          });
        }
        options.onProgress?.(normalizePullProgress(payload));
      }

      if (options.signal?.aborted) throw createAbortError();

      if (!finalPayload) {
        throw new AIProviderResponseError(
          this.id,
          "Ollama returned no pull progress",
        );
      }

      if (finalPayload.status && finalPayload.status !== "success") {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model pull did not finish successfully",
          { details: finalPayload },
        );
      }

      return finalPayload;
    } catch (cause) {
      // Transportfehler werden in ein einheitliches Providerfehler-Format
      // übersetzt; Abbrüche bleiben als AbortError erkennbar.
      if (cause instanceof AIProviderResponseError) throw cause;
      if (cause?.name === "AbortError") throw cause;
      if (cause instanceof HttpResponseError) {
        throw new AIProviderResponseError(this.id, cause.message, {
          status: cause.status,
          details: cause.details,
          cause,
        });
      }
      if (cause instanceof HttpTimeoutError) {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model pull timed out because no progress was received.",
          {
            details: { issue: "timeout", timeoutMs: cause.timeoutMs },
            cause,
          },
        );
      }
      if (cause instanceof HttpNetworkError) {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model pull was interrupted.",
          {
            details: { issue: "network" },
            cause,
          },
        );
      }
      throw cause;
    }
  }

  /**
   * Löscht ein lokal installiertes Ollama-Modell.
   *
   * @param {string} [model=this.model] - Name des zu löschenden Modells.
   * @param {object} [options={}] - Optionen für die Anfrage.
   * @param {AbortSignal} [options.signal] - Signal zum Abbrechen der Anfrage.
   * @param {number} [options.timeout] - Anfrage-Timeout in Millisekunden.
   * @returns {Promise<{model: string}>} Name des erfolgreich gelöschten Modells.
   */
  async deleteModel(model = this.model, options = {}) {
    await ollamaLifecycleManager.ensureReady(this.baseUrl);
    const url = `${this.baseUrl}/api/delete`;

    try {
      const response = await httpClient.request("DELETE", url, {
        body: { model },
        mode: "local",
        signal: options.signal,
        timeout: options.timeout ?? 30_000,
      });
      await assertHttpOk(url, response);
      return { model };
    } catch (cause) {
      if (cause instanceof AIProviderResponseError) throw cause;
      if (cause?.name === "AbortError") throw cause;
      if (cause instanceof HttpResponseError) {
        throw new AIProviderResponseError(this.id, cause.message, {
          status: cause.status,
          details: cause.details,
          cause,
        });
      }
      if (cause instanceof HttpTimeoutError) {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model delete timed out.",
          {
            details: { issue: "timeout", timeoutMs: cause.timeoutMs },
            cause,
          },
        );
      }
      if (cause instanceof HttpNetworkError) {
        throw new AIProviderResponseError(
          this.id,
          "Ollama model delete was interrupted.",
          {
            details: { issue: "network" },
            cause,
          },
        );
      }
      throw cause;
    }
  }

  /**
   * Entlädt alle aktuell von Ollama im RAM beziehungsweise VRAM gehaltenen
   * Modelle, ohne einen nicht laufenden Ollama-Dienst eigens zu starten.
   *
   * @param {object} [options={}] - Optionen für Status- und Entladeanfragen.
   * @param {number} [options.timeout] - Anfrage-Timeout in Millisekunden.
   * @returns {Promise<{models: string[]}>} Namen der erfolgreich entladenen Modelle.
   */
  async unloadAllModels(options = {}) {
    const psUrl = `${this.baseUrl}/api/ps`;
    const psResponse = await httpClient.get(psUrl, {
      timeout: options.timeout ?? 5_000,
      mode: "local",
    });
    await assertHttpOk(psUrl, psResponse);

    const payload = await psResponse.json();
    // `/api/ps` kann Modellnamen in unterschiedlichen Feldern liefern. Das Set
    // verhindert, dass dasselbe Modell mehrfach entladen wird.
    const models = [
      ...new Set(
        (Array.isArray(payload?.models) ? payload.models : [])
          .map((model) => model?.name ?? model?.model)
          .filter((model) => typeof model === "string" && model.trim()),
      ),
    ];
    const unloaded = [];
    let firstError = null;

    // `keep_alive: 0` weist Ollama an, das jeweilige Modell sofort zu entladen.
    for (const model of models) {
      const generateUrl = `${this.baseUrl}/api/generate`;
      try {
        const response = await httpClient.post(
          generateUrl,
          { model, keep_alive: 0, stream: false },
          {
            timeout: options.timeout ?? 5_000,
            mode: "local",
          },
        );
        await assertHttpOk(generateUrl, response);
        unloaded.push(model);
      } catch (error) {
        firstError ??= error;
      }
    }

    if (firstError) throw firstError;
    return { models: unloaded };
  }

  /**
   * Sendet eine nicht gestreamte Chat-Anfrage an das ausgewählte Ollama-Modell.
   *
   * @param {Array<object>} messages - Zu sendende Chat-Nachrichten.
   * @param {object} [options={}] - Modell- und Generierungsoptionen.
   * @param {string} [options.model] - Modell für diese einzelne Anfrage.
   * @param {number} [options.timeout] - Anfrage-Timeout in Millisekunden.
   * @returns {Promise<object>} Normalisierte Providerantwort mit Inhalt und Nutzung.
   */
  async chat(messages, options = {}) {
    await ollamaLifecycleManager.ensureReady(this.baseUrl);
    const url = `${this.baseUrl}/api/chat`;
    const model = options.model ?? this.model;
    const body = this.createChatBody(messages, options);

    try {
      const response = await httpClient.post(url, body, {
        timeout: options.timeout ?? this.timeout,
        mode: "local",
      });
      await assertHttpOk(url, response);

      const payload = await response.json();
      const content = payload?.message?.content;

      if (typeof content !== "string") {
        throw new AIProviderResponseError(
          this.id,
          "Ollama returned no assistant message",
          { details: payload },
        );
      }

      return {
        provider: this.id,
        model: payload.model ?? model,
        content,
        finishReason: payload.done_reason ?? null,
        usage: normalizeUsage(payload),
        raw: payload,
      };
    } catch (cause) {
      if (cause instanceof AIProviderResponseError) throw cause;
      if (cause instanceof HttpResponseError) {
        throw new AIProviderResponseError(this.id, cause.message, {
          status: cause.status,
          details: cause.details,
          cause,
        });
      }
      throw cause;
    }
  }

  /**
   * Erstellt den von Ollamas `/api/chat` erwarteten Request-Body.
   *
   * @param {Array<object>} messages - Zu normalisierende Chat-Nachrichten.
   * @param {object} options - Modell- und Generierungsoptionen.
   * @returns {object} Bereinigter Ollama-Request ohne undefinierte Werte.
   */
  createChatBody(messages, options) {
    return removeUndefined({
      model: options.model ?? this.model,
      messages: this.normalizeMessages(messages),
      stream: false,
      options: removeUndefined({
        temperature: options.temperature,
        top_p: options.topP,
        num_predict: options.maxTokens,
        stop: options.stop,
      }),
    });
  }
}

/**
 * Entfernt Eigenschaften mit dem Wert `undefined` aus einem Request-Objekt.
 * Leere Objekte werden ebenfalls als `undefined` zurückgegeben.
 *
 * @param {object} object - Zu bereinigendes Objekt.
 * @returns {object|undefined} Bereinigtes Objekt oder `undefined`.
 */
function removeUndefined(object) {
  const cleaned = Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
  return Object.keys(cleaned).length ? cleaned : undefined;
}

/**
 * Zerlegt den Textstream der Pull-API in einzelne JSON-Meldungen. Unvollständige
 * Zeilen werden bis zum nächsten Chunk im Puffer behalten.
 *
 * @param {AsyncIterable<string>} chunks - Eingehende Textabschnitte.
 * @param {string} providerId - Provider-ID für mögliche Parse-Fehler.
 * @yields {object} Geparste Ollama-Fortschrittsmeldung.
 */
async function* parseOllamaJsonLineStream(chunks, providerId) {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const payload = parseOllamaJsonLine(line, providerId);
      if (payload) yield payload;
    }
  }

  const payload = parseOllamaJsonLine(buffer, providerId);
  if (payload) yield payload;
}

/**
 * Parst eine einzelne JSON-Zeile des Ollama-Fortschrittsstreams.
 *
 * @param {string} line - Zu parsende Zeile.
 * @param {string} providerId - Provider-ID für die Fehlermeldung.
 * @returns {object|null} Fortschrittsmeldung oder `null` bei einer Leerzeile.
 */
function parseOllamaJsonLine(line, providerId) {
  const text = line.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AIProviderResponseError(
      providerId,
      "Ollama returned invalid pull progress",
      {
        details: { line: text.slice(0, 300) },
        cause: new HttpParseError(200, text, cause),
      },
    );
  }
}

/**
 * Vereinheitlicht Ollamas Fortschrittsmeldung für die Setup-Oberfläche.
 *
 * @param {object} payload - Originale Fortschrittsmeldung von Ollama.
 * @returns {object} Status, Bytewerte, Prozentwert und Abschlusszustand.
 */
function normalizePullProgress(payload) {
  const completed =
    typeof payload?.completed === "number" ? payload.completed : null;
  const total = typeof payload?.total === "number" ? payload.total : null;
  const percent =
    total && total > 0 && completed !== null
      ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
      : null;

  return {
    status: typeof payload?.status === "string" ? payload.status : "",
    digest: typeof payload?.digest === "string" ? payload.digest : "",
    completed,
    total,
    percent,
    done: payload?.status === "success",
    raw: payload,
  };
}

/**
 * Erzeugt einen plattformübergreifend erkennbaren Abbruchfehler.
 *
 * @returns {DOMException|Error} Fehler mit dem Namen `AbortError`.
 */
function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Aborted", "AbortError");
  }

  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Überführt Ollamas Tokenzähler in das gemeinsame Provider-Antwortformat.
 *
 * @param {object} payload - Ollama-Chat-Antwort.
 * @returns {object} Prompt-, Antwort- und Gesamtzahl der Tokens.
 */
function normalizeUsage(payload) {
  return {
    promptTokens: payload.prompt_eval_count ?? null,
    completionTokens: payload.eval_count ?? null,
    totalTokens:
      typeof payload.prompt_eval_count === "number" &&
      typeof payload.eval_count === "number"
        ? payload.prompt_eval_count + payload.eval_count
        : null,
  };
}

export default OllamaProvider;
