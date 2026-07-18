/**
 * Gemeinsamer Vertrag für Cloud- und lokale KI-Provider. Die Basisklasse
 * normalisiert Konfiguration und Nachrichten und stellt ein Streaming-Fallback
 * für Provider wie Ollama bereit, die hier eine normale Chat-Antwort liefern.
 */
export class AIProvider {
  /**
   * Erstellt die gemeinsame Basis fuer konkrete KI-Provider.
   *
   * @param {object} config - Provider-Konfiguration.
   * @param {string} config.id - Eindeutige Provider-ID.
   * @param {string} config.name - Anzeigename des Providers.
   * @param {string} config.baseUrl - Basis-URL der Provider-API.
   * @param {string} config.model - Standardmodell des Providers.
   * @param {string} [config.apiKey=""] - Optionaler API-Key.
   */
  constructor({ id, name, baseUrl, model, apiKey = "" }) {
    if (new.target === AIProvider) {
      throw new TypeError("AIProvider is abstract and cannot be instantiated");
    }

    this.id = requireText(id, "Provider id");
    this.name = requireText(name, "Provider name");
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = requireText(model, "Model");
    this.apiKey = apiKey.trim();
  }

  /**
   * Setzt den API-Key des Providers.
   *
   * @param {string} apiKey - Neuer API-Key.
   * @returns {AIProvider} Der aktuelle Provider fuer Method-Chaining.
   */
  setApiKey(apiKey) {
    this.apiKey = requireText(apiKey, "API key");
    return this;
  }

  /**
   * Entfernt den gespeicherten API-Key.
   *
   * @returns {AIProvider} Der aktuelle Provider fuer Method-Chaining.
   */
  clearApiKey() {
    this.apiKey = "";
    return this;
  }

  /**
   * Setzt das Standardmodell des Providers.
   *
   * @param {string} model - Neue Modell-ID.
   * @returns {AIProvider} Der aktuelle Provider fuer Method-Chaining.
   */
  setModel(model) {
    this.model = requireText(model, "Model");
    return this;
  }

  /**
   * Setzt die Basis-URL des Providers.
   *
   * @param {string} baseUrl - Neue Basis-URL.
   * @returns {AIProvider} Der aktuelle Provider fuer Method-Chaining.
   */
  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    return this;
  }

  /**
   * Gibt die oeffentliche Provider-Konfiguration zurueck.
   *
   * @returns {object} Provider-ID, Name, Basis-URL, Modell und API-Key-Status.
   */
  getConfig() {
    return {
      id: this.id,
      name: this.name,
      baseUrl: this.baseUrl,
      model: this.model,
      hasApiKey: Boolean(this.apiKey),
    };
  }

  /**
   * Stellt sicher, dass ein API-Key gesetzt ist.
   *
   * @returns {void}
   */
  requireApiKey() {
    if (!this.apiKey) {
      throw new AIProviderConfigurationError(
        this.id,
        `No API key configured for ${this.name}`,
      );
    }
  }

  /**
   * Normalisiert und validiert Chat-Nachrichten.
   *
   * @param {Array<object>} messages - Eingehende Chat-Nachrichten.
   * @returns {Array<object>} Normalisierte Nachrichten fuer Provider-Requests.
   */
  normalizeMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AIProviderConfigurationError(
        this.id,
        "At least one chat message is required",
      );
    }

    return messages.map((message, index) => {
      if (!message || typeof message !== "object") {
        throw new AIProviderConfigurationError(
          this.id,
          `Message ${index} must be an object`,
        );
      }

      const role = requireText(message.role, `Message ${index} role`);
      const content = requireText(message.content, `Message ${index} content`);

      if (!["system", "user", "assistant", "tool"].includes(role)) {
        throw new AIProviderConfigurationError(
          this.id,
          `Unsupported message role: ${role}`,
        );
      }

      const normalized = { role, content };
      if (message.name) normalized.name = String(message.name);
      if (message.tool_call_id) {
        normalized.tool_call_id = String(message.tool_call_id);
      }
      return normalized;
    });
  }

  /**
   * Wandelt einen einfachen Prompt in Chat-Nachrichten um und sendet ihn.
   *
   * @param {string} prompt - Nutzerprompt.
   * @param {object} [options={}] - Anfrageoptionen.
   * @param {string} [options.systemPrompt] - Optionaler Systemprompt.
   * @returns {Promise<object>} Antwort des konkreten Providers.
   */
  async complete(prompt, options = {}) {
    const messages = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });
    return this.chat(messages, options);
  }

  /**
   * Prueft die Verfuegbarkeit des konkreten Providers.
   *
   * @returns {Promise<boolean>} True, wenn der Provider verfuegbar ist.
   */
  async isAvailable() {
    throw new Error(`${this.name}.isAvailable() is not implemented`);
  }

  /**
   * Listet die verfuegbaren Modelle des konkreten Providers.
   *
   * @returns {Promise<Array<object>>} Liste verfuegbarer Modelle.
   */
  async listModels() {
    throw new Error(`${this.name}.listModels() is not implemented`);
  }

  /**
   * Sendet Chat-Nachrichten an den konkreten Provider.
   *
   * @param {Array<object>} _messages - Chat-Nachrichten.
   * @param {object} [_options={}] - Anfrageoptionen.
   * @returns {Promise<object>} Antwort des Providers.
   */
  async chat(_messages, _options = {}) {
    throw new Error(`${this.name}.chat() is not implemented`);
  }

  /**
   * Streamt Chat-Antworten oder emuliert Streaming ueber eine normale Chat-Antwort.
   *
   * @param {Array<object>} messages - Chat-Nachrichten.
   * @param {object} [options={}] - Anfrageoptionen.
   * @returns {AsyncGenerator<object>} Stream mit Content- und Done-Events.
   */
  async *chatStream(messages, options = {}) {
    // Provider ohne eigene Streaming-Implementierung werden über eine reguläre
    // Chat-Anfrage in ein einheitliches Content- und Done-Ereignis übersetzt.
    const response = await this.chat(messages, options);
    const content =
      typeof response?.content === "string" ? response.content : "";

    if (content) {
      yield {
        type: "content",
        content,
        provider: response.provider ?? this.id,
        model: response.model ?? this.model,
      };
    }

    yield {
      type: "done",
      provider: response?.provider ?? this.id,
      model: response?.model ?? this.model,
      finishReason: response?.finishReason ?? null,
      usage: response?.usage ?? null,
    };
  }
}

