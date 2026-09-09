import type { BrowserPane } from "../services/browser-pane.js";
import type { ChatService } from "../services/chat-service.js";
import type { DocumentLibrary } from "../services/document-library.js";
import type { SessionManager } from "../services/session.js";
import { registerBrowserHandlers } from "./browser.js";
import { registerChatHandlers } from "./chat.js";
import { registerDocumentHandlers } from "./document.js";
import { registerGovernanceHandlers } from "./governance.js";
import { registerPreviewHandlers } from "./preview.js";
import { registerSessionHandlers } from "./session.js";

export interface IpcDependencies {
  chats: ChatService;
  documents: DocumentLibrary;
  session: SessionManager;
  browserPane: BrowserPane;
}

/**
 * Registers every IPC handler exactly once at startup.
 *
 * Electron throws when a channel is handled twice, so this must not be called
 * per-window — handlers are process-wide and outlive individual windows.
 */
export function registerIpcHandlers({ chats, documents, session, browserPane }: IpcDependencies): void {
  registerChatHandlers(chats);
  registerSessionHandlers(session);
  registerPreviewHandlers();
  registerDocumentHandlers(documents, session);
  registerBrowserHandlers(browserPane);
  registerGovernanceHandlers(session);
}
