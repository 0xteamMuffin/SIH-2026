import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Chat, ChatId, ChatSummary, Message, MessageId } from "@shared/types.js";

/** How long to coalesce rapid mutations before touching disk. */
const PERSIST_DEBOUNCE_MS = 250;

/** Longest auto-derived chat title, in characters. */
const TITLE_MAX_LENGTH = 60;

const STORE_FILE = "chats.json";
const STORE_VERSION = 1;

interface PersistedStore {
  version: number;
  chats: Chat[];
}

/**
 * Chat history, held in memory and mirrored to a JSON file.
 *
 * This is deliberately the simplest thing that survives a restart. Chats are
 * conversation *scaffolding*, not the system of record — the on-prem backend
 * owns runs, evidence, and artifacts — so there is no need for a database
 * here. Writes are debounced and atomic (temp file + rename) so a crash
 * mid-write cannot truncate existing history.
 */
export class ChatStore {
  readonly #filePath: string;
  readonly #chats = new Map<ChatId, Chat>();

  #persistTimer: NodeJS.Timeout | null = null;
  #persistChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.#filePath = filePath;
  }

  /**
   * Loads history from `directory`, tolerating a missing or corrupt file: a
   * damaged store degrades to an empty history rather than blocking startup.
   */
  static async open(directory: string): Promise<ChatStore> {
    const store = new ChatStore(join(directory, STORE_FILE));
    await store.#load();
    return store;
  }

  list(): ChatSummary[] {
    return [...this.#chats.values()]
      .map(toSummary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(chatId: ChatId): Chat | null {
    const chat = this.#chats.get(chatId);
    return chat ? structuredClone(chat) : null;
  }

  create(): Chat {
    const now = new Date().toISOString();
    const chat: Chat = {
      id: randomUUID(),
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
    };
    this.#chats.set(chat.id, chat);
    this.#schedulePersist();
    return structuredClone(chat);
  }

  rename(chatId: ChatId, title: string): void {
    const chat = this.#require(chatId);
    const trimmed = title.trim();
    if (!trimmed) return;
    chat.title = truncateTitle(trimmed);
    chat.updatedAt = new Date().toISOString();
    this.#schedulePersist();
  }

  /** Backend workspace this chat's turns belong to, if it has run one. */
  workspaceFor(chatId: ChatId): string | undefined {
    return this.#chats.get(chatId)?.workspaceId;
  }

  /**
   * Fixes the chat to a workspace on its first turn.
   *
   * Deliberately write-once. A chat's turns have to stay together for the
   * backend to find the thread's earlier answers, so a later change to the
   * session's selected workspace must not drag an existing chat along with it.
   * `updatedAt` is left alone because this is bookkeeping, not activity, and
   * should not reorder the sidebar.
   */
  bindWorkspace(chatId: ChatId, workspaceId: string): void {
    const chat = this.#require(chatId);
    if (chat.workspaceId) return;
    chat.workspaceId = workspaceId;
    this.#schedulePersist();
  }

  delete(chatId: ChatId): void {
    if (this.#chats.delete(chatId)) this.#schedulePersist();
  }

  /**
   * Appends a message and returns the stored copy. The first user message also
   * names the chat, which is why titling lives here rather than in the UI.
   */
  appendMessage(chatId: ChatId, message: Message): Message {
    const chat = this.#require(chatId);
    const stored = structuredClone(message);

    if (chat.messages.length === 0 && stored.role === "user") {
      chat.title = deriveTitle(stored);
    }

    chat.messages.push(stored);
    chat.messageCount = chat.messages.length;
    chat.updatedAt = stored.createdAt;
    this.#schedulePersist();
    return structuredClone(stored);
  }

  /**
   * Replaces a message's content in place. Returns the updated message, or
   * `null` if it has since been deleted — which happens routinely when a chat
   * is removed while its agent turn is still streaming.
   */
  replaceContent(
    chatId: ChatId,
    messageId: MessageId,
    blocks: Message["blocks"],
    trace?: Message["trace"],
  ): Message | null {
    const chat = this.#chats.get(chatId);
    const message = chat?.messages.find((candidate) => candidate.id === messageId);
    if (!chat || !message) return null;

    message.blocks = structuredClone(blocks);
    // A later publish without a trace must not erase one already recorded.
    if (trace) message.trace = structuredClone(trace);
    chat.updatedAt = new Date().toISOString();
    this.#schedulePersist();
    return structuredClone(message);
  }

  /** Flushes any pending write. Call before quitting. */
  async flush(): Promise<void> {
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
      this.#enqueuePersist();
    }
    await this.#persistChain;
  }

  #require(chatId: ChatId): Chat {
    const chat = this.#chats.get(chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);
    return chat;
  }

  async #load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch {
      return; // No history yet — a first run.
    }

    try {
      const parsed = JSON.parse(raw) as PersistedStore;
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.chats)) return;
      for (const chat of parsed.chats) {
        this.#chats.set(chat.id, chat);
      }
    } catch (error) {
      console.error("[chat-store] ignoring unreadable history file", error);
    }
  }

  #schedulePersist(): void {
    if (this.#persistTimer) clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.#enqueuePersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Serialises writes so two flushes can never interleave on the same file. */
  #enqueuePersist(): void {
    this.#persistChain = this.#persistChain.then(() => this.#write()).catch((error: unknown) => {
      console.error("[chat-store] failed to persist history", error);
    });
  }

  async #write(): Promise<void> {
    const payload: PersistedStore = { version: STORE_VERSION, chats: [...this.#chats.values()] };
    const temporaryPath = `${this.#filePath}.tmp`;

    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(payload), "utf8");
    await rename(temporaryPath, this.#filePath);
  }
}

function toSummary(chat: Chat): ChatSummary {
  const { messages: _messages, ...summary } = chat;
  return summary;
}

/** Uses the first line of the opening prompt, the way ChatGPT names threads. */
function deriveTitle(message: Message): string {
  const text = message.blocks.find((block) => block.kind === "text")?.text ?? "";
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  return firstLine ? truncateTitle(firstLine) : "New chat";
}

function truncateTitle(title: string): string {
  return title.length <= TITLE_MAX_LENGTH ? title : `${title.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}
