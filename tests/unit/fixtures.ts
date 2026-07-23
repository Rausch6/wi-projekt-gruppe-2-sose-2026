import type { PromptContextRouterCandidate } from "../../src/core/PromptContextRouter";

/**
 * Shared prompt-router candidates used by router-focused tests.
 */
export const routerCandidates: PromptContextRouterCandidate[] = [
  {
    itemID: 101,
    title:
      "Past, present and future of AI in marketing and knowledge management",
    firstCreator: "Kumar et al.",
    year: "2024",
    publicationDate: "2024",
    publicationTitle: "Journal of Marketing Analytics",
    publisher: "",
    doi: "10.1000/marketing-ai",
    isbn: "",
    url: "https://example.test/marketing-ai",
    abstractNote: "A review of AI applications in marketing and KM.",
    dateAdded: "2026-01-10",
    dateModified: "2026-06-01",
    itemType: "journalArticle",
    tags: ["AI", "Marketing"],
    libraryName: "SDT Profis",
  },
  {
    itemID: 202,
    title: "Role of artificial intelligence in knowledge management",
    firstCreator: "Singh et al.",
    year: "2023",
    publicationDate: "2023",
    publicationTitle: "Knowledge Management Research",
    publisher: "",
    doi: "",
    isbn: "",
    url: "",
    abstractNote: "Empirical study about AI in knowledge management.",
    dateAdded: "2026-01-11",
    dateModified: "2026-06-02",
    itemType: "journalArticle",
    tags: ["AI", "Knowledge Management"],
    libraryName: "Meine Bibliothek",
  },
];

/**
 * Creates a router chat mock that returns fixed content.
 *
 * @param content - Assistant response content returned by the mock chat function.
 * @returns Async chat function compatible with the prompt router.
 */
export function createRouterChat(content: string) {
  return async () => ({ content });
}
