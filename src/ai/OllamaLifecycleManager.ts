/** Vom automatischen lokalen Ollama-Lifecycle unterstützte Plattformen. */
export type OllamaPlatform = "windows" | "macos";

/** Maschinenlesbare Gründe für fehlende lokale Ollama-Bereitschaft. */
export type OllamaLifecycleIssue =
  | "unsupported-platform"
  | "remote-endpoint-unreachable"
  | "not-installed"
  | "not-running"
  | "start-failed"
  | "startup-timeout";

/** Minimale Prozessschnittstelle, die der Lifecycle-Manager benötigt. */
export type ManagedOllamaProcess = {
  isRunning: () => boolean;
  kill: () => void;
};

/** Austauschbare Systemabhängigkeiten für Laufzeit und Tests. */
export type OllamaLifecycleDependencies = {
  getPlatform: () => OllamaPlatform;
  isReachable: (baseUrl: string) => Promise<boolean>;
  findExecutable: (platform: OllamaPlatform) => Promise<string | null>;
  spawn: (
    executablePath: string,
    args: string[],
    env?: Record<string, string>,
  ) => ManagedOllamaProcess;
  wait: (milliseconds: number) => Promise<void>;
  terminateAll?: (platform: OllamaPlatform) => Promise<void>;
};

export type EnsureReadyOptions = {
  /**
   * Bei `false` prüft `ensureReady` nur Erreichbarkeit und Installation, ohne
   * einen Prozess zu starten. Passive Setup-Prüfungen blockieren dadurch nicht
   * bis zum vollständigen Start-Timeout.
   */
  autoStart?: boolean;
};

/**
 * Fehler mit maschinenlesbarem Grund für die Setup- und Statusanzeige.
 */
export class OllamaLifecycleError extends Error {
  readonly issue: OllamaLifecycleIssue;

  /**
   * @param issue - Maschinenlesbarer Fehlergrund für Provider und UI.
   * @param message - Technische Fehlermeldung für Protokollierung und Diagnose.
   */
  constructor(issue: OllamaLifecycleIssue, message: string) {
    super(message);
    this.name = "OllamaLifecycleError";
    this.issue = issue;
  }
}

/**
 * Verwaltet den lokalen Ollama-Dienst nach der Installation. Die Klasse prüft
 * Installation und Erreichbarkeit, startet Ollama bei Bedarf und beendet nur
 * Prozesse, die sie selbst gestartet hat, sofern nicht ausdrücklich alle
 * Ollama-Prozesse terminiert werden sollen.
 */
export class OllamaLifecycleManager {
  private managedProcess: ManagedOllamaProcess | null = null;
  private startupPromise: Promise<void> | null = null;

  /**
   * @param dependencies - Plattform- und Prozessfunktionen des Managers.
   * @param startupTimeoutMs - Maximale Wartezeit auf die lokale Ollama-API.
   * @param pollIntervalMs - Abstand zwischen zwei Erreichbarkeitsprüfungen.
   */
  constructor(
    private readonly dependencies: OllamaLifecycleDependencies,
    private readonly startupTimeoutMs = 20_000,
    private readonly pollIntervalMs = 500,
  ) {}

  /**
   * Stellt sicher, dass der konfigurierte lokale Ollama-Endpunkt erreichbar ist.
   * Bei passiver Prüfung wird nur ein präziser Statusfehler geliefert; bei
   * aktiver Prüfung darf Ollama automatisch gestartet werden.
   *
   * @param baseUrl - Zu prüfende Ollama-Basis-URL.
   * @param options - Steuerung des automatischen Starts.
   */
  async ensureReady(
    baseUrl: string,
    options: EnsureReadyOptions = {},
  ): Promise<void> {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (await this.dependencies.isReachable(normalizedBaseUrl)) return;

    if (!isLocalOllamaUrl(normalizedBaseUrl)) {
      throw new OllamaLifecycleError(
        "remote-endpoint-unreachable",
        "The configured Ollama endpoint is not reachable.",
      );
    }

    if (options.autoStart === false) {
      const installed = await this.isInstalled();
      throw new OllamaLifecycleError(
        installed ? "not-running" : "not-installed",
        installed
          ? "Ollama is installed but not currently running."
          : "Ollama is not installed.",
      );
    }

    if (this.startupPromise) return this.startupPromise;

    this.startupPromise = this.startAndWait(normalizedBaseUrl).finally(() => {
      this.startupPromise = null;
    });
    return this.startupPromise;
  }

  /** Prüft, ob die Ollama-Programmdatei an einem bekannten Ort vorhanden ist. */
  async isInstalled(): Promise<boolean> {
    return Boolean(
      await this.dependencies.findExecutable(this.dependencies.getPlatform()),
    );
  }

  /** Prüft, ob der Manager aktuell einen selbst gestarteten Prozess verwaltet. */
  ownsRunningProcess() {
    return Boolean(this.managedProcess?.isRunning());
  }

