import { AIProviderConfigurationError } from "./AIProvider.js";
import { KisskiProvider } from "./providers/KisskiProvider.js";

export class AIProviderManager {
  constructor(options = {}) {
    this.providers = new Map();
    this.register(new KisskiProvider(options.kisski));
    this.activeProviderId = options.activeProvider ?? "kisski";
  }

  register(provider) {
    if (!provider?.id || typeof provider.chat !== "function") {
      throw new TypeError("Invalid AI provider");
    }
    this.providers.set(provider.id, provider);
    return this;
  }

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

  setActiveProvider(providerId) {
    this.getProvider(providerId);
    this.activeProviderId = providerId;
    return this;
  }

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

  listProviders() {
    return [...this.providers.values()].map((provider) => ({
      ...provider.getConfig(),
      active: provider.id === this.activeProviderId,
    }));
  }

  setModel(model, providerId) {
    return this.getProvider(providerId).setModel(model).getConfig();
  }

  isAvailable(providerId) {
    return this.getProvider(providerId).isAvailable();
  }

  listModels(providerId) {
    return this.getProvider(providerId).listModels();
  }

  chat(messages, options = {}) {
    const { providerId, ...providerOptions } = options;
    return this.getProvider(providerId).chat(messages, providerOptions);
  }

  complete(prompt, options = {}) {
    const { providerId, ...providerOptions } = options;
    return this.getProvider(providerId).complete(prompt, providerOptions);
  }
}

export const aiProviderManager = new AIProviderManager();

export default AIProviderManager;
