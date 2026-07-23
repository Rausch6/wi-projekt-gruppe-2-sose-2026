import { describe, expect, it, vi } from "vitest";
import {
  OllamaLifecycleManager,
  type ManagedOllamaProcess,
  type OllamaLifecycleDependencies,
} from "../../src/ai/OllamaLifecycleManager";

/**
 * Creates an Ollama lifecycle manager with controllable dependency mocks.
 *
 * @param options - Reachability and installation behavior for the harness.
 * @returns Harness containing the manager and its spyable dependencies.
 */
function createHarness(
  options: {
    reachable?: boolean;
    installed?: boolean;
    becomesReachable?: boolean;
  } = {},
) {
  let reachable = options.reachable ?? false;
  let running = false;
  const kill = vi.fn(() => {
    running = false;
  });
  const process: ManagedOllamaProcess = {
    isRunning: () => running,
    kill,
  };
  const spawn = vi.fn(() => {
    running = true;
    if (options.becomesReachable !== false) reachable = true;
    return process;
  });
  const dependencies: OllamaLifecycleDependencies = {
    getPlatform: () => "macos",
    isReachable: vi.fn(async () => reachable),
    findExecutable: vi.fn(async () =>
      options.installed === false ? null : "/usr/local/bin/ollama",
    ),
    spawn,
    wait: vi.fn(async () => undefined),
  };
  return {
    manager: new OllamaLifecycleManager(dependencies, 5, 1),
    dependencies,
    spawn,
    kill,
  };
}

/**
 * Verifies lifecycle behavior for detecting, starting, and stopping Ollama.
 */
describe("Ollama lifecycle manager", () => {
  it("does not start or stop an externally reachable Ollama", async () => {
    const harness = createHarness({ reachable: true });

    await harness.manager.ensureReady("http://localhost:11434");
    await expect(harness.manager.shutdown()).resolves.toBe(false);

    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.kill).not.toHaveBeenCalled();
  });

  it("starts ollama serve lazily and stops only its owned process", async () => {
    const harness = createHarness();

    await harness.manager.ensureReady("http://localhost:11434");
    expect(harness.spawn).toHaveBeenCalledWith(
      "/usr/local/bin/ollama",
      ["serve"],
      { OLLAMA_HOST: "localhost:11434" },
    );
    expect(harness.manager.ownsRunningProcess()).toBe(true);

    await expect(harness.manager.shutdown()).resolves.toBe(true);
    expect(harness.kill).toHaveBeenCalledOnce();
  });

  it("passes the configured host and port through OLLAMA_HOST", async () => {
    const harness = createHarness();

    await harness.manager.ensureReady("http://127.0.0.1:11500");
    expect(harness.spawn).toHaveBeenCalledWith(
      "/usr/local/bin/ollama",
      ["serve"],
      { OLLAMA_HOST: "127.0.0.1:11500" },
    );
  });

  it("probes without spawning when autoStart is disabled and reports not-running", async () => {
    const harness = createHarness();

    await expect(
      harness.manager.ensureReady("http://localhost:11434", {
        autoStart: false,
      }),
    ).rejects.toMatchObject({ issue: "not-running" });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("probes without spawning when autoStart is disabled and Ollama is missing", async () => {
    const harness = createHarness({ installed: false });

    await expect(
      harness.manager.ensureReady("http://localhost:11434", {
        autoStart: false,
      }),
    ).rejects.toMatchObject({ issue: "not-installed" });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("reports a missing installation without spawning a process", async () => {
    const harness = createHarness({ installed: false });

    await expect(
      harness.manager.ensureReady("http://localhost:11434"),
    ).rejects.toMatchObject({ issue: "not-installed" });
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it.each(["windows", "macos"] as const)(
    "uses identical lazy-start semantics on %s",
    async (platform) => {
      const harness = createHarness();
      harness.dependencies.getPlatform = () => platform;

      await harness.manager.ensureReady("http://localhost:11434");

      expect(harness.dependencies.findExecutable).toHaveBeenCalledWith(
        platform,
      );
      expect(harness.spawn).toHaveBeenCalledOnce();
    },
  );
});