/**
 * Basisklasse fuer Provider-Fehler.
 */
export class AIProviderError extends Error {
  /**
   * Erstellt einen Provider-Fehler mit optionalen Details.
   *
   * @param {string} providerId - ID des betroffenen Providers.
   * @param {string} message - Fehlermeldung.
   * @param {object} [options={}] - Optionale Fehlerdetails.
   * @param {number} [options.status] - HTTP-Statuscode.
   * @param {*} [options.details] - Provider-spezifische Details.
   * @param {Error} [options.cause] - Urspruenglicher Fehler.
   */
  constructor(providerId, message, options = {}) {
    super(message);
    this.name = "AIProviderError";
    this.providerId = providerId;
    this.status = options.status;
    this.details = options.details;
    this.cause = options.cause;
  }
}

/**
 * Fehler fuer fehlende oder ungueltige Provider-Konfiguration.
 */
export class AIProviderConfigurationError extends AIProviderError {
  /**
   * Erstellt einen Konfigurationsfehler.
   *
   * @param {string} providerId - ID des betroffenen Providers.
   * @param {string} message - Fehlermeldung.
   */
  constructor(providerId, message) {
    super(providerId, message);
    this.name = "AIProviderConfigurationError";
  }
}

/**
 * Fehler fuer ungueltige oder fehlgeschlagene Provider-Antworten.
 */
export class AIProviderResponseError extends AIProviderError {
  /**
   * Erstellt einen Antwortfehler.
   *
   * @param {string} providerId - ID des betroffenen Providers.
   * @param {string} message - Fehlermeldung.
   * @param {object} [options={}] - Optionale Fehlerdetails.
   */
  constructor(providerId, message, options = {}) {
    super(providerId, message, options);
    this.name = "AIProviderResponseError";
  }
}

/**
 * Validiert einen nicht-leeren String.
 *
 * @param {*} value - Zu pruefender Wert.
 * @param {string} label - Feldname fuer Fehlermeldungen.
 * @returns {string} Getrimmter String.
 */
function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Normalisiert eine Basis-URL ohne abschliessende Slashes.
 *
 * @param {string} baseUrl - Eingehende Basis-URL.
 * @returns {string} Normalisierte Basis-URL.
 */
function normalizeBaseUrl(baseUrl) {
  return requireText(baseUrl, "Base URL").replace(/\/+$/, "");
}