  /**
   * Beendet ausschließlich den vom Manager selbst gestarteten Ollama-Prozess.
   *
   * @returns Ob ein laufender Prozess beendet wurde.
   */
  async shutdown(): Promise<boolean> {
    const process = this.managedProcess;
    this.managedProcess = null;
    if (!process?.isRunning()) return false;

    try {
      process.kill();
      return true;
    } catch (error) {
      this.managedProcess = process;
      throw error;
    }
  }

  /** Beendet plattformspezifisch alle bekannten Ollama-Prozesse. */
  async terminateAll(): Promise<void> {
    const terminateAll = this.dependencies.terminateAll;
    if (!terminateAll) {
      throw new OllamaLifecycleError(
        "unsupported-platform",
        "Terminating all Ollama processes is not available.",
      );
    }

    await terminateAll(this.dependencies.getPlatform());
    this.managedProcess = null;
  }

  /**
   * Startet `ollama serve` und wartet bis zum Timeout auf die lokale API.
   *
   * @param baseUrl - Lokaler Endpunkt, dessen Erreichbarkeit erwartet wird.
   */
  private async startAndWait(baseUrl: string) {
    const platform = this.dependencies.getPlatform();
    const executablePath = await this.dependencies.findExecutable(platform);
    if (!executablePath) {
      throw new OllamaLifecycleError(
        "not-installed",
        "Ollama is not installed.",
      );
    }

    if (!this.managedProcess?.isRunning()) {
      try {
        this.managedProcess = this.dependencies.spawn(
          executablePath,
          ["serve"],
          {
            OLLAMA_HOST: getOllamaHostFromBaseUrl(baseUrl),
          },
        );
      } catch (error) {
        throw new OllamaLifecycleError(
          "start-failed",
          `Ollama could not be started: ${getErrorMessage(error)}`,
        );
      }
    }

    const timeoutAt = Date.now() + this.startupTimeoutMs;
    do {
      if (await this.dependencies.isReachable(baseUrl)) return;
      await this.dependencies.wait(this.pollIntervalMs);
    } while (Date.now() < timeoutAt);

    if (this.managedProcess?.isRunning()) {
      try {
        this.managedProcess.kill();
      } catch {
        // Der Prozess kann zwischen Prüfung und Beenden bereits beendet worden sein.
      }
    }
    this.managedProcess = null;
    throw new OllamaLifecycleError(
      "startup-timeout",
      "Ollama did not become reachable after it was started.",
    );
  }
}

/** Entfernt Leerraum und abschließende Schrägstriche aus der Basis-URL. */
function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Ermittelt den Wert für OLLAMA_HOST aus der konfigurierten Basis-URL. */
function getOllamaHostFromBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return "127.0.0.1:11434";
  }
}

/** Prüft, ob die URL auf den lokalen Rechner zeigt und automatisch startbar ist. */
function isLocalOllamaUrl(baseUrl: string) {
  try {
    const hostname = new URL(baseUrl).hostname;
    return (
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

/** Wandelt beliebige Fehlerwerte in einen protokollierbaren Text um. */
function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Setzt Umgebungsvariablen nur für den Prozessstart und liefert eine Funktion
 * zum Wiederherstellen der vorherigen Werte.
 */
function applyTemporaryEnv(env: Record<string, string>): () => void {
  const previousValues = new Map<string, string | null>();
  for (const [key, value] of Object.entries(env)) {
    previousValues.set(
      key,
      Services.env.exists(key) ? Services.env.get(key) : null,
    );
    Services.env.set(key, value);
  }

  return () => {
    for (const [key, previousValue] of previousValues) {
      Services.env.set(key, previousValue ?? "");
    }
  };
}

/** Erstellt die Zotero- und betriebssystemspezifischen Standardabhängigkeiten. */
function createDefaultDependencies(): OllamaLifecycleDependencies {
  return {
    getPlatform() {
      if (typeof Zotero === "undefined") return "macos";
      if (Zotero.isWin) return "windows";
      if (Zotero.isMac) return "macos";
      throw new OllamaLifecycleError(
        "unsupported-platform",
        "Automatic Ollama management is only available on Windows and macOS.",
      );
    },
    async isReachable(baseUrl) {
      // Zotero.HTTP ist der bevorzugte Prüfpfad; fetch dient als Fallback für
      // Laufzeitumgebungen, in denen der Zotero-Request fehlschlägt.
      if (typeof Zotero === "undefined") return true;
      const url = `${baseUrl}/api/tags`;
      try {
        const response = await Zotero.HTTP.request("GET", url, {
          timeout: 1_000,
          successCodes: false,
          errorDelayMax: 0,
        });
        return response.status >= 200 && response.status < 300;
      } catch {
        try {
          const response = await Promise.race([
            fetch(url),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), 1_000),
            ),
          ]);
          return response.ok;
        } catch {
          return false;
        }
      }
    },
    async findExecutable(platform) {
      // Der erste vorhandene bekannte Pfad wird als Ollama-CLI verwendet.
      if (typeof IOUtils === "undefined" || typeof PathUtils === "undefined") {
        return null;
      }

      for (const path of getExecutableCandidates(platform)) {
        if (path && (await IOUtils.exists(path))) return path;
      }
      return null;
    },
    spawn(executablePath, args, env) {
      const executable = Zotero.File.pathToFile(executablePath);
      const process = Components.classes[
        "@mozilla.org/process/util;1"
      ].createInstance(Components.interfaces.nsIProcess) as any;
      process.init(executable);
      process.startHidden = true;
      process.noShell = true;

      // nsIProcess unterstützt keine Umgebung pro Kindprozess. Deshalb werden
      // die Variablen unmittelbar vor dem Start gesetzt und direkt danach
      // wiederhergestellt, damit sie nicht in Zotero bestehen bleiben.
      const restoreEnv = env ? applyTemporaryEnv(env) : null;
      try {
        process.runAsync(args, args.length);
      } finally {
        restoreEnv?.();
      }

      return {
        isRunning: () => Boolean(process.isRunning),
        kill: () => process.kill(),
      };
    },
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    async terminateAll(platform) {
      // Das vollständige Beenden ist bewusst plattformspezifisch und umfasst
      // auch Ollama-Prozesse, die nicht von ZAIA gestartet wurden.
      if (platform === "macos") {
        await runSystemProcess(
          "/usr/bin/osascript",
          ["-e", 'quit app "Ollama"'],
          [0, 1],
        );
        await runSystemProcess(
          "/usr/bin/pkill",
          ["-i", "-x", "ollama"],
          [0, 1],
        );
        return;
      }

      const windowsDirectory = getEnvironmentValue("WINDIR") || "C:\\Windows";
      const taskkill = PathUtils.join(
        windowsDirectory,
        "System32",
        "taskkill.exe",
      );
      await runSystemProcess(
        taskkill,
        ["/F", "/T", "/IM", "ollama app.exe"],
        [0, 128],
      );
      await runSystemProcess(
        taskkill,
        ["/F", "/T", "/IM", "ollama.exe"],
        [0, 128],
      );
    },
  };
}

