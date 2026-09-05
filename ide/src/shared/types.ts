/**
 * Domain types shared by the main process, the preload bridge, and the renderer.
 *
 * These describe the *client-side* view of a conversation with the agent. The
 * on-prem backend owns the real data; the IDE only ever holds a projection of
 * it, so every type here is plain JSON that survives structured cloning across
 * the IPC boundary.
 */

export type ChatId = string;
export type MessageId = string;

/** Who authored a message in a thread. */
export type MessageRole = "user" | "agent";

/**
 * Lifecycle of an agent turn. Mirrors the backend `Run` status vocabulary so
 * the two never drift into different words for the same state.
 */
export type RunState =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "cancelled";

/** Terminal states — no further updates will arrive for the turn. */
export const TERMINAL_RUN_STATES: readonly RunState[] = ["completed", "failed", "cancelled"];

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

// ─── Message content ─────────────────────────────────────────────────────────
//
// An agent turn is not a string. It is an ordered list of blocks, because one
// answer can mix prose, a code diff, a spreadsheet preview, and a browser
// session. Rendering is a pure function of this list, which keeps the renderer
// dumb and makes new capabilities additive: add a block kind, add a component.

export type MessageBlock =
  | TextBlock
  | StatusBlock
  | ToolCallBlock
  | ApprovalBlock
  | DiffBlock
  | DocumentBlock
  | BrowserBlock;

export type MessageBlockKind = MessageBlock["kind"];

/** Prose. `text` is Markdown source, rendered by the renderer. */
export interface TextBlock {
  kind: "text";
  text: string;
}

/** Progress or failure of the turn itself ("Reading 4 files…", "Failed"). */
export interface StatusBlock {
  kind: "status";
  state: RunState;
  label: string;
  detail?: string;
}

/**
 * A tool the agent invoked. Rendered as a compact step in the thread so the
 * user can see what the agent actually did, not just what it concluded.
 */
export interface ToolCallBlock {
  kind: "tool";
  toolName: string;
  state: ToolCallState;
  /** Human-readable summary of the call or its result. */
  summary: string;
}

export type ToolCallState = "running" | "completed" | "failed" | "rejected" | "awaiting-approval";

/**
 * A high-risk tool waiting on a human decision. The run is suspended until
 * one is given, so this block is interactive rather than informational.
 */
export interface ApprovalBlock {
  kind: "approval";
  approvalId: string;
  toolName: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  /** The exact arguments the tool would run with, for review before approving. */
  input: unknown;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
}

/** A single file's change, rendered as a red/green unified diff. */
export interface DiffBlock {
  kind: "diff";
  patch: FilePatch;
}

/** A file the agent produced or read, rendered as an inline preview. */
export interface DocumentBlock {
  kind: "document";
  document: DocumentRef;
}

/** A web page the agent opened, rendered as an embedded browser pane. */
export interface BrowserBlock {
  kind: "browser";
  url: string;
  title?: string;
}

// ─── Messages and chats ──────────────────────────────────────────────────────

export interface Message {
  id: MessageId;
  chatId: ChatId;
  role: MessageRole;
  /** ISO-8601 UTC. */
  createdAt: string;
  blocks: MessageBlock[];
  /** Execution detail for an agent turn, shown in the trace panel. */
  trace?: RunTrace;
}

/**
 * Sidebar row. Deliberately excludes message bodies so listing every chat
 * stays cheap as history grows.
 */
