/**
 * The shape of the preload bridge.
 *
 * Declared here, in shared code, rather than inferred from the preload module:
 * the renderer compiles without Node or Electron types, so importing the
 * preload implementation's type would drag those into the browser build. With
 * the interface stated independently, the preload asserts that it implements
 * it and the renderer consumes it — neither depends on the other's context.
 */

import type { MainEvent } from "./ipc.js";
import type {
  BrowserPaneState,
  Chat,
  ChatId,
  ChatSummary,
  DocumentRef,
  Message,
  PreviewCapabilities,
  SpreadsheetModel,
  ViewBounds,
} from "./types.js";

export interface ChatApi {
  list(): Promise<ChatSummary[]>;
  create(): Promise<Chat>;
  get(chatId: ChatId): Promise<Chat | null>;
  rename(chatId: ChatId, title: string): Promise<void>;
  remove(chatId: ChatId): Promise<void>;
  /** Records the prompt and starts the agent; replies arrive via `onEvent`. */
  send(chatId: ChatId, prompt: string, attachments?: DocumentRef[]): Promise<Message>;
  cancel(chatId: ChatId): Promise<void>;
}

export interface PreviewApi {
  capabilities(): Promise<PreviewCapabilities>;
}

export interface DocumentApi {
  /** Opens a native file picker. Resolves to `[]` if the user cancels. */
  pick(): Promise<DocumentRef[]>;
  read(documentId: string): Promise<ArrayBuffer>;
  readSpreadsheet(documentId: string): Promise<SpreadsheetModel>;
}

export interface BrowserApi {
  open(url: string, bounds: ViewBounds): Promise<BrowserPaneState>;
  /** Keeps the native view aligned with the renderer's placeholder element. */
  setBounds(bounds: ViewBounds): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  openExternal(url: string): Promise<void>;
}

export interface WorkbenchApi {
  readonly chat: ChatApi;
  readonly preview: PreviewApi;
  readonly documents: DocumentApi;
  readonly browser: BrowserApi;
  /** Subscribes to main-process events. Returns an unsubscribe function. */
  onEvent(listener: (event: MainEvent) => void): () => void;
}
