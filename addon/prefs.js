/* eslint-disable no-undef */
pref("provider", "kisski");
pref("apiKey", "");
pref("baseUrl", "https://chat-ai.academiccloud.de/v1");
pref("model", "deepseek-r1-distill-llama-70b");
pref("sendPaperContextToKisski", true);
pref("contextRouterProvider", "ollama");
pref("embeddingSearchEnabled", true);
pref("embeddingModel", "bge-m3:latest");
pref("ollamaBaseUrl", "http://localhost:11434");
pref("ollamaModel", "qwen2.5:3b");
pref("maxItems", 200);
pref("metadataFieldSelection", "title,creators,publicationDate");
pref("autoDeleteOldChats", true);
pref("chunkTargetTokens", 512);
pref("chunkOverlapTokens", 100);
pref("chunkCount", 3);