/**
 * Führt einen Systemprozess versteckt aus und akzeptiert nur festgelegte
 * Exit-Codes als erfolgreichen Abschluss.
 */
function runSystemProcess(
  executablePath: string,
  args: string[],
  allowedExitCodes: number[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const executable = Zotero.File.pathToFile(executablePath);
      const process = Components.classes[
        "@mozilla.org/process/util;1"
      ].createInstance(Components.interfaces.nsIProcess) as any;
      process.init(executable);
      process.startHidden = true;
      process.noShell = true;
      process.runAsync(
        args,
        args.length,
        {
          observe(_subject: unknown, topic: string) {
            const exitCode = Number(process.exitValue);
            if (
              topic === "process-finished" &&
              allowedExitCodes.includes(exitCode)
            ) {
              resolve();
              return;
            }

            reject(
              new Error(
                `Process ${executablePath} failed with exit code ${exitCode}.`,
              ),
            );
          },
        },
        false,
      );
    } catch (error) {
      reject(error);
    }
  });
}

/** Liefert die üblichen Ollama-Programmpfade für die aktuelle Plattform. */
function getExecutableCandidates(platform: OllamaPlatform) {
  if (platform === "windows") {
    const localAppData = getEnvironmentValue("LOCALAPPDATA");
    const programFiles = getEnvironmentValue("ProgramFiles");
    const programFilesX86 = getEnvironmentValue("ProgramFiles(x86)");
    const pathCandidates = (
      getEnvironmentValue("PATH") || getEnvironmentValue("Path")
    )
      .split(";")
      .filter(Boolean)
      .map((directory) => PathUtils.join(directory, "ollama.exe"));
    return [
      ...pathCandidates,
      localAppData
        ? PathUtils.join(localAppData, "Programs", "Ollama", "ollama.exe")
        : "",
      localAppData ? PathUtils.join(localAppData, "Ollama", "ollama.exe") : "",
      programFiles ? PathUtils.join(programFiles, "Ollama", "ollama.exe") : "",
      programFilesX86
        ? PathUtils.join(programFilesX86, "Ollama", "ollama.exe")
        : "",
    ];
  }

  const home = getEnvironmentValue("HOME");
  const pathCandidates = getEnvironmentValue("PATH")
    .split(":")
    .filter(Boolean)
    .map((directory) => PathUtils.join(directory, "ollama"));
  return [
    ...pathCandidates,
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
    "/usr/bin/ollama",
    "/Applications/Ollama.app/Contents/Resources/ollama",
    home
      ? PathUtils.join(
          home,
          "Applications",
          "Ollama.app",
          "Contents",
          "Resources",
          "ollama",
        )
      : "",
  ];
}

/** Liest eine Umgebungsvariable sicher über die Mozilla-Services. */
function getEnvironmentValue(name: string) {
  return typeof Services !== "undefined" && Services.env.exists(name)
    ? Services.env.get(name)
    : "";
}

// Gemeinsame Lifecycle-Instanz für Addon-API, Setup-Status und Shutdown-Hook.
export const ollamaLifecycleManager = new OllamaLifecycleManager(
  createDefaultDependencies(),
);
