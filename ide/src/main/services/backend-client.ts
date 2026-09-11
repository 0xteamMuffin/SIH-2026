import { basename } from "node:path";

import type {
  AdminUser,
  AuditPage,
  AuditQuery,
  DataClassification,
  EgressLedger,
  EgressProbeResult,
  ModelProviderStatusResult,
  SessionUser,
  SovereigntyPosture,
  UserRoleName,
  WorkspaceMember,
  WorkspaceSummary,
} from "@shared/types.js";

/**
 * HTTP client for the on-premise backend.
 *
 * Lives in the main process so the access token never reaches the renderer.
 * The renderer asks for outcomes ("start this run"); it never holds a
 * credential and cannot construct an arbitrary request.
 */

export type ArtifactExtractionStatus =
  | "NOT_REQUIRED"
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

export interface DownloadedArtifact {
  bytes: Buffer;
  /** From `content-disposition`; `null` when the server did not send one. */
  filename: string | null;
  mimeType: string | null;
}

/**
 * Pulls the filename out of a `content-disposition` header.
 *
 * Handles both the plain `filename="x.xlsx"` form the backend sends and the
 * RFC 5987 `filename*=UTF-8''x.xlsx` encoding, and returns `null` rather than
 * guessing when neither is present.
 */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1]) {
    try {
      return basename(decodeURIComponent(encoded[1].trim()));
    } catch {
      return null;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ? basename(plain[1].trim()) : null;
}

export interface BackendArtifact {
  id: string;
  filename: string;
  mimeType: string;
  kind: string;
  sizeBytes?: number;
  classification?: DataClassification;
  extractionStatus?: ArtifactExtractionStatus;
}

export interface BackendToolCall {
  toolName: string;
  status: "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "REJECTED" | "CANCELLED";
  input?: unknown;
  output?: { ok?: boolean; summary?: string; errorCode?: string } | null;
}

export interface BackendApproval {
  id: string;
  toolName: string;
  toolInput: unknown;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
}

export interface BackendRun {
  id: string;
  status: "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "CANCELLED";
  task: string;
  modelProfile: string;
  modelReason: string;
  taskCapability: string;
  toolCalls?: BackendToolCall[];
  approvals?: BackendApproval[];
  result?: {
    analysis?: string;
    artifact?: BackendArtifact;
    deliverableAuthoring?: string;
    error?: string;
    code?: string;
  };
}

export class BackendError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BackendError";
    this.status = status;
  }
}

