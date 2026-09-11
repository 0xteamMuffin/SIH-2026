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
  AdminUser,
  AuditPage,
  AuditQuery,
  BrowserPaneState,
  Chat,
  ChatId,
  ChatSummary,
  DataClassification,
  DocumentReadRequest,
  DocumentRef,
  EgressLedger,
  EgressProbeResult,
  Message,
  ModelProviderStatusResult,
  PreviewCapabilities,
  SessionState,
  SovereigntyPosture,
  SpreadsheetModel,
  UserRoleName,
  ViewBounds,
  WorkspaceMember,
  WorkspaceSummary,
} from "./types.js";

export interface ChatApi {
  list(): Promise<ChatSummary[]>;
  create(): Promise<Chat>;
  get(chatId: ChatId): Promise<Chat | null>;
  rename(chatId: ChatId, title: string): Promise<void>;
  remove(chatId: ChatId): Promise<void>;
  /** Records the prompt and starts the agent; replies arrive via `onEvent`. */
  send(
    chatId: ChatId,
    prompt: string,
    attachments?: DocumentRef[],
    classification?: DataClassification,
  ): Promise<Message>;
  cancel(chatId: ChatId): Promise<void>;
}

export interface PreviewApi {
  capabilities(): Promise<PreviewCapabilities>;
}

export interface SessionApi {
  state(): Promise<SessionState>;
  connect(baseUrl: string, email: string, password: string): Promise<SessionState>;
  disconnect(): Promise<SessionState>;
  selectWorkspace(workspaceId: string): Promise<SessionState>;
}

export interface ApprovalApi {
  decide(approvalId: string, decision: "APPROVED" | "REJECTED"): Promise<void>;
}

export interface DocumentApi {
  /** Opens a native file picker. Resolves to `[]` if the user cancels. */
  pick(): Promise<DocumentRef[]>;
  read(document: DocumentReadRequest): Promise<ArrayBuffer>;
  readSpreadsheet(document: DocumentReadRequest): Promise<SpreadsheetModel>;
  /** Saves a copy to disk. Resolves to `null` if the user cancels. */
  save(document: DocumentReadRequest, filename: string): Promise<string | null>;
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

export interface SovereigntyApi {
  /** Enforcement posture and every declared inference destination. */
  posture(): Promise<SovereigntyPosture>;
  /** Recorded calls with their destinations resolved. Administrators only. */
  egress(options?: { limit?: number; sinceHours?: number }): Promise<EgressLedger>;
  /**
   * Attempts an outbound connection to each declared remote destination.
   * A deliberate action — in the development profile it really does dial out.
   *
   * `workspaceId` only decides where the audit record is filed, so the proof
   * is findable in that workspace's audit log.
   */
  probe(workspaceId?: string): Promise<EgressProbeResult>;
}

export interface AdminApi {
  modelProviders(): Promise<ModelProviderStatusResult>;
  users(): Promise<AdminUser[]>;
  createUser(email: string, password: string, role: UserRoleName): Promise<AdminUser>;
  /** Also revokes the account's sessions, backend-side. */
  disableUser(userId: string): Promise<AdminUser>;
  createWorkspace(name: string): Promise<WorkspaceSummary>;
  workspaceMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  addMember(workspaceId: string, userId: string, role: UserRoleName): Promise<WorkspaceMember>;
  updateMemberRole(
    workspaceId: string,
    userId: string,
    role: UserRoleName,
  ): Promise<WorkspaceMember>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
}

export interface AuditApi {
  list(query: AuditQuery): Promise<AuditPage>;
  /** Saves an export to disk. Resolves to `null` if the user cancels. */
  export(
    workspaceId: string,
    format: "json" | "ndjson",
    filters?: Omit<AuditQuery, "workspaceId" | "limit" | "cursor">,
  ): Promise<string | null>;
}

export interface WorkbenchApi {
  readonly chat: ChatApi;
  readonly session: SessionApi;
  readonly approvals: ApprovalApi;
  readonly preview: PreviewApi;
  readonly documents: DocumentApi;
  readonly browser: BrowserApi;
  readonly sovereignty: SovereigntyApi;
  readonly admin: AdminApi;
  readonly audit: AuditApi;
  /** Subscribes to main-process events. Returns an unsubscribe function. */
  onEvent(listener: (event: MainEvent) => void): () => void;
}
