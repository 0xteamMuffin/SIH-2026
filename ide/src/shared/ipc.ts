/**
 * The IPC contract.
 *
 * Every request/response channel is declared once in `IpcContract`. The main
 * process registers handlers through a helper keyed by this type and the
 * preload bridge invokes through the same type, so a renamed channel or a
 * changed payload is a compile error on both sides rather than a runtime
 * `undefined`.
 *
 * Main → renderer pushes go through a single `MAIN_EVENT_CHANNEL` carrying a
 * discriminated union. One channel keeps the preload surface small and means
 * new event types need no new plumbing.
 */

import type {
  BrowserPaneState,
  Chat,
  ChatId,
  ChatSummary,
  DataClassification,
  DocumentRef,
  Message,
  MessageId,
  PreviewCapabilities,
  SessionState,
  SpreadsheetModel,
  ViewBounds,
} from "./types.js";

export type IpcContract = {
  "chat:list": { request: void; response: ChatSummary[] };
  "chat:create": { request: void; response: Chat };
  "chat:get": { request: ChatId; response: Chat | null };
  "chat:rename": { request: { chatId: ChatId; title: string }; response: void };
  "chat:delete": { request: ChatId; response: void };
  /** Appends the user's turn and starts the agent. Resolves with the user message. */
  "chat:send": {
    request: {
      chatId: ChatId;
      prompt: string;
      attachments?: DocumentRef[];
      classification?: DataClassification;
    };
    response: Message;
  };
  /** Requests cancellation of the in-flight agent turn, if any. */
  "chat:cancel": { request: ChatId; response: void };

  "preview:capabilities": { request: void; response: PreviewCapabilities };

  "session:state": { request: void; response: SessionState };
  "session:connect": {
    request: { baseUrl: string; email: string; password: string };
    response: SessionState;
  };
  "session:disconnect": { request: void; response: SessionState };
  "session:select-workspace": { request: string; response: SessionState };

  /** Approves or rejects a high-risk tool the backend is waiting on. */
  "approval:decide": {
    request: { approvalId: string; decision: "APPROVED" | "REJECTED" };
    response: void;
  };

  /** Opens a native file picker. Resolves to `[]` if the user cancels. */
  "document:pick": { request: void; response: DocumentRef[] };
  /**
   * Raw bytes for a previously registered document.
   *
   * Keyed by document id rather than path: the renderer can only ask for
   * files the user has explicitly opened, so a compromised renderer cannot
   * name an arbitrary path on disk.
   */
  "document:read": { request: string; response: ArrayBuffer };
  /** Parsed workbook (XLSX or CSV) for a registered document. */
  "document:read-spreadsheet": { request: string; response: SpreadsheetModel };
  /**
   * Writes a document to a location the user chooses.
   *
   * Resolves to the saved path, or `null` if the save dialog was cancelled.
   */
  "document:save": { request: { documentId: string; filename: string }; response: string | null };

  /** Opens (or re-navigates) the embedded pane and shows it at `bounds`. */
  "browser:open": { request: { url: string; bounds: ViewBounds }; response: BrowserPaneState };
  /** Repositions the native view to track the renderer's placeholder element. */
  "browser:set-bounds": { request: ViewBounds; response: void };
  "browser:go-back": { request: void; response: void };
  "browser:go-forward": { request: void; response: void };
  "browser:reload": { request: void; response: void };
  "browser:close": { request: void; response: void };
  /** Hands the page off to the user's real browser. */
  "browser:open-external": { request: string; response: void };
};

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]["request"];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]["response"];

/** Single channel for every main → renderer push. */
export const MAIN_EVENT_CHANNEL = "workbench:event";

export type MainEvent =
  /** The chat list changed (created, renamed, deleted, or reordered). */
  | { type: "chat/list-changed"; chats: ChatSummary[] }
  /** A new message was appended to a thread. */
  | { type: "chat/message-appended"; chatId: ChatId; message: Message }
  /** An existing message's blocks were replaced — how streaming lands. */
  | { type: "chat/message-updated"; chatId: ChatId; messageId: MessageId; message: Message }
  /** An embedded browser pane changed navigation state. */
  | { type: "browser/state-changed"; state: BrowserPaneState }
  /** The backend connection changed. */
  | { type: "session/changed"; state: SessionState };

export type MainEventType = MainEvent["type"];
