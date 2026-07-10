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

describe("Ollama setup scripts", () => {
  it.each([
    ["macOS", macosScript],
    ["Windows", windowsScript],
  ])("supports the same setup modes and model defaults on %s", (_, script) => {
    expect(script).toContain("embedding");
    expect(script).toContain("local-with-embedding");
    expect(script).toContain("qwen2.5:3b");
    expect(script).toContain("bge-m3:latest");
  });

  it("keeps chat and embedding downloads independently selectable", () => {
    expect(macosScript).toContain('if [ "$INSTALL_CHAT_MODEL" = true ]');
    expect(macosScript).toContain('if [ "$INSTALL_EMBEDDING_MODEL" = true ]');
    expect(windowsScript).toContain("if ($InstallChatModel)");
    expect(windowsScript).toContain("if ($InstallEmbeddingModel)");
  });
});
