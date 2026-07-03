import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import { aiProviderManager } from "./ai/AIProviderManager.js";
import {
  createProviderConnectionResult,
  type ProviderConnectionResult,
  type ProviderConnectionState,
} from "./ai/providerConnectionStatus";
import {
  createEmbeddingConnectionResult,
  type EmbeddingConnectionResult,
} from "./ai/embeddingConnectionStatus";
import {
  EMBEDDING_DEFAULT_BASE_URL,
  EMBEDDING_DEFAULT_MODEL,
  REQUIRED_EMBEDDING_MODEL,
  embeddingProvider,
} from "./ai/EmbeddingProvider.js";
import {
  KISSKI_DEFAULT_BASE_URL,
  KISSKI_DEFAULT_MODEL,
} from "./ai/providers/KisskiProvider.js";
import { OllamaProvider } from "./ai/providers/OllamaProvider.js";
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
import type { MetadataFieldSelectionValue } from "./core/MetadataFieldSelection";
import hooks from "./hooks";
import {
  chatSimulation,
  clearChat,
  createChat,
  deleteChat,
  formatLastAssistantRequestDebug,
  formatLastPromptContextRouteDebug,
  getActiveChatID,
  getChatMessages,
  getLastAssistantRequestDebug,
  getLastPromptContextRouteDebug,
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

type OllamaSetupPlatform = "windows" | "macos";

const OLLAMA_SETUP_TEMP_DIR = "zaia-ollama-setup";
const OLLAMA_WINDOWS_SETUP_FILES = [
  "setup-ollama-windows.cmd",
  "setup-ollama-windows.ps1",
];
const OLLAMA_MACOS_SETUP_FILE = "setup-ollama-macos.command";
const OLLAMA_STARTUP_POLL_TIMEOUT_MS = 1_000;

export type PluginSettings = {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  sendPaperContextToKisski: boolean;
  contextRouterProvider: LLMProvider;
  embeddingSearchEnabled: boolean;
  embeddingBaseUrl: string;
  embeddingModel: string;
  maxItems: number;
  metadataFieldSelection: MetadataFieldSelectionValue;
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
      embeddingConnection: EmbeddingConnectionResult;
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
    checkEmbeddingConnection: () => Promise<EmbeddingConnectionResult>;
    launchOllamaSetup: typeof launchOllamaSetup;
    startOllama: () => ReturnType<typeof startOllama>;
    stopOllama: () => ReturnType<typeof stopOllama>;
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
    chatDebug: {
      getLastRequest: typeof getLastAssistantRequestDebug;
      formatLastRequest: typeof formatLastAssistantRequestDebug;
      logLastRequest: () => string;
    };
    contextRouterDebug: {
      getLastDecision: typeof getLastPromptContextRouteDebug;
      formatLastDecision: typeof formatLastPromptContextRouteDebug;
      logLastDecision: () => string;
    };
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
        contextRouterProvider: "ollama",
        embeddingSearchEnabled: true,
        embeddingBaseUrl: EMBEDDING_DEFAULT_BASE_URL,
        embeddingModel: EMBEDDING_DEFAULT_MODEL,
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "qwen2.5:3b",
        maxItems: 200,
        metadataFieldSelection: "title,creators,publicationDate",
        autoDeleteOldChats: true,
      },
      runtime: {
        isAnalyzing: false,
        embeddingConnection: createEmbeddingConnectionResult("unknown"),
        providerConnections: {},
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
      checkProviderConnection: (provider = this.data.settings.provider) =>
        this.checkProviderConnection(provider),
      checkEmbeddingConnection: () => this.checkEmbeddingConnection(),
      launchOllamaSetup,
      startOllama: () => startOllama(this.data.settings.ollamaBaseUrl),
      stopOllama: () => stopOllama(this.data.settings.ollamaBaseUrl),
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
      chatDebug: {
        getLastRequest: getLastAssistantRequestDebug,
        formatLastRequest: formatLastAssistantRequestDebug,
        logLastRequest: () => {
          const report = formatLastAssistantRequestDebug();
          logToZoteroConsole(report);
          return report;
        },
      },
      contextRouterDebug: {
        getLastDecision: getLastPromptContextRouteDebug,
        formatLastDecision: formatLastPromptContextRouteDebug,
        logLastDecision: () => {
          const report = formatLastPromptContextRouteDebug();
          logToZoteroConsole(report);
          return report;
        },
      },
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

  private async checkEmbeddingConnection(): Promise<EmbeddingConnectionResult> {
    const baseUrl = this.data.settings.embeddingBaseUrl.trim();
    const model = REQUIRED_EMBEDDING_MODEL;

    if (!baseUrl) {
      const result = createEmbeddingConnectionResult("missing-config", {
        issue: "base-url-missing",
        model,
        message: "Embedding base URL is missing.",
      });
      this.data.runtime.embeddingConnection = result;
      return result;
    }

    const provider = new OllamaProvider({
      baseUrl,
      model,
      timeout: 30_000,
    });

    try {
      const models = await provider.listModels();
      if (!hasModel(models, model)) {
        const result = createEmbeddingConnectionResult("missing-model", {
          issue: "model-not-installed",
          model,
          baseUrl,
          message: `Ollama is reachable, but the embedding model ${model} is not installed.`,
        });
        this.data.runtime.embeddingConnection = result;
        return result;
      }

      const result = createEmbeddingConnectionResult("ready", {
        model,
        baseUrl,
        message: "Embedding model is ready.",
      });
      this.data.runtime.embeddingConnection = result;
      return result;
    } catch (error) {
      const result = createEmbeddingConnectionResult(
        getEmbeddingConnectionFailureStatus(error),
        {
          issue: getEmbeddingConnectionFailureIssue(error),
          model,
          baseUrl,
          error: getErrorMessage(error),
          message: "No communication with Ollama embeddings.",
        },
      );
      this.data.runtime.embeddingConnection = result;
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

function getEmbeddingConnectionFailureStatus(error: unknown) {
  const name = getErrorName(error);
  return name === "AIProviderResponseError" ? "error" : "unreachable";
}

function getEmbeddingConnectionFailureIssue(error: unknown) {
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

async function launchOllamaSetup() {
  const platform = getOllamaSetupPlatform();
  const setupDir = await ensureOllamaSetupTempDirectory();
  const launcherPath =
    platform === "windows"
      ? await prepareWindowsOllamaSetup(setupDir)
      : await prepareMacOllamaSetup(setupDir);

  Zotero.File.pathToFile(launcherPath).launch();
  return { platform, path: launcherPath };
}

async function startOllama(baseUrl: string) {
  const platform = getOllamaSetupPlatform();
  if (await isOllamaServerReachable(baseUrl)) {
    return { platform, started: false, alreadyRunning: true };
  }

  const launcher = await findOllamaLauncher(platform);
  runDetachedProcess(launcher.executablePath, launcher.args);
  return {
    platform,
    started: true,
    alreadyRunning: false,
    path: launcher.executablePath,
  };
}

async function stopOllama(baseUrl: string) {
  const platform = getOllamaSetupPlatform();
  if (!(await isOllamaServerReachable(baseUrl))) {
    return { platform, stopped: false, alreadyStopped: true };
  }

  await runOllamaStopCommand(platform);
  return { platform, stopped: true, alreadyStopped: false };
}

function getOllamaSetupPlatform(): OllamaSetupPlatform {
  if (Zotero.isWin) return "windows";
  if (Zotero.isMac) return "macos";

  throw new Error("Ollama setup is only available for Windows and macOS.");
}

async function ensureOllamaSetupTempDirectory() {
  const setupDir = PathUtils.join(
    Zotero.getTempDirectory().path,
    OLLAMA_SETUP_TEMP_DIR,
  );
  await IOUtils.makeDirectory(setupDir, {
    createAncestors: true,
    ignoreExisting: true,
  });
  return setupDir;
}

async function prepareWindowsOllamaSetup(setupDir: string) {
  for (const fileName of OLLAMA_WINDOWS_SETUP_FILES) {
    await copyBundledSetupFile(fileName, setupDir);
  }
  return PathUtils.join(setupDir, OLLAMA_WINDOWS_SETUP_FILES[0]);
}

async function prepareMacOllamaSetup(setupDir: string) {
  const launcherPath = await copyBundledSetupFile(
    OLLAMA_MACOS_SETUP_FILE,
    setupDir,
  );
  await IOUtils.setPermissions(launcherPath, 0o755);
  return launcherPath;
}

async function copyBundledSetupFile(fileName: string, targetDir: string) {
  const sourceUrl = rootURI + `setup/${fileName}`;
  const targetPath = PathUtils.join(targetDir, fileName);
  const contents = await Zotero.File.getContentsFromURLAsync(sourceUrl);
  await Zotero.File.putContentsAsync(targetPath, contents, "utf-8");
  return targetPath;
}

async function findOllamaLauncher(platform: OllamaSetupPlatform) {
  if (platform === "windows") {
    const launcher = await findExistingLauncher(getWindowsOllamaLaunchers());
    if (!launcher) throw new Error("Ollama is not installed.");
    return launcher;
  }

  const appPath = await findExistingPath(getMacOllamaAppPaths());
  if (appPath) {
    return { executablePath: "/usr/bin/open", args: [appPath] };
  }

  const executablePath = await findExistingPath(getMacOllamaCliPaths());
  if (!executablePath) throw new Error("Ollama is not installed.");
  return { executablePath, args: ["serve"] };
}

async function findExistingPath(paths: string[]) {
  for (const path of paths) {
    if (path && (await IOUtils.exists(path))) return path;
  }
  return null;
}

async function findExistingLauncher(
  launchers: Array<{ executablePath: string; args: string[] }>,
) {
  for (const launcher of launchers) {
    if (
      launcher.executablePath &&
      (await IOUtils.exists(launcher.executablePath))
    ) {
      return launcher;
    }
  }
  return null;
}

function getWindowsOllamaLaunchers() {
  const launchers: Array<{ executablePath: string; args: string[] }> = [];
  for (const basePath of getWindowsOllamaBasePaths()) {
    launchers.push({
      executablePath: PathUtils.join(basePath, "ollama.exe"),
      args: ["serve"],
    });
    launchers.push({
      executablePath: PathUtils.join(basePath, "ollama app.exe"),
      args: [],
    });
  }
  return launchers;
}

function getWindowsOllamaBasePaths() {
  const localAppData = getEnv("LOCALAPPDATA");
  const programFiles = getEnv("ProgramFiles");
  const programFilesX86 = getEnv("ProgramFiles(x86)");
  return [
    localAppData ? PathUtils.join(localAppData, "Programs", "Ollama") : "",
    localAppData ? PathUtils.join(localAppData, "Ollama") : "",
    programFiles ? PathUtils.join(programFiles, "Ollama") : "",
    programFilesX86 ? PathUtils.join(programFilesX86, "Ollama") : "",
  ].filter(Boolean);
}

function getMacOllamaAppPaths() {
  const home = getEnv("HOME");
  return [
    "/Applications/Ollama.app",
    home ? PathUtils.join(home, "Applications", "Ollama.app") : "",
  ].filter(Boolean);
}

function getMacOllamaCliPaths() {
  return [
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
    "/usr/bin/ollama",
  ];
}

function getEnv(name: string) {
  return Services.env.exists(name) ? Services.env.get(name) : "";
}

function runDetachedProcess(executablePath: string, args: string[]) {
  const executable = Zotero.File.pathToFile(executablePath);
  const process = Components.classes[
    "@mozilla.org/process/util;1"
  ].createInstance(Components.interfaces.nsIProcess);
  process.init(executable);
  process.startHidden = true;
  process.noShell = true;
  process.runAsync(args, args.length);
}

async function runOllamaStopCommand(platform: OllamaSetupPlatform) {
  if (platform === "windows") {
    const taskkillPath = await findWindowsTaskkillPath();
    runDetachedProcess(taskkillPath, ["/IM", "ollama.exe", "/T", "/F"]);
    runDetachedProcess(taskkillPath, ["/IM", "ollama app.exe", "/T", "/F"]);
    return;
  }

  await runMacOllamaStopCommands();
}

async function findWindowsTaskkillPath() {
  const systemRoot = getEnv("SystemRoot") || "C:\\Windows";
  const taskkillPath = PathUtils.join(systemRoot, "System32", "taskkill.exe");
  if (await IOUtils.exists(taskkillPath)) return taskkillPath;

  throw new Error("taskkill.exe was not found.");
}

async function runMacOllamaStopCommands() {
  const pkillPath = "/usr/bin/pkill";
  if (!(await IOUtils.exists(pkillPath))) {
    throw new Error("pkill was not found.");
  }

  runDetachedProcess(pkillPath, ["-x", "Ollama"]);
  runDetachedProcess(pkillPath, ["-x", "ollama"]);
}

async function isOllamaServerReachable(baseUrl: string) {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) return false;

  try {
    const response = await Zotero.HTTP.request(
      "GET",
      `${normalizedBaseUrl}/api/tags`,
      {
        timeout: OLLAMA_STARTUP_POLL_TIMEOUT_MS,
        successCodes: false,
        errorDelayMax: 0,
      },
    );
    return response.status >= 200 && response.status < 300;
  } catch (_zoteroHttpError) {
    try {
      const response = await raceWithTimeout(
        fetch(`${normalizedBaseUrl}/api/tags`),
        OLLAMA_STARTUP_POLL_TIMEOUT_MS,
      );
      return response.ok;
    } catch (_fetchError) {
      return false;
    }
  }
}

function raceWithTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeout} ms.`));
    }, timeout);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
