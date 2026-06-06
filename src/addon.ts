import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";

// Provider nur KISSKI.
export type LLMProvider = "kisski";

// Einstellungen, die später aus den Zotero-Preferences geladen werden. d.h. Nutzer kann diese in Zotero ändern/anpassen
// Der API-Key steht hier nur als leerer Platzhalter, niemals fest im Code.
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
    // Env type, see build.js
    env: "development" | "production";
    ztoolkit: ZToolkit;
    
    settings: PluginSettings;
    // Laufzeitstatus: Diese Werte ändern sich während das Plugin benutzt wird.
    // Beispiel: Eine KI-Analyse läuft gerade oder ein Fehler muss angezeigt werden.
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
  // Lifecycle hooks
  public hooks: typeof hooks;
  // Öffentliche Plugin-API.
  // Hier steht nur, welche Funktionen das Plugin anbieten kann.
  // Die echte KISSKI-Anbindung gehört später in eigene Dateien unter src/ai/*.
  public api: {
    analyze?: (query: string) => Promise<void>;
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
        baseUrl: "",
        model: "",
        maxItems: 20,
      },
      runtime: {
        isAnalyzing: false,
      },

    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
