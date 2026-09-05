import type { BrowserPane } from "../services/browser-pane.js";
import type { ChatService } from "../services/chat-service.js";
import type { DocumentLibrary } from "../services/document-library.js";
import { registerBrowserHandlers } from "./browser.js";
import { registerChatHandlers } from "./chat.js";
import { registerDocumentHandlers } from "./document.js";
import { registerPreviewHandlers } from "./preview.js";

export interface IpcDependencies {
  chats: ChatService;
  documents: DocumentLibrary;
  browserPane: BrowserPane;
}

/**
 * Registers every IPC handler exactly once at startup.
 *
 * Electron throws when a channel is handled twice, so this must not be called
 * per-window — handlers are process-wide and outlive individual windows.
 */
export function registerIpcHandlers({ chats, documents, browserPane }: IpcDependencies): void {
  registerChatHandlers(chats);
  registerPreviewHandlers();
  registerDocumentHandlers(documents);
  registerBrowserHandlers(browserPane);
}