export class BackendClient {
  readonly #baseUrl: string;
  #accessToken: string | null = null;
  #refreshToken: string | null = null;
  #refreshInFlight: Promise<boolean> | null = null;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get isAuthenticated(): boolean {
    return this.#accessToken !== null;
  }

  async login(email: string, password: string): Promise<SessionUser> {
    const data = await this.#json<{ token: string; refreshToken: string; user: SessionUser }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) },
      { authenticated: false },
    );

    this.#accessToken = data.token;
    this.#refreshToken = data.refreshToken;
    return data.user;
  }

  logout(): void {
    this.#accessToken = null;
    this.#refreshToken = null;
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const { workspaces } = await this.#json<{ workspaces: WorkspaceSummary[] }>("/api/workspaces");
    return workspaces;
  }

  async createWorkspace(name: string): Promise<WorkspaceSummary> {
    const { workspace } = await this.#json<{ workspace: WorkspaceSummary }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return workspace;
  }

  async uploadArtifact(
    workspaceId: string,
    path: string,
    bytes: Buffer,
    mimeType: string,
    classification: DataClassification,
  ): Promise<BackendArtifact> {
    const form = new FormData();
    form.set("classification", classification);
    // `Buffer` is a `Uint8Array`, but Blob wants a fresh view: passing the
    // pooled buffer directly can include unrelated bytes.
    form.set("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), basename(path));

    const { artifact } = await this.#json<{ artifact: BackendArtifact }>(
      `/api/workspaces/${workspaceId}/artifacts`,
      { method: "POST", body: form },
    );
    return artifact;
  }

  async getArtifact(artifactId: string): Promise<BackendArtifact> {
    const { artifact } = await this.#json<{ artifact: BackendArtifact }>(`/api/artifacts/${artifactId}`);
    return artifact;
  }

  async createRun(input: {
    workspaceId: string;
    task: string;
    artifactId?: string;
    /** Groups this run with earlier turns of the same chat. */
    conversationId?: string;
    dataClassification: DataClassification;
  }): Promise<BackendRun> {
    const body: Record<string, unknown> = {
      task: input.task,
      dataClassification: input.dataClassification,
    };
    if (input.artifactId) body["artifactId"] = input.artifactId;
    if (input.conversationId) body["conversationId"] = input.conversationId;

    const { run } = await this.#json<{ run: BackendRun }>(
      `/api/workspaces/${input.workspaceId}/runs`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return run;
  }

  async getRun(runId: string): Promise<BackendRun> {
    const { run } = await this.#json<{ run: BackendRun }>(`/api/runs/${runId}`);
    return run;
  }

  async cancelRun(runId: string): Promise<void> {
    await this.#json(`/api/runs/${runId}/cancel`, { method: "POST" });
  }

  async decideApproval(approvalId: string, decision: "APPROVED" | "REJECTED"): Promise<void> {
    await this.#json(`/api/agent-approvals/${approvalId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  }

  async downloadArtifact(artifactId: string): Promise<DownloadedArtifact> {
    const response = await this.#fetch(`/api/artifacts/${artifactId}/download`, {});
    if (!response.ok) throw new BackendError(`Download failed (${response.status})`, response.status);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      // The server names the file. Callers that pick a parser by extension
      // follow the artifact's real name rather than assuming a format.
      filename: filenameFromDisposition(response.headers.get("content-disposition")),
      mimeType: response.headers.get("content-type"),
    };
  }

  // ─── Governance ────────────────────────────────────────────────────────────
  //
  // Every method here returns the backend's own payload unchanged. These
  // surfaces exist to show what the backend recorded, so reshaping the data on
  // the way through would put a translation layer between the evidence and the
  // person checking it.

  /**
   * Which egress controls are in force, and every declared inference
   * destination. Readable by any authenticated user by design — the people
   * doing the work should not need an administrator to check where it went.
   */
  async getSovereigntyPosture(): Promise<SovereigntyPosture> {
    return this.#json<SovereigntyPosture>("/api/sovereignty/posture");
  }

  /** Recorded model and embedding calls, resolved to local or remote. */
  async getEgressLedger(options: { limit?: number; sinceHours?: number } = {}): Promise<EgressLedger> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.sinceHours !== undefined) query.set("sinceHours", String(options.sinceHours));
    return this.#json<EgressLedger>(`/api/sovereignty/egress?${query.toString()}`);
  }

  /**
   * Attempts an outbound connection to every declared remote destination.
   *
   * A deliberate action, never a side effect of opening a view: in the
   * development profile these attempts genuinely reach the internet.
   */
  async probeEgress(workspaceId?: string): Promise<EgressProbeResult> {
    return this.#json<EgressProbeResult>("/api/sovereignty/egress-probe", {
      method: "POST",
      // The workspace only decides where the audit record is filed; the probe
      // itself covers the whole deployment.
      body: JSON.stringify(workspaceId ? { workspaceId } : {}),
    });
  }

  async getModelProviderStatus(): Promise<ModelProviderStatusResult> {
    return this.#json<ModelProviderStatusResult>("/api/admin/model-providers/status");
  }

  async listUsers(): Promise<AdminUser[]> {
    const { users } = await this.#json<{ users: AdminUser[] }>("/api/auth/users");
    return users;
  }

  async createUser(email: string, password: string, role: UserRoleName): Promise<AdminUser> {
    const { user } = await this.#json<{ user: AdminUser }>("/api/auth/users", {
      method: "POST",
      body: JSON.stringify({ email, password, role }),
    });
    return user;
  }

  async disableUser(userId: string): Promise<AdminUser> {
    const { user } = await this.#json<{ user: AdminUser }>(`/api/auth/users/${userId}/disable`, {
      method: "POST",
    });
    return user;
  }

  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const { members } = await this.#json<{ members: WorkspaceMember[] }>(
      `/api/workspaces/${workspaceId}/members`,
    );
    return members;
  }

  async addWorkspaceMember(
    workspaceId: string,
    userId: string,
    role: UserRoleName,
  ): Promise<WorkspaceMember> {
    const { member } = await this.#json<{ member: WorkspaceMember }>(
      `/api/workspaces/${workspaceId}/members`,
      { method: "POST", body: JSON.stringify({ userId, role }) },
    );
    return member;
  }

  async updateWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
    role: UserRoleName,
  ): Promise<WorkspaceMember> {
    const { member } = await this.#json<{ member: WorkspaceMember }>(
      `/api/workspaces/${workspaceId}/members/${userId}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
    return member;
  }

  async removeWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
    await this.#json(`/api/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" });
  }

  async listAuditEvents(query: AuditQuery): Promise<AuditPage> {
    const search = new URLSearchParams();
    if (query.eventType) search.set("eventType", query.eventType);
    if (query.actorId) search.set("actorId", query.actorId);
    if (query.runId) search.set("runId", query.runId);
    if (query.from) search.set("from", query.from);
    if (query.to) search.set("to", query.to);
    if (query.cursor) search.set("cursor", query.cursor);
    search.set("limit", String(query.limit ?? 50));

    const payload = await this.#json<{
      auditEvents: AuditPage["auditEvents"];
      pagination: { nextCursor: string | null };
    }>(`/api/workspaces/${query.workspaceId}/audit-events?${search.toString()}`);

    return { auditEvents: payload.auditEvents, nextCursor: payload.pagination.nextCursor };
  }

  /**
   * Streams the audit export to a string.
   *
   * The backend streams this so a large range does not have to be buffered
   * server-side; the client still buffers it, because the destination is a
   * file the user picks and the dialog cannot open until they act.
   */
  async exportAuditEvents(
    workspaceId: string,
    format: "json" | "ndjson",
    filters: Omit<AuditQuery, "workspaceId" | "limit" | "cursor"> = {},
  ): Promise<string> {
    const search = new URLSearchParams({ format });
    if (filters.eventType) search.set("eventType", filters.eventType);
    if (filters.actorId) search.set("actorId", filters.actorId);
    if (filters.runId) search.set("runId", filters.runId);
    if (filters.from) search.set("from", filters.from);
    if (filters.to) search.set("to", filters.to);

    const response = await this.#fetch(
      `/api/workspaces/${workspaceId}/audit-events/export?${search.toString()}`,
      {},
    );
    if (!response.ok) {
      throw new BackendError(`Audit export failed (${response.status})`, response.status);
    }
    return response.text();
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.#baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ─── Transport ─────────────────────────────────────────────────────────────

  async #json<T>(
    path: string,
    options: RequestInit = {},
    { authenticated = true }: { authenticated?: boolean } = {},
  ): Promise<T> {
    const response = await this.#fetch(path, options, authenticated);
    const text = await response.text();

    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const message =
        (payload as { error?: { message?: string } } | undefined)?.error?.message ??
        `Request failed with status ${response.status}`;
      throw new BackendError(message, response.status);
    }
    return payload as T;
  }

  /**
   * Sends a request, retrying once through a token refresh on 401.
   *
   * Access tokens are short-lived, so a 401 is routine rather than a sign the
   * session is gone — refreshing silently is what keeps a long chat from
   * dropping mid-run.
   */
  async #fetch(path: string, options: RequestInit, authenticated = true, retried = false): Promise<Response> {
    const headers = new Headers(options.headers);
    if (authenticated && this.#accessToken) headers.set("authorization", `Bearer ${this.#accessToken}`);
    if (typeof options.body === "string" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        ...options,
        headers,
        signal: options.signal ?? AbortSignal.timeout(120_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new BackendError("The backend did not respond in time.", 504);
      }
      throw new BackendError(`Cannot reach the backend at ${this.#baseUrl}.`, 503);
    }

    if (response.status === 401 && authenticated && !retried && (await this.#refresh())) {
      return this.#fetch(path, options, authenticated, true);
    }
    return response;
  }

  /** Coalesces concurrent refreshes so a burst of 401s issues one request. */
  async #refresh(): Promise<boolean> {
    if (!this.#refreshToken) return false;

    this.#refreshInFlight ??= (async () => {
      try {
        const response = await fetch(`${this.#baseUrl}/api/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: this.#refreshToken }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) return false;

        const data = (await response.json()) as { accessToken: string; refreshToken: string };
        this.#accessToken = data.accessToken;
        this.#refreshToken = data.refreshToken;
        return true;
      } catch {
        return false;
      } finally {
        this.#refreshInFlight = null;
      }
    })();

    return this.#refreshInFlight;
  }
}
