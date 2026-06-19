import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import { aiProviderManager } from "./ai/AIProviderManager.js";
import {
  createProviderConnectionResult,
  type ProviderConnectionResult,
  type ProviderConnectionState,
} from "./ai/providerConnectionStatus";
import {
  KISSKI_DEFAULT_BASE_URL,
  KISSKI_DEFAULT_MODEL,
} from "./ai/providers/KisskiProvider.js";
import {
  PaperContextService,
  type ChunkedPaper,
} from "./core/PaperContextService";
import { ItemManager } from "./core/ItemManager";
import { LibraryScopeManager } from "./core/LibraryScopeManager";
import hooks from "./hooks";
import {
  chatSimulation,
  clearChat,
  createChat,
  deleteChat,
  getActiveChatID,
  getChatMessages,
  listChats,
  loadChat,
  sendChatPrompt,
  setChatFavorite,
} from "./ui/assistantChatController";
import { openAssistantSidebar } from "./ui/assistantSidebarController";
import { createZToolkit } from "./utils/ztoolkit";

export type LLMProvider = "kisski" | "ollama";
let lastPaperChunkReport = "";

export type PluginSettings = {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  sendPaperContextToKisski: boolean;
  maxItems: number;
  ollamaBaseUrl: string;
  ollamaModel: string;
  autoDeleteOldChats: boolean;
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
      providerConnections: ProviderConnectionState;
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
    checkProviderConnection: (
      provider?: LLMProvider,
    ) => Promise<ProviderConnectionResult>;
    analyze: (
      query: string,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    chat: {
      send: typeof sendChatPrompt;
      clear: typeof clearChat;
      getMessages: typeof getChatMessages;
      getActiveChatID: typeof getActiveChatID;
      list: typeof listChats;
      create: typeof createChat;
      load: typeof loadChat;
      delete: typeof deleteChat;
      setFavorite: typeof setChatFavorite;
    };
    chatSimulation: typeof chatSimulation;
    paperDebug: {
      logSelectedChunks: (itemID?: number) => Promise<string>;
      showSelectedChunks: (itemID?: number) => Promise<string>;
      getLastReport: () => string;
      getSelectedItemIDs: () => number[];
    };
    libraryScopes: {
      list: typeof LibraryScopeManager.listLibraryScopes;
      getSelected: typeof LibraryScopeManager.getSelectedLibraryScope;
      listRagCandidates: typeof LibraryScopeManager.listRagItemCandidates;
    };
    openChat: () => boolean;
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
        sendPaperContextToKisski: true,
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "qwen2.5:3b",
        maxItems: 20,
        autoDeleteOldChats: true,
      },
      runtime: {
        isAnalyzing: false,
        providerConnections: {},
      },
    };
    this.hooks = hooks;
    this.api = {
      ai: aiProviderManager,
      configureAI: () => {
        const provider = this.data.settings.provider;
        const providerConfig =
          provider === "ollama"
            ? {
                baseUrl: this.data.settings.ollamaBaseUrl,
                model: this.data.settings.ollamaModel,
              }
            : {
                apiKey: this.data.settings.apiKey,
                baseUrl: this.data.settings.baseUrl,
                model: this.data.settings.model,
              };

        return aiProviderManager
          .setActiveProvider(provider)
          .configureProvider(provider, providerConfig);
      },
      checkProviderConnection: (provider = this.data.settings.provider) =>
        this.checkProviderConnection(provider),
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
      chat: {
        send: sendChatPrompt,
        clear: clearChat,
        getMessages: getChatMessages,
        getActiveChatID,
        list: listChats,
        create: createChat,
        load: loadChat,
        delete: deleteChat,
        setFavorite: setChatFavorite,
      },
      chatSimulation,
      paperDebug: {
        logSelectedChunks: logSelectedPaperChunks,
        showSelectedChunks: showSelectedPaperChunks,
        getLastReport: () => lastPaperChunkReport,
        getSelectedItemIDs: () =>
          ItemManager.getSelectedItems().map((item) => item.id),
      },
      libraryScopes: {
        list: LibraryScopeManager.listLibraryScopes,
        getSelected: LibraryScopeManager.getSelectedLibraryScope,
        listRagCandidates: LibraryScopeManager.listRagItemCandidates,
      },
      openChat: () => {
        const win = Zotero.getMainWindow();
        if (!win) return false;

        openAssistantSidebar(win);
        return true;
      },
    };
  }

  private configureProvider(provider: LLMProvider) {
    const providerConfig =
      provider === "ollama"
        ? {
            baseUrl: this.data.settings.ollamaBaseUrl,
            model: this.data.settings.ollamaModel,
          }
        : {
            apiKey: this.data.settings.apiKey,
            baseUrl: this.data.settings.baseUrl,
            model: this.data.settings.model,
          };

    return aiProviderManager.configureProvider(provider, providerConfig);
  }

  private async checkProviderConnection(
    provider: LLMProvider,
  ): Promise<ProviderConnectionResult> {
    const missingConfig = this.getMissingProviderConfigResult(provider);
    if (missingConfig) {
      this.data.runtime.providerConnections[provider] = missingConfig;
      return missingConfig;
    }

    this.configureProvider(provider);

    try {
      const models = await aiProviderManager.listModels(provider);
      const configuredModel = this.getConfiguredProviderModel(provider);
      const hasConfiguredModel = hasModel(models, configuredModel);

      if (!hasConfiguredModel) {
        const result = createProviderConnectionResult(
          provider,
          "missing-model",
          {
            issue:
              provider === "ollama"
                ? "model-not-installed"
                : "model-not-available",
            model: configuredModel,
            baseUrl: this.getConfiguredProviderBaseUrl(provider),
            message:
              provider === "ollama"
                ? `Ollama is reachable, but ${configuredModel} is not installed.`
                : `Cloud LLM is reachable, but ${configuredModel} is not available.`,
          },
        );
        this.data.runtime.providerConnections[provider] = result;
        return result;
      }

      const result = createProviderConnectionResult(provider, "ready", {
        model: configuredModel,
        baseUrl: this.getConfiguredProviderBaseUrl(provider),
        message:
          provider === "ollama"
            ? "Ollama connection is ready."
            : "Cloud LLM connection is ready.",
      });
      this.data.runtime.providerConnections[provider] = result;
      return result;
    } catch (error) {
      const result = createProviderConnectionResult(
        provider,
        getConnectionFailureStatus(error),
        {
          issue: getConnectionFailureIssue(error),
          model: this.getConfiguredProviderModel(provider),
          baseUrl: this.getConfiguredProviderBaseUrl(provider),
          error: getErrorMessage(error),
          message:
            provider === "ollama"
              ? "No communication with Ollama."
              : "No communication with the cloud LLM.",
        },
      );
      this.data.runtime.providerConnections[provider] = result;
      return result;
    }
  }

  private getMissingProviderConfigResult(provider: LLMProvider) {
    const baseUrl = this.getConfiguredProviderBaseUrl(provider);
    const model = this.getConfiguredProviderModel(provider);

    if (!baseUrl) {
      return createProviderConnectionResult(provider, "missing-config", {
        issue: "base-url-missing",
        message: "Base URL is missing.",
      });
    }

    if (!model) {
      return createProviderConnectionResult(provider, "missing-config", {
        issue: "model-missing",
        baseUrl,
        message: "Model is missing.",
      });
    }

    if (provider === "kisski" && !this.data.settings.apiKey.trim()) {
      return createProviderConnectionResult(provider, "missing-config", {
        issue: "api-key-missing",
        model,
        baseUrl,
        message: "API key is missing.",
      });
    }

    return null;
  }

  private getConfiguredProviderBaseUrl(provider: LLMProvider) {
    return provider === "ollama"
      ? this.data.settings.ollamaBaseUrl.trim()
      : this.data.settings.baseUrl.trim();
  }

  private getConfiguredProviderModel(provider: LLMProvider) {
    return provider === "ollama"
      ? this.data.settings.ollamaModel.trim()
      : this.data.settings.model.trim();
  }
}

