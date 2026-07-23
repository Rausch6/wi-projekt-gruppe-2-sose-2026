/**
 * Display metadata for a downloadable Ollama chat model.
 */
export type LocalOllamaModelCatalogEntry = {
  id: string;
  size: string;
};

/**
 * Curated local chat models offered by the model management window.
 */
export const LOCAL_OLLAMA_MODEL_CATALOG: LocalOllamaModelCatalogEntry[] = [
  { id: "qwen2.5:7b", size: "4.7 GB" },
  { id: "qwen2.5:14b", size: "9.0 GB" },
  { id: "qwen2.5:32b", size: "20 GB" },
  { id: "qwen2.5:72b", size: "47 GB" },
];

/**
 * Normalizes installed model IDs and removes embedding-only models.
 *
 * @param installedModelIds - Raw model identifiers reported by Ollama.
 * @returns Unique chat-model identifiers in natural alphabetical order.
 */
export function getSelectableLocalModelValues(installedModelIds: string[]) {
  return [
    ...new Set(installedModelIds.map((model) => model.trim()).filter(Boolean)),
  ]
    .filter((model) => !isEmbeddingModel(model))
    .sort((first, second) =>
      first.localeCompare(second, undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
}

/**
 * Detects model identifiers intended for vector embeddings rather than chat.
 *
 * @param model - Ollama model identifier to classify.
 * @returns True when the identifier represents an embedding model.
 */
function isEmbeddingModel(model: string) {
  return (
    model.toLowerCase() === "bge-m3:latest" ||
    /(^|[-_/.:])embed(?:ding)?($|[-_/.:])/i.test(model)
  );
}
