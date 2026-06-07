import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import { aiProviderManager } from "./ai/AIProviderManager.js";
import {
  KISSKI_DEFAULT_BASE_URL,
  KISSKI_DEFAULT_MODEL,
} from "./ai/providers/KisskiProvider.js";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";

// Provider nur KISSKI.
export type LLMProvider = "kisski";

export type PluginSettings = {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxItems: number;
};

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    ztoolkit: ZToolkit;
    settings: PluginSettings;
    runtime: {
      isAnalyzing: boolean;
      lastError?: string;
    };
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
      columns: Array<ColumnOptions>;
      rows: Array<{ [dataKey: string]: string }>;
    };
    dialog?: DialogHelper;
  };
  public hooks: typeof hooks;
  public api: {
    ai: typeof aiProviderManager;
    configureAI: () => ReturnType<typeof aiProviderManager.configureProvider>;
    analyze: (
      query: string,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
  };

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      ztoolkit: createZToolkit(),

      settings: {
        provider: "kisski",
        apiKey: "",
        baseUrl: KISSKI_DEFAULT_BASE_URL,
        model: KISSKI_DEFAULT_MODEL,
        maxItems: 20,
      },
      runtime: {
        isAnalyzing: false,
      },
    };
    this.hooks = hooks;
    this.api = {
      ai: aiProviderManager,
      configureAI: () =>
        aiProviderManager.configureProvider("kisski", this.data.settings),
      analyze: async (query, options = {}) => {
        this.data.runtime.isAnalyzing = true;
        delete this.data.runtime.lastError;

        try {
          return await aiProviderManager.complete(query, options);
        } catch (error) {
          this.data.runtime.lastError =
            error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          this.data.runtime.isAnalyzing = false;
        }
      },
    };
  }
}

export default Addon;
