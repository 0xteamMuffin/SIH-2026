import { randomUUID } from "node:crypto";

import type {
  Chat,
  ChatId,
  ChatSummary,
  DocumentRef,
  Message,
  MessageBlock,
} from "@shared/types.js";

import type { EventBroadcaster } from "../events.js";
import type { AgentGateway } from "./agent-gateway.js";
import type { ChatStore } from "./chat-store.js";

/**
 * Orchestrates a conversation: records turns, drives the agent, and pushes
 * updates to the renderer.
 *
 * The renderer never polls. It calls `send` and then renders whatever arrives
 * on the event channel, which keeps the UI identical whether replies come from
 * the scripted stand-in or a slow streaming backend.
 */
export class ChatService {
  readonly #store: ChatStore;
  readonly #agent: AgentGateway;
  readonly #events: EventBroadcaster;

  /** In-flight turns, so a second send or a cancel can interrupt the first. */
  readonly #inFlight = new Map<ChatId, AbortController>();

  constructor(store: ChatStore, agent: AgentGateway, events: EventBroadcaster) {
    this.#store = store;
    this.#agent = agent;
    this.#events = events;
  }

  list(): ChatSummary[] {
    return this.#store.list();
  }

  get(chatId: ChatId): Chat | null {
    return this.#store.get(chatId);
  }

  create(): Chat {
    const chat = this.#store.create();
    this.#emitListChanged();
    return chat;
  }

  rename(chatId: ChatId, title: string): void {
    this.#store.rename(chatId, title);
    this.#emitListChanged();
  }

  delete(chatId: ChatId): void {
    this.cancel(chatId);
    this.#store.delete(chatId);
    this.#emitListChanged();
  }

  /**
   * Records the user's turn, returns it immediately so the UI can paint, then
   * runs the agent in the background. Any turn already running on this chat is
   * cancelled first — a new prompt supersedes the old one.
   */
  send(chatId: ChatId, prompt: string, attachments: DocumentRef[] = []): Message {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error("Cannot send an empty prompt");

    this.cancel(chatId);

    const blocks: MessageBlock[] = [{ kind: "text", text: trimmed }];
    for (const document of attachments) {
      blocks.push({ kind: "document", document });
    }

    const userMessage = this.#store.appendMessage(chatId, {
      id: randomUUID(),
      chatId,
      role: "user",
      createdAt: new Date().toISOString(),
      blocks,
    });

    this.#events.emit({ type: "chat/message-appended", chatId, message: userMessage });
    this.#emitListChanged();

    void this.#runAgentTurn(chatId, trimmed);
    return userMessage;
  }

  /** Aborts the in-flight turn for a chat, if there is one. */
  cancel(chatId: ChatId): void {
    const controller = this.#inFlight.get(chatId);
    if (!controller) return;
    this.#inFlight.delete(chatId);
    controller.abort();
  }

  /** Aborts every in-flight turn. Call on quit. */
  cancelAll(): void {
    for (const chatId of [...this.#inFlight.keys()]) this.cancel(chatId);
  }

  async #runAgentTurn(chatId: ChatId, prompt: string): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.set(chatId, controller);

    // The reply message is created up front and empty, so every subsequent
    // update is an edit to a message the UI already has on screen.
    const reply = this.#store.appendMessage(chatId, {
      id: randomUUID(),
      chatId,
      role: "agent",
      createdAt: new Date().toISOString(),
      blocks: [],
    });
    this.#events.emit({ type: "chat/message-appended", chatId, message: reply });

    const publish = (blocks: MessageBlock[]): void => {
      const updated = this.#store.replaceBlocks(chatId, reply.id, blocks);
      if (!updated) return; // Chat was deleted mid-turn.
      this.#events.emit({
        type: "chat/message-updated",
        chatId,
        messageId: reply.id,
        message: updated,
      });
    };

    try {
      await this.#agent.runTurn({ chatId, prompt, signal: controller.signal, publish });
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("[chat-service] agent turn failed", error);
        publish([{ kind: "status", state: "failed", label: "Failed", detail: describe(error) }]);
      }
    } finally {
      if (this.#inFlight.get(chatId) === controller) this.#inFlight.delete(chatId);
      this.#emitListChanged();
    }
  }

  #emitListChanged(): void {
    this.#events.emit({ type: "chat/list-changed", chats: this.#store.list() });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
