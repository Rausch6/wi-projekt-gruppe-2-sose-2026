export type LocalOllamaModelCatalogEntry = {
  id: string;
  size: string;
};

export const LOCAL_OLLAMA_MODEL_CATALOG: LocalOllamaModelCatalogEntry[] = [
  { id: "qwen2.5:7b", size: "4.7 GB" },
  { id: "qwen2.5:14b", size: "9.0 GB" },
  { id: "qwen2.5:32b", size: "20 GB" },
  { id: "qwen2.5:72b", size: "47 GB" },
];
