import type { ChatService } from "../services/chat-service.js";
import { handle } from "./typed-handle.js";

export function registerChatHandlers(chats: ChatService): void {
  handle("chat:list", () => chats.list());
  handle("chat:create", () => chats.create());
  handle("chat:get", (chatId) => chats.get(chatId));
  handle("chat:rename", ({ chatId, title }) => chats.rename(chatId, title));
  handle("chat:delete", (chatId) => chats.delete(chatId));
  handle("chat:send", ({ chatId, prompt, attachments, classification }) =>
    chats.send(chatId, prompt, attachments, classification),
  );
  handle("chat:cancel", (chatId) => chats.cancel(chatId));
}
