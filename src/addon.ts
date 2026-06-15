import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import { aiProviderManager } from "./ai/AIProviderManager.js";
import {
  KISSKI_DEFAULT_BASE_URL,
  KISSKI_DEFAULT_MODEL,
} from "./ai/providers/KisskiProvider.js";
import {
  PaperContextService,
  type ChunkedPaper,
} from "./core/PaperContextService";
import { ItemManager } from "./core/ItemManager";
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
      openChat: () => {
        const win = Zotero.getMainWindow();
        if (!win) return false;

        openAssistantSidebar(win);
        return true;
      },
    };
  }
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
