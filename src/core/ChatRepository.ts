import {
  AppendChatMessageInput,
  CreateChatInput,
  StoredChat,
  StoredChatMessage,
  StoredChatWithMessages,
} from "./chatTypes";
import { getChatDatabase } from "../persistence/ChatDatabase";

type ChatRow = {
  id: string;
  title: string;
  zotero_library_id: number | null;
  zotero_item_key: string | null;
  created_at: string;
  updated_at: string;
  is_favorite: number;
};

type MessageRow = {
  id: string;
  chat_id: string;
  role: StoredChatMessage["role"];
  content: string;
  position: number;
  created_at: string;
};

export class ChatRepository {
  static async createChat(input: CreateChatInput = {}) {
    const db = await getChatDatabase();
    const now = nowISO();
    const chat = {
      id: createID("chat"),
      title: input.title?.trim() ?? "",
      zoteroLibraryID: input.zoteroLibraryID ?? null,
      zoteroItemKey: input.zoteroItemKey ?? null,
      createdAt: now,
      updatedAt: now,
      isFavorite: Boolean(input.isFavorite),
    } satisfies StoredChat;

    await db.queryAsync(
      `
      INSERT INTO chats (
        id,
        title,
        zotero_library_id,
        zotero_item_key,
        created_at,
        updated_at,
        is_favorite
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        chat.id,
        chat.title,
        chat.zoteroLibraryID,
        chat.zoteroItemKey,
        chat.createdAt,
        chat.updatedAt,
        chat.isFavorite ? 1 : 0,
      ],
    );

    return chat;
  }

  static async listChats(limit?: number) {
    const db = await getChatDatabase();
    const normalizedLimit = normalizeLimit(limit);
    const rows = (await db.queryAsync(
      "SELECT id, title, zotero_library_id, zotero_item_key, updated_at, is_favorite FROM chats",
    )) as
      | Array<
          Pick<
            ChatRow,
            | "id"
            | "title"
            | "zotero_library_id"
            | "zotero_item_key"
            | "updated_at"
            | "is_favorite"
          >
        >
      | undefined;

    const chats = await Promise.all(
      (rows ?? []).map((row) => mapChatListRow(db, row)),
    );

    const sortedChats = chats.sort(sortChatsByUpdatedAtDesc);
    return normalizedLimit
      ? sortedChats.slice(0, normalizedLimit)
      : sortedChats;
  }

  static async getChatWithMessages(chatID: string) {
    const db = await getChatDatabase();
    const chatRows = (await db.queryAsync(
      "SELECT id, title, zotero_library_id, zotero_item_key, updated_at, is_favorite FROM chats WHERE id = ?",
      [chatID],
    )) as
      | Array<
          Pick<
            ChatRow,
            | "id"
            | "title"
            | "zotero_library_id"
            | "zotero_item_key"
            | "updated_at"
            | "is_favorite"
          >
        >
      | undefined;
    const chat = chatRows?.[0];

    if (!chat) return null;
    const createdAt = await getChatCreatedAt(db, chat.id, chat.updated_at);

    const messageRows = (await db.queryAsync(
      "SELECT id, chat_id, role, content, position, created_at FROM messages",
    )) as MessageRow[] | undefined;

    return {
      ...mapChatRow({
        id: chat.id,
        title: chat.title,
        created_at: createdAt,
        updated_at: chat.updated_at,
        zotero_library_id: chat.zotero_library_id,
        zotero_item_key: chat.zotero_item_key,
        is_favorite: chat.is_favorite,
      }),
      messages: (messageRows ?? [])
        .filter((row) => row.chat_id === chatID)
        .map(mapMessageRow)
        .sort(sortMessagesByPositionAsc),
    } satisfies StoredChatWithMessages;
  }

  static async appendMessage(input: AppendChatMessageInput) {
    const db = await getChatDatabase();
    const createdAt = input.createdAt ?? nowISO();
    const nextPosition = await db.valueQueryAsync<number>(
      "SELECT COALESCE(MAX(position), -1) + 1 FROM messages WHERE chat_id = ?",
      [input.chatId],
    );
    const position =
      input.position ?? (typeof nextPosition === "number" ? nextPosition : 0);
    const message = {
      id: input.id ?? createID("msg"),
      chatId: input.chatId,
      role: input.role,
      content: input.content,
      position,
      createdAt,
    } satisfies StoredChatMessage;

    await db.executeTransaction(async () => {
      await db.queryAsync(
        `
        INSERT INTO messages (id, chat_id, role, content, position, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          message.id,
          message.chatId,
          message.role,
          message.content,
          message.position,
          message.createdAt,
        ],
      );
      await db.queryAsync("UPDATE chats SET updated_at = ? WHERE id = ?", [
        message.createdAt,
        message.chatId,
      ]);
    });

    return message;
  }

  static async updateChatTitle(chatID: string, title: string) {
    const db = await getChatDatabase();
    const updatedAt = nowISO();

    await db.queryAsync(
      "UPDATE chats SET title = ?, updated_at = ? WHERE id = ?",
      [title.trim(), updatedAt, chatID],
    );
  }

  static async deleteChat(chatID: string) {
    const db = await getChatDatabase();

    await db.queryAsync("DELETE FROM chats WHERE id = ?", [chatID]);
  }

  static async updateChatFavorite(chatID: string, isFavorite: boolean) {
    const db = await getChatDatabase();

    await db.queryAsync("UPDATE chats SET is_favorite = ? WHERE id = ?", [
      isFavorite ? 1 : 0,
      chatID,
    ]);
  }

  static async deleteOldUnfavoriteChats(maxAgeDays: number, now = new Date()) {
    const db = await getChatDatabase();
    const cutoffTime = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(cutoffTime)) return 0;

    const rows = (await db.queryAsync(
      "SELECT id, updated_at, is_favorite FROM chats",
    )) as Array<Pick<ChatRow, "id" | "updated_at" | "is_favorite">> | undefined;
    const chatIDs = (rows ?? [])
      .filter((row) => {
        return (
          !isFavoriteValue(row.is_favorite) &&
          isOlderThan(row.updated_at, cutoffTime)
        );
      })
      .map((row) => row.id);

    if (!chatIDs.length) return 0;

    await db.executeTransaction(async () => {
      for (const chatID of chatIDs) {
        await db.queryAsync("DELETE FROM chats WHERE id = ?", [chatID]);
      }
    });

    return chatIDs.length;
  }
}

