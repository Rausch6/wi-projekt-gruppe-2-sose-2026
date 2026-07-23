import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const setupRoot = resolve(process.cwd(), "setup");
const macosScript = readFileSync(
  resolve(setupRoot, "setup-ollama-macos.command"),
  "utf8",
);
const windowsScript = readFileSync(
  resolve(setupRoot, "setup-ollama-windows.ps1"),
  "utf8",
);
const ollamaProvider = readFileSync(
  resolve(process.cwd(), "src/ai/providers/OllamaProvider.js"),
  "utf8",
);

/**
 * Verifies that bundled Ollama setup scripts install the app safely and report outcomes.
 */
describe("Ollama app setup scripts", () => {
  it("installs only the desktop app and leaves model downloads to ZAIA", () => {
    for (const script of [macosScript, windowsScript]) {
      expect(script).not.toContain("qwen2.5:3b");
      expect(script).not.toContain("bge-m3:latest");
      expect(script).not.toMatch(/ollama(Path)?\s+pull/i);
    }
  });

  it("downloads official signed app artifacts instead of executing remote scripts", () => {
    expect(macosScript).toContain(
      "https://ollama.com/download/Ollama-darwin.zip",
    );
    expect(macosScript).toContain("codesign --verify --deep --strict");
    expect(macosScript).toContain("spctl --assess --type execute");
    expect(macosScript).not.toContain("install.sh | sh");

    expect(windowsScript).toContain(
      "https://ollama.com/download/OllamaSetup.exe",
    );
    expect(windowsScript).toContain("Get-AuthenticodeSignature");
    expect(windowsScript).not.toContain("install.ps1 | iex");
    expect(ollamaProvider).not.toMatch(/install\.(sh|ps1)/);
  });

  it("reports success, cancellation and failure back to ZAIA", () => {
    for (const script of [macosScript, windowsScript]) {
      expect(script).toContain("setup-result.json");
      expect(script).toContain("success");
      expect(script).toContain("cancelled");
      expect(script).toContain("error");
    }
  });
});