export interface ChatSummary {
  id: ChatId;
  title: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface Chat extends ChatSummary {
  messages: Message[];
}

// ─── Documents ───────────────────────────────────────────────────────────────

/**
 * Coarse family a file belongs to. Chosen over raw MIME types because the
 * preview layer picks a component per family, not per exact type — `.xlsx` and
 * `.csv` both land on the spreadsheet viewer.
 */
export type DocumentKind =
  | "pdf"
  | "spreadsheet"
  | "wordprocessing"
  | "image"
  | "text"
  | "unknown";

/**
 * Where a document's bytes actually live. During local development that is a
 * path on disk; on-prem it is an artifact key the backend resolves from MinIO.
 * The renderer never sees bytes — it asks main for them by reference.
 */
export type DocumentSource =
  | { type: "file"; path: string }
  | { type: "artifact"; artifactId: string };

export interface DocumentRef {
  id: string;
  filename: string;
  mimeType: string;
  kind: DocumentKind;
  byteSize: number;
  source: DocumentSource;
}

// ─── Diffs ───────────────────────────────────────────────────────────────────

export type FileChangeType = "added" | "modified" | "deleted" | "renamed";

export type DiffLineType = "add" | "del" | "context";

/**
 * One rendered row of a diff. Line numbers are one-based and `null` on the
 * side where the line does not exist, which is what lets the gutter render
 * blanks the way GitHub does.
 */
export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/**
 * A complete, self-contained description of one file's change. Produced in the
 * main process (or, later, received from the backend) so the renderer only
 * ever renders a patch — it never computes one.
 */
export interface FilePatch {
  path: string;
  /** Set only when `changeType` is `renamed`. */
  previousPath: string | null;
  changeType: FileChangeType;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Binary files have no renderable hunks. */
  binary: boolean;
}

// ─── Spreadsheets ────────────────────────────────────────────────────────────
//
// Workbooks are parsed in the main process and sent over as display strings.
// The renderer never sees a parser: `exceljs` is Node-only, and CSV benefits
// from the same treatment so the viewer has exactly one code path for both.

/** One row of formatted cell text. `null` is an empty cell. */
export type SheetRow = readonly (string | null)[];

export interface SheetData {
  name: string;
  /** Rows in the source sheet, before `rows` was capped for preview. */
  totalRows: number;
  columnCount: number;
  rows: SheetRow[];
}

export interface SpreadsheetModel {
  sheets: SheetData[];
  /** True when any sheet's rows were capped — the UI must say so. */
  truncated: boolean;
}

/** Largest file the IDE will pull into memory to preview. */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

/** Rows returned per sheet. Beyond this the viewer reports truncation. */
export const MAX_SHEET_ROWS = 2_000;

/** Pages rendered per PDF, to bound work on very long documents. */
export const MAX_PDF_PAGES = 50;

// ─── Preview capabilities ────────────────────────────────────────────────────

/**
 * Which document families this build can actually render. The renderer asks
 * main at startup rather than hardcoding assumptions, so shipping a new viewer
 * is a main-process change and the UI degrades honestly until then.
 */
export type PreviewCapabilities = Record<DocumentKind, PreviewCapability>;

export interface PreviewCapability {
  kind: DocumentKind;
  supported: boolean;
  /** Shown to the user when `supported` is false. */
  reason?: string;
}

// ─── Embedded browser ────────────────────────────────────────────────────────

/**
 * Rectangle, in renderer CSS pixels relative to the window's content area,
 * that the embedded browser view should occupy.
 *
 * Electron's `WebContentsView` is a native view that is *not* part of the DOM,
 * so it cannot be laid out by CSS or clipped by an ancestor. The renderer
 * therefore measures a placeholder element and reports its rectangle; main
 * positions the native view to match. This is also why the browser lives in a
 * fixed pane rather than inline in the scrolling chat thread — a native view
 * would paint over the sidebar and composer as the thread scrolled.
 */
export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * State of the single embedded browser pane. There is one pane because a
 * native overlay cannot be interleaved with DOM content, so two visible panes
 * could not be stacked sensibly against the React UI.
 */
export interface BrowserPaneState {
  /** `null` when the pane is closed. */
  url: string | null;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Present when the last navigation failed or was blocked by policy. */
  error?: string;
}

export const CLOSED_BROWSER_PANE: BrowserPaneState = {
  url: null,
  title: "",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
};

// ─── Run trace ───────────────────────────────────────────────────────────────
//
// The thread shows what the agent produced. The trace shows how it got there:
// which model was routed to and why, every tool call with its arguments and
// result, and where the run ended. Kept beside a message rather than inside
// its blocks, because it is inspection detail rather than conversation.

export interface TraceToolCall {
  toolName: string;
  state: ToolCallState;
  summary: string;
  /** Arguments the tool was called with, as recorded by the backend. */
  input?: unknown;
  output?: unknown;
}

export interface RunTrace {
  runId: string;
  task: string;
  status: RunState;
  /** Model profile that ran, and the router's reason for choosing it. */
  modelProfile: string;
  modelReason: string;
  capability: string;
  toolCalls: TraceToolCall[];
  /** Terminal outcome, once the run has one. */
  result?: {
    analysis?: string;
    artifactFilename?: string;
    error?: string;
  };
}

// ─── Backend session ─────────────────────────────────────────────────────────

/**
 * How the run's data may be handled. Mirrors the backend enum: INTERNAL and
 * CONFIDENTIAL force a local model, so the choice is a policy decision the
 * user makes per message rather than a hidden default.
 */
export type DataClassification = "PUBLIC" | "SYNTHETIC" | "INTERNAL" | "CONFIDENTIAL";

export const DATA_CLASSIFICATIONS: readonly DataClassification[] = [
  "SYNTHETIC",
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
];

export interface SessionUser {
  id: string;
  email: string;
  role: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
}

/**
 * Connection to the on-premise backend.
 *
 * The access token never appears here: it is held in the main process and
 * never crosses to the renderer.
 */
export interface SessionState {
  status: "disconnected" | "connecting" | "connected";
  baseUrl: string;
  user?: SessionUser;
  workspace?: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  /** Present when the last connection attempt failed. */
  error?: string;
  /**
   * Sign-in values to prefill during development. Absent in packaged builds,
   * so a release always opens on an empty form.
   */
  prefill?: SignInPrefill;
}

export interface SignInPrefill {
  baseUrl: string;
  email: string;
  password: string;
}

export const DISCONNECTED_SESSION: SessionState = {
  status: "disconnected",
  baseUrl: "",
  workspaces: [],
};
