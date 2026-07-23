import { describe, expect, it } from "vitest";
import { decidePromptContextRoute } from "../../src/core/PromptContextRouter";
import { createRouterChat, routerCandidates } from "./fixtures";

const baseRouterOptions = {
  provider: "ollama" as const,
  model: "qwen2.5:3b",
  candidates: routerCandidates,
};

/**
 * Verifies prompt routing corrections, heuristic fallbacks, and metadata filtering.
 */
describe("PromptContextRouter", () => {
  it("routes metadata-only questions to metadata even if the model suggests otherwise", async () => {
    const decision = await decidePromptContextRoute({
      ...baseRouterOptions,
      prompt: "Wie viele Paper habe ich?",
      chat: createRouterChat(
        '{"route":"single_paper","reason":"bad model decision","itemID":101}',
      ),
    });

    expect(decision.route).toBe("metadata");
    expect(decision.requestedFields).toContain("title");
  });

  it("routes library search questions to all_papers instead of single_paper", async () => {
    const decision = await decidePromptContextRoute({
      ...baseRouterOptions,
      prompt:
        "Welches Paper würde zu dem Thema AI im Marketing am ehesten passen?",
      chat: createRouterChat(
        '{"route":"single_paper","reason":"selected paper is active","itemID":202}',
      ),
    });

    expect(decision.route).toBe("all_papers");
    expect(decision.contentFocus).toBe("abstracts");
    expect(decision.itemID).toBeUndefined();
  });

  it("keeps single_paper for explicit selected-paper prompts", async () => {
    const decision = await decidePromptContextRoute({
      ...baseRouterOptions,
      prompt: "Fasse dieses Paper zusammen.",
      chat: createRouterChat(
        '{"route":"single_paper","reason":"current paper","itemID":101,"contentFocus":"abstracts"}',
      ),
    });

    expect(decision.route).toBe("single_paper");
    expect(decision.contentFocus).toBe("abstracts");
    expect(decision.itemID).toBe(101);
  });

  it("forces summaries of all papers to all_papers", async () => {
    const decision = await decidePromptContextRoute({
      ...baseRouterOptions,
      prompt: "Gib mir eine Zusammenfassung aller Paper.",
      chat: createRouterChat(
        '{"route":"single_paper","reason":"wrong","itemID":101}',
      ),
    });

    expect(decision.route).toBe("all_papers");
    expect(decision.contentFocus).toBe("abstracts");
  });

  it("falls back to a heuristic decision when the router returns no JSON", async () => {
    const decision = await decidePromptContextRoute({
      ...baseRouterOptions,
      prompt: "Gib mir die Titel der Paper.",
      chat: createRouterChat("Ich würde Metadaten nehmen."),
    });

    expect(decision.route).toBe("metadata");
    expect(decision.confidence).toBe(0.7);
  });

  it("only passes the selected metadata fields to the router model", async () => {
    let userMessage = "";

    await decidePromptContextRoute({
      ...baseRouterOptions,
      prompt: "Gib mir die Titel der Paper.",
      metadataFields: ["title"],
      chat: async (messages) => {
        userMessage = messages.find((message) => message.role === "user")
          ?.content as string;
        return {
          content: '{"route":"metadata","reason":"titles","confidence":0.9}',
        };
      },
    });

    expect(userMessage).toContain('title="Past, present and future');
    expect(userMessage).not.toContain('author="Kumar et al."');
    expect(userMessage).not.toContain('tags="AI, Marketing"');
  });
});