async function mapChatListRow(
  db: _ZoteroTypes.DB,
  row: Pick<
    ChatRow,
    | "id"
    | "title"
    | "zotero_library_id"
    | "zotero_item_key"
    | "updated_at"
    | "is_favorite"
  >,
) {
  const createdAt = await getChatCreatedAt(db, row.id, row.updated_at);

  return mapChatRow({
    id: row.id,
    title: row.title,
    created_at: createdAt,
    updated_at: row.updated_at,
    zotero_library_id: row.zotero_library_id,
    zotero_item_key: row.zotero_item_key,
    is_favorite: row.is_favorite,
  });
}

function mapChatRow(row: ChatRow): StoredChat {
  return {
    id: row.id,
    title: row.title,
    zoteroLibraryID: row.zotero_library_id,
    zoteroItemKey: row.zotero_item_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isFavorite: isFavoriteValue(row.is_favorite),
  };
}

function mapMessageRow(row: MessageRow): StoredChatMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    position: row.position,
    createdAt: row.created_at,
  };
}

function nowISO() {
  return new Date().toISOString();
}

async function getChatCreatedAt(
  db: _ZoteroTypes.DB,
  chatID: string,
  fallback: string,
) {
  try {
    const createdAt = await db.valueQueryAsync<string>(
      "SELECT created_at FROM chats WHERE id = ?",
      [chatID],
    );

    return typeof createdAt === "string" && createdAt ? createdAt : fallback;
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    return fallback;
  }
}

function sortChatsByUpdatedAtDesc(a: StoredChat, b: StoredChat) {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function sortMessagesByPositionAsc(a: StoredChatMessage, b: StoredChatMessage) {
  if (a.position !== b.position) {
    return a.position - b.position;
  }

  return a.createdAt.localeCompare(b.createdAt);
}

function isOlderThan(value: string, cutoffTime: number) {
  const updatedAt = Date.parse(value);
  return Number.isFinite(updatedAt) && updatedAt < cutoffTime;
}

function isFavoriteValue(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function normalizeLimit(limit?: number) {
  if (limit === undefined || !Number.isFinite(limit)) return null;

  return Math.max(1, Math.min(1000, Math.floor(limit)));
}

function createID(prefix: string) {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2)}`;
}
