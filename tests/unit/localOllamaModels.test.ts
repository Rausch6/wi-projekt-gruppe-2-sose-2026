import { describe, expect, it } from "vitest";
import { getSelectableLocalModelValues } from "../../src/ui/localOllamaModels";

/**
 * Verifies filtering of locally installed Ollama models for UI selection.
 */
describe("local Ollama model selection", () => {
  it("contains only installed chat models", () => {
    expect(
      getSelectableLocalModelValues([
        "qwen2.5:7b",
        "bge-m3:latest",
        "qwen2.5:14b",
      ]),
    ).toEqual(["qwen2.5:7b", "qwen2.5:14b"]);
  });

  it("does not add a configured but missing model", () => {
    expect(getSelectableLocalModelValues(["qwen2.5:7b"])).not.toContain(
      "qwen2.5:32b",
    );
  });
});
