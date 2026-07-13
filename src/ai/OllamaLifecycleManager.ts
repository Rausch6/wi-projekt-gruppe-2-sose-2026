export type OllamaPlatform = "windows" | "macos";

export type OllamaLifecycleIssue =
  | "unsupported-platform"
  | "remote-endpoint-unreachable"
  | "not-installed"
  | "not-running"
  | "start-failed"
  | "startup-timeout";

export type ManagedOllamaProcess = {
  isRunning: () => boolean;
  kill: () => void;
};

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
   * When false, ensureReady only probes reachability and reports whether
   * Ollama is installed/running instead of spawning and waiting for it.
   * Used by passive status checks so they don't block for the full
   * startup timeout just to render a readiness indicator.
   */
  autoStart?: boolean;
};

export class OllamaLifecycleError extends Error {
  readonly issue: OllamaLifecycleIssue;

  constructor(issue: OllamaLifecycleIssue, message: string) {
    super(message);
    this.name = "OllamaLifecycleError";
    this.issue = issue;
  }
}

export class OllamaLifecycleManager {
  private managedProcess: ManagedOllamaProcess | null = null;
  private startupPromise: Promise<void> | null = null;

  constructor(
    private readonly dependencies: OllamaLifecycleDependencies,
    private readonly startupTimeoutMs = 20_000,
    private readonly pollIntervalMs = 500,
  ) {}

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

  async isInstalled(): Promise<boolean> {
    return Boolean(
      await this.dependencies.findExecutable(this.dependencies.getPlatform()),
    );
  }

  ownsRunningProcess() {
    return Boolean(this.managedProcess?.isRunning());
  }

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
        // The process may have terminated between the checks.
      }
    }
    this.managedProcess = null;
    throw new OllamaLifecycleError(
      "startup-timeout",
      "Ollama did not become reachable after it was started.",
    );
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

function getOllamaHostFromBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return "127.0.0.1:11434";
  }
}

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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

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

      // nsIProcess has no per-child environment option; the child inherits
      // whatever is set on our own process at the moment it forks. Set the
      // vars right before spawning and restore them right after so this
      // doesn't leak into the rest of Zotero's environment.
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

function getEnvironmentValue(name: string) {
  return typeof Services !== "undefined" && Services.env.exists(name)
    ? Services.env.get(name)
    : "";
}

export const ollamaLifecycleManager = new OllamaLifecycleManager(
  createDefaultDependencies(),
);
