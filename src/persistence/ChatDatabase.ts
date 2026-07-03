/// <reference types="zotero-types" />

const DATABASE_DIR_NAME = "zaia";
const DATABASE_FILE_NAME = "zaia-chats.sqlite";
const SCHEMA_VERSION = 3;

let connection: _ZoteroTypes.DB | null = null;
let initializationPromise: Promise<_ZoteroTypes.DB> | null = null;

export async function initializeChatDatabase() {
  if (connection) {
    return connection;
  }

  if (!initializationPromise) {
    initializationPromise = openChatDatabase();
  }

  try {
    connection = await initializationPromise;
    return connection;
  } catch (error) {
    initializationPromise = null;
    throw error;
  }
}

export async function getChatDatabase() {
  return initializeChatDatabase();
}

export async function closeChatDatabase() {
  if (!connection) {
    initializationPromise = null;
    return;
  }

  await connection.closeDatabase(false);
  connection = null;
  initializationPromise = null;
}

export async function getChatDatabasePath() {
  const dirPath = await ensureChatDatabaseDirectory();
  return PathUtils.join(dirPath, DATABASE_FILE_NAME);
}

async function openChatDatabase() {
  const dbPath = await getChatDatabasePath();
  const db = new Zotero.DBConnection(dbPath);

  await db.queryAsync("PRAGMA foreign_keys = ON");
  await migrate(db);

  return db;
}

async function ensureChatDatabaseDirectory() {
  const zoteroDir = Zotero.DataDirectory.dir;
  const dbDir = PathUtils.join(zoteroDir, DATABASE_DIR_NAME);

  await IOUtils.makeDirectory(dbDir, {
    createAncestors: true,
    ignoreExisting: true,
  });

  return dbDir;
}

async function migrate(db: _ZoteroTypes.DB) {
  let version = await getSchemaVersion(db);

  if (version < 1) {
    await db.executeTransaction(async () => {
      await db.queryAsync(`
        CREATE TABLE IF NOT EXISTS chats (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          zotero_library_id INTEGER,
          zotero_item_key TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      await db.queryAsync(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          position INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        )
      `);

      await db.queryAsync(`
        CREATE INDEX IF NOT EXISTS idx_chats_updated_at
        ON chats(updated_at)
      `);
      await db.queryAsync(`
        CREATE INDEX IF NOT EXISTS idx_chats_item
        ON chats(zotero_library_id, zotero_item_key)
      `);
      await db.queryAsync(`
        CREATE INDEX IF NOT EXISTS idx_messages_chat_position
        ON messages(chat_id, position)
      `);
      await db.queryAsync("PRAGMA user_version = 1");
    });
    version = 1;
  }

  if (version < 2) {
    await db.executeTransaction(async () => {
      if (!(await hasColumn(db, "chats", "is_favorite"))) {
        await db.queryAsync(`
          ALTER TABLE chats
          ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0
        `);
      }

      await db.queryAsync(`PRAGMA user_version = 2`);
    });
    version = 2;
  }

  if (version < 3) {
    await db.executeTransaction(async () => {
      if (!(await hasColumn(db, "messages", "prompt_tokens"))) {
        await db.queryAsync(`
          ALTER TABLE messages
          ADD COLUMN prompt_tokens INTEGER
        `);
      }
      if (!(await hasColumn(db, "messages", "completion_tokens"))) {
        await db.queryAsync(`
          ALTER TABLE messages
          ADD COLUMN completion_tokens INTEGER
        `);
      }
      if (!(await hasColumn(db, "messages", "total_tokens"))) {
        await db.queryAsync(`
          ALTER TABLE messages
          ADD COLUMN total_tokens INTEGER
        `);
      }

      await db.queryAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
    version = 3;
  }
}

async function getSchemaVersion(db: _ZoteroTypes.DB) {
  const rows = await db.queryAsync("PRAGMA user_version");
  const row = rows?.[0] as { user_version?: unknown } | undefined;
  const version = row?.user_version;

  return typeof version === "number" ? version : 0;
}

async function hasColumn(db: _ZoteroTypes.DB, table: string, column: string) {
  const rows = (await db.queryAsync(`PRAGMA table_info(${table})`)) as
    | Array<{ name?: unknown }>
    | undefined;

  return (rows ?? []).some((row) => row.name === column);
}
