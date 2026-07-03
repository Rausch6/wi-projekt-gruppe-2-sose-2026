export type StoredChatMessageRole = "user" | "assistant" | "system";

export type StoredChat = {
  id: string;
  title: string;
  zoteroLibraryID: number | null;
  zoteroItemKey: string | null;
  createdAt: string;
  updatedAt: string;
  isFavorite: boolean;
};

export type StoredChatMessage = {
  id: string;
  chatId: string;
  role: StoredChatMessageRole;
  content: string;
  position: number;
  createdAt: string;
  tokenUsage?: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
};

export type StoredChatWithMessages = StoredChat & {
  messages: StoredChatMessage[];
};

export type CreateChatInput = {
  title?: string;
  zoteroLibraryID?: number | null;
  zoteroItemKey?: string | null;
  isFavorite?: boolean;
};

export type AppendChatMessageInput = {
  id?: string;
  chatId: string;
  role: StoredChatMessageRole;
  content: string;
  position?: number;
  createdAt?: string;
  tokenUsage?: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
};
