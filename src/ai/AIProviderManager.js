import { AIProviderConfigurationError } from "./AIProvider.js";
import { KisskiProvider } from "./providers/KisskiProvider.js";
import { OllamaProvider } from "./providers/OllamaProvider.js";

/**
 * Verwaltet alle verfuegbaren KI-Provider und leitet Anfragen an den aktiven Provider weiter.
 */
export class AIProviderManager {
  /**
   * Erstellt den Provider-Manager mit KISSKI und Ollama.
   *
   * @param {object} [options={}] - Startkonfiguration fuer die Provider.
   * @param {object} [options.kisski] - Konfiguration fuer den KISSKI-Provider.
   * @param {object} [options.ollama] - Konfiguration fuer den Ollama-Provider.
   * @param {string} [options.activeProvider] - ID des initial aktiven Providers.
   */
  constructor(options = {}) {
    this.providers = new Map();
    this.register(new KisskiProvider(options.kisski));
    this.register(new OllamaProvider(options.ollama));
    this.activeProviderId = options.activeProvider ?? "kisski";
  }

  /**
   * Registriert einen Provider im Manager.
   *
   * @param {object} provider - Provider mit ID und Chat-Funktion.
   * @returns {AIProviderManager} Der aktuelle Manager fuer Method-Chaining.
   */
  register(provider) {
    if (!provider?.id || typeof provider.chat !== "function") {
      throw new TypeError("Invalid AI provider");
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  /**
   * Gibt einen Provider anhand seiner ID zurueck.
   *
   * @param {string} [providerId=this.activeProviderId] - ID des gesuchten Providers.
   * @returns {object} Der gefundene Provider.
   */
  getProvider(providerId = this.activeProviderId) {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AIProviderConfigurationError(
        providerId,
        `Unknown AI provider: ${providerId}`,
      );
    }
    return provider;
  }

  /**
   * Setzt den aktiven Provider fuer zukuenftige Anfragen ohne explizite Provider-ID.
   *
   * @param {string} providerId - ID des Providers.
   * @returns {AIProviderManager} Der aktuelle Manager fuer Method-Chaining.
   */
  setActiveProvider(providerId) {
    this.getProvider(providerId);
    this.activeProviderId = providerId;
    return this;
  }

  /**
   * Aktualisiert die Konfiguration eines Providers.
   *
   * @param {string} providerId - ID des Providers.
   * @param {object} [config={}] - Neue Provider-Konfiguration.
   * @param {string} [config.apiKey] - API-Key fuer Cloud-Provider.
   * @param {string} [config.model] - Modell-ID.
   * @param {string} [config.baseUrl] - Basis-URL des Providers.
   * @param {number} [config.timeout] - Request-Timeout in Millisekunden.
   * @returns {object} Die normalisierte Provider-Konfiguration.
   */
  configureProvider(providerId, config = {}) {
    const provider = this.getProvider(providerId);

    if (config.apiKey !== undefined) {
      if (config.apiKey) provider.setApiKey(config.apiKey);
      else provider.clearApiKey();
    }
    if (config.model !== undefined) provider.setModel(config.model);
    if (config.baseUrl !== undefined) provider.setBaseUrl(config.baseUrl);
    if (config.timeout !== undefined) provider.timeout = config.timeout;

    return provider.getConfig();
  }

  /**
   * Listet alle registrierten Provider mit Aktivstatus auf.
   *
   * @returns {Array<object>} Provider-Konfigurationen inklusive Aktivstatus.
   */
  listProviders() {
    return [...this.providers.values()].map((provider) => ({
      ...provider.getConfig(),
      active: provider.id === this.activeProviderId,
    }));
  }

  /**
   * Setzt das Modell eines Providers.
   *
   * @param {string} model - Neue Modell-ID.
   * @param {string} [providerId] - Optionale Provider-ID.
   * @returns {object} Die aktualisierte Provider-Konfiguration.
   */
  setModel(model, providerId) {
    return this.getProvider(providerId).setModel(model).getConfig();
  }

  /**
   * Prueft, ob ein Provider erreichbar ist.
   *
   * @param {string} [providerId] - Optionale Provider-ID.
   * @returns {Promise<boolean>} True, wenn der Provider verfuegbar ist.
   */
  isAvailable(providerId) {
    return this.getProvider(providerId).isAvailable();
  }

  /**
   * Ruft die verfuegbaren Modelle eines Providers ab.
   *
   * @param {string} [providerId] - Optionale Provider-ID.
   * @param {object} [options] - Provider-spezifische Optionen.
   * @returns {Promise<Array<object>>} Liste verfuegbarer Modelle.
   */
  listModels(providerId, options) {
    return this.getProvider(providerId).listModels(options);
  }

  /**
   * Sendet Chat-Nachrichten an einen Provider.
   *
   * @param {Array<object>} messages - Chat-Nachrichten im Provider-Format.
   * @param {object} [options={}] - Chat-Optionen inklusive optionaler providerId.
   * @returns {Promise<object>} Antwort des Providers.
   */
  chat(messages, options = {}) {
    const { providerId, ...providerOptions } = options;
    return this.getProvider(providerId).chat(messages, providerOptions);
  }

  /**
   * Sendet Chat-Nachrichten als Streaming-Anfrage an einen Provider.
   *
   * @param {Array<object>} messages - Chat-Nachrichten im Provider-Format.
   * @param {object} [options={}] - Streaming-Optionen inklusive optionaler providerId.
   * @returns {AsyncGenerator<object>} Stream mit Chat-Events.
   */
  chatStream(messages, options = {}) {
    const { providerId, ...providerOptions } = options;
    return this.getProvider(providerId).chatStream(messages, providerOptions);
  }

  /**
   * Sendet einen einfachen Prompt an einen Provider.
   *
   * @param {string} prompt - Nutzerprompt.
   * @param {object} [options={}] - Anfrageoptionen inklusive optionaler providerId.
   * @returns {Promise<object>} Antwort des Providers.
   */
  complete(prompt, options = {}) {
    const { providerId, ...providerOptions } = options;
    return this.getProvider(providerId).complete(prompt, providerOptions);
  }

  /**
   * Erstellt Embeddings ueber einen Provider, falls dieser Embeddings unterstuetzt.
   *
   * @param {string} text - Text, der eingebettet werden soll.
   * @param {object} [options={}] - Embedding-Optionen inklusive optionaler providerId.
   * @returns {Promise<object>} Embedding-Antwort des Providers.
   */
  embed(text, options = {}) {
    const { providerId, ...providerOptions } = options;
    return this.getProvider(providerId).embed(text, providerOptions);
  }
}

export const aiProviderManager = new AIProviderManager();

export default AIProviderManager;
