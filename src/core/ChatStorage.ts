export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * @deprecated Chatverläufe werden nicht mehr in Zotero-Notizen gespeichert.
 * Nutze stattdessen ChatRepository mit der lokalen ZAIA-SQLite-Datenbank.
 */
export class ChatStorage {
  static async saveChat(): Promise<void> {
    throw new Error(
      "ChatStorage ist veraltet. ZAIA speichert Chats lokal in SQLite.",
    );
  }
}