function hasModel(models: unknown, configuredModel: string) {
  if (!Array.isArray(models)) return false;
  return models.some((model) => {
    const record = model as { id?: unknown; name?: unknown; model?: unknown };
    return [record.id, record.name, record.model].some(
      (value) => typeof value === "string" && value.trim() === configuredModel,
    );
  });
}

function getConnectionFailureStatus(error: unknown) {
  const name = getErrorName(error);
  return name === "AIProviderResponseError" ? "error" : "unreachable";
}

function getConnectionFailureIssue(error: unknown) {
  const name = getErrorName(error);
  return name === "AIProviderResponseError"
    ? "invalid-response"
    : "provider-unreachable";
}

function getErrorName(error: unknown) {
  return error instanceof Error ? error.name : "";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function logSelectedPaperChunks(itemID?: number) {
  const paper = await PaperContextService.getSelectedPaperChunks(itemID);
  if (!paper) {
    throw new Error(
      "Zotero konnte keinen Text aus dem ausgewählten PDF laden. Prüfe, ob es lokal verfügbar und per OCR durchsuchbar ist.",
    );
  }

  const report = formatPaperChunks(paper);
  lastPaperChunkReport = report;
  logToZoteroConsole(report);
  return report;
}

async function showSelectedPaperChunks(itemID?: number) {
  const report = await logSelectedPaperChunks(itemID);
  Zotero.Utilities.Internal.copyTextToClipboard(report);

  const chunkCount = report.match(/^\[C\d+\]/gm)?.length ?? 0;
  const message = [
    `Paper erfolgreich in ${chunkCount} Chunks umgewandelt.`,
    "Der vollständige Bericht wurde in die Zwischenablage kopiert",
    "und in die Zotero-Debugausgabe geschrieben.",
  ].join("\n");
  Zotero.getMainWindow()?.alert(message);
  return message;
}

function formatPaperChunks(paper: ChunkedPaper) {
  const header = [
    "[ZAIA Paper Chunks]",
    `Titel: ${paper.title}`,
    `Autorenschaft: ${paper.creators}`,
    paper.year ? `Jahr: ${paper.year}` : "",
    `Attachment-ID: ${paper.attachmentID}`,
    `Chunks: ${paper.chunks.length}`,
  ]
    .filter(Boolean)
    .join("\n");

  const chunks = paper.chunks.map((chunk) => {
    const pages = formatChunkPages(chunk.pageStart, chunk.pageEnd);
    return `[${chunk.id}] ${pages}, ca. ${chunk.estimatedTokens} Tokens\n${chunk.text}`;
  });

  return [header, ...chunks].join("\n\n");
}

function formatChunkPages(pageStart: number | null, pageEnd: number | null) {
  if (pageStart === null) return "Seite unbekannt";
  if (pageStart === pageEnd) return `Seite ${pageStart}`;
  return `Seiten ${pageStart}-${pageEnd}`;
}

function logToZoteroConsole(message: string) {
  Zotero.debug(message);
  (
    Zotero as unknown as {
      log?: (value: string) => void;
    }
  ).log?.(message);
  globalThis.console?.log(message);
}

export default Addon;
