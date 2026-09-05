import { basename } from "node:path";

import type { DataClassification, SessionUser, WorkspaceSummary } from "@shared/types.js";

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

  async downloadArtifact(artifactId: string): Promise<Buffer> {
    const response = await this.#fetch(`/api/artifacts/${artifactId}/download`, {});
    if (!response.ok) throw new BackendError(`Download failed (${response.status})`, response.status);
    return Buffer.from(await response.arrayBuffer());
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
