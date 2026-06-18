import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import { aiProviderManager } from "./ai/AIProviderManager.js";
import {
  EMBEDDING_DEFAULT_BASE_URL,
  EMBEDDING_DEFAULT_MODEL,
  embeddingProvider,
} from "./ai/EmbeddingProvider.js";
import {
  KISSKI_DEFAULT_BASE_URL,
  KISSKI_DEFAULT_MODEL,
} from "./ai/providers/KisskiProvider.js";
import {
  PaperContextService,
  type ChunkedPaper,
} from "./core/PaperContextService";
import {
  type ChunkEmbeddingDebugResult,
  EmbeddingSearchService,
} from "./core/EmbeddingSearchService";
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
let lastPaperEmbeddingReport = "";

type PaperEmbeddingReportOptions = {
  itemID?: number;
  query?: string;
  vectorLimit?: number;
  includeFullVectors?: boolean;
  includeInput?: boolean;
  includeNormalizedVectors?: boolean;
  maxChunks?: number;
  maxTokens?: number;
};

type PaperEmbeddingReportRequest = number | PaperEmbeddingReportOptions;

export type PluginSettings = {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  sendPaperContextToKisski: boolean;
  embeddingSearchEnabled: boolean;
  embeddingBaseUrl: string;
  embeddingModel: string;
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
    embeddings: typeof embeddingProvider;
    configureEmbeddings: () => ReturnType<
      typeof EmbeddingSearchService.configure
    >;
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
      logSelectedEmbeddings: (
        input?: PaperEmbeddingReportRequest,
        options?: PaperEmbeddingReportOptions,
      ) => Promise<string>;
      showSelectedEmbeddings: (
        input?: PaperEmbeddingReportRequest,
        options?: PaperEmbeddingReportOptions,
      ) => Promise<string>;
      getLastReport: () => string;
      getLastEmbeddingReport: () => string;
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
        embeddingSearchEnabled: true,
        embeddingBaseUrl: EMBEDDING_DEFAULT_BASE_URL,
        embeddingModel: EMBEDDING_DEFAULT_MODEL,
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
      embeddings: embeddingProvider,
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
      configureEmbeddings: () =>
        EmbeddingSearchService.configure({
          enabled: this.data.settings.embeddingSearchEnabled,
          baseUrl: this.data.settings.embeddingBaseUrl,
          model: this.data.settings.embeddingModel,
        }),
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
        logSelectedEmbeddings: logSelectedPaperEmbeddings,
        showSelectedEmbeddings: showSelectedPaperEmbeddings,
        getLastReport: () => lastPaperChunkReport,
        getLastEmbeddingReport: () => lastPaperEmbeddingReport,
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

async function logSelectedPaperEmbeddings(
  input?: PaperEmbeddingReportRequest,
  options?: PaperEmbeddingReportOptions,
) {
  const reportOptions = normalizeEmbeddingReportOptions(input, options);
  const paper = await PaperContextService.getSelectedPaperChunks(
    reportOptions.itemID,
  );
  if (!paper) {
    throw new Error(
      "Zotero konnte keinen Text aus dem ausgewählten PDF laden. Prüfe, ob es lokal verfügbar und per OCR durchsuchbar ist.",
    );
  }

  addon.api.configureEmbeddings();
  const debug = await EmbeddingSearchService.createEmbeddingDebugReport(
    paper.chunks,
    {
      query: reportOptions.query,
      maxChunks: reportOptions.maxChunks,
      maxTokens: reportOptions.maxTokens,
    },
  );
  const report = formatPaperEmbeddings(paper, debug, reportOptions);
  lastPaperEmbeddingReport = report;
  logToZoteroConsole(report);
  return report;
}

async function showSelectedPaperEmbeddings(
  input?: PaperEmbeddingReportRequest,
  options?: PaperEmbeddingReportOptions,
) {
  const report = await logSelectedPaperEmbeddings(input, options);
  Zotero.Utilities.Internal.copyTextToClipboard(report);

  const chunkCount = report.match(/^\[C\d+\]/gm)?.length ?? 0;
  const message = [
    `Embedding-Bericht für ${chunkCount} Chunks erstellt.`,
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

  const embeddingStatus = EmbeddingSearchService.getLastStatus();
  const searchStatus = [
    "[ZAIA Retrieval]",
    `Modus: ${embeddingStatus.mode}`,
    `Status: ${embeddingStatus.message}`,
    embeddingStatus.error ? `Fehler: ${embeddingStatus.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [header, searchStatus, ...chunks].join("\n\n");
}

function formatPaperEmbeddings(
  paper: ChunkedPaper,
  debug: ChunkEmbeddingDebugResult,
  options: PaperEmbeddingReportOptions,
) {
  const vectorLimit = normalizeVectorLimit(options.vectorLimit);
  const header = [
    "[ZAIA Paper Embeddings]",
    `Titel: ${paper.title}`,
    `Autorenschaft: ${paper.creators}`,
    paper.year ? `Jahr: ${paper.year}` : "",
    `Attachment-ID: ${paper.attachmentID}`,
    `Chunks: ${paper.chunks.length}`,
    `Embedding-Modell: ${debug.provider.model}`,
    `Embedding-Base-URL: ${debug.provider.baseUrl}`,
    options.includeFullVectors
      ? "Vektorausgabe: vollständig"
      : `Vektorausgabe: erste ${vectorLimit} Werte pro Vektor`,
  ]
    .filter(Boolean)
    .join("\n");

  const querySection = debug.query
    ? [
        "[ZAIA Query Embedding]",
        `Frage: ${debug.query.text}`,
        `Dimensionen: ${debug.query.embedding.length}`,
        "Embedding:",
        formatEmbeddingVector(debug.query.embedding, options),
        options.includeNormalizedVectors
          ? [
              "Normalisiertes Embedding:",
              formatEmbeddingVector(debug.query.normalizedEmbedding, options),
            ].join("\n")
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const chunks = debug.records.map((record) => {
    const pages = formatChunkPages(
      record.chunk.pageStart,
      record.chunk.pageEnd,
    );
    const selection =
      record.selected === undefined
        ? ""
        : record.selected
          ? "Auswahl: ja"
          : "Auswahl: nein";
    const ranking =
      typeof record.rank === "number"
        ? `Ranking: #${record.rank}${typeof record.score === "number" ? `, Score: ${formatEmbeddingNumber(record.score)}` : ""}`
        : "";
    const input =
      options.includeInput === false
        ? ""
        : ["Embedding-Input:", record.input].join("\n");
    const normalizedVector = options.includeNormalizedVectors
      ? [
          "Normalisiertes Embedding:",
          formatEmbeddingVector(record.normalizedEmbedding, options),
        ].join("\n")
      : "";

    return [
      `[${record.chunk.id}] ${pages}, ca. ${record.chunk.estimatedTokens} Tokens`,
      ranking,
      selection,
      `Embedding-Input: ${countWords(record.input)} Wörter, ${record.input.length} Zeichen`,
      `Dimensionen: ${record.embedding.length}`,
      "Embedding:",
      formatEmbeddingVector(record.embedding, options),
      normalizedVector,
      input,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [header, querySection, ...chunks].filter(Boolean).join("\n\n");
}

function normalizeEmbeddingReportOptions(
  input?: PaperEmbeddingReportRequest,
  overrides: PaperEmbeddingReportOptions = {},
): PaperEmbeddingReportOptions {
  const base =
    typeof input === "number"
      ? { itemID: input }
      : input && typeof input === "object"
        ? input
        : {};

  return {
    ...base,
    ...overrides,
  };
}

function normalizeVectorLimit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 32;
}

function formatEmbeddingVector(
  vector: number[],
  options: PaperEmbeddingReportOptions,
) {
  const limit = options.includeFullVectors
    ? vector.length
    : Math.min(normalizeVectorLimit(options.vectorLimit), vector.length);
  const values = vector.slice(0, limit).map(formatEmbeddingNumber);
  const lines: string[] = [];

  for (let index = 0; index < values.length; index += 8) {
    lines.push(values.slice(index, index + 8).join(", "));
  }

  const truncated =
    limit < vector.length
      ? `\n  ... ${vector.length - limit} weitere Werte`
      : "";
  return `[\n  ${lines.join(",\n  ")}${truncated}\n]`;
}

function formatEmbeddingNumber(value: number) {
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(6);
}

function countWords(text: string) {
  return text.trim().match(/\S+/g)?.length ?? 0;
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
