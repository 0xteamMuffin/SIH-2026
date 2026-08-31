const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const DEFAULT_DATA_CLASSIFICATION: DataClassification = "SYNTHETIC";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("refreshToken");
}

function setTokens(token: string, refreshToken: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem("token", token);
  localStorage.setItem("refreshToken", refreshToken);
}

function clearTokens() {
  if (typeof window === "undefined") return;
  localStorage.removeItem("token");
  localStorage.removeItem("refreshToken");
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = await res.json();
        setTokens(data.accessToken, data.refreshToken);
        return data.accessToken as string;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

// Attaches the access token, and on a 401 tries one silent refresh-and-retry
// before dropping the session — the access token is short-lived (15 min) so
// this fires routinely, not just on a truly invalid token.
async function authorizedFetch(path: string, options?: RequestInit, retried = false): Promise<Response> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options?.headers },
  });
  if (res.status === 401 && !retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return authorizedFetch(path, options, true);
    clearTokens();
    if (typeof window !== "undefined") window.location.href = "/login";
  }
  return res;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const extraHeaders: Record<string, string> = {};
  if (options?.body && typeof options.body === "string") {
    extraHeaders["Content-Type"] = "application/json";
  }
  const res = await authorizedFetch(path, { ...options, headers: { ...extraHeaders, ...options?.headers } });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed ${res.status}`);
  return data as T;
}

export const api = {
  login: async (email: string, password: string) => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? "Login failed");
    return data as { token: string; refreshToken: string; user: { id: string; email: string; role: string } };
  },

  getWorkspaces: () =>
    request<{ workspaces: Workspace[] }>("/api/workspaces"),

  createWorkspace: (name: string) =>
    request<{ workspace: Workspace }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  createRun: (
    workspaceId: string,
    task: string,
    artifactId?: string,
    dataClassification: DataClassification = DEFAULT_DATA_CLASSIFICATION,
  ) =>
    request<{ run: Run }>(`/api/workspaces/${workspaceId}/runs`, {
      method: "POST",
      body: JSON.stringify({ task, artifactId, dataClassification }),
    }),

  getRun: (runId: string) => request<{ run: Run }>(`/api/runs/${runId}`),

  getWorkspaceArtifacts: (workspaceId: string) =>
    request<{ artifacts: Artifact[] }>(`/api/workspaces/${workspaceId}/artifacts`),

  getWorkspaceRuns: (workspaceId: string) =>
    request<{ runs: Run[]; pagination: { nextCursor: string | null } }>(`/api/workspaces/${workspaceId}/runs`),

  cancelRun: (runId: string) =>
    request<{ run: Run }>(`/api/runs/${runId}/cancel`, { method: "POST" }),

  uploadArtifact: async (
    workspaceId: string,
    file: File,
    classification: DataClassification = DEFAULT_DATA_CLASSIFICATION,
  ): Promise<{ artifact: Artifact }> => {
    const form = new FormData();
    form.append("file", file);
    form.append("classification", classification);
    const res = await authorizedFetch(`/api/workspaces/${workspaceId}/artifacts`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? "Upload failed");
    return data as { artifact: Artifact };
  },

  downloadArtifact: async (artifactId: string, filename: string) => {
    const res = await authorizedFetch(`/api/artifacts/${artifactId}/download`);
    if (!res.ok) throw new Error("Download failed");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  getArtifactBlobUrl: async (artifactId: string) => {
    const res = await authorizedFetch(`/api/artifacts/${artifactId}/download`);
    if (!res.ok) throw new Error("Download failed");
    return URL.createObjectURL(await res.blob());
  },

  deleteArtifact: (workspaceId: string, artifactId: string) =>
    request<{ status: string }>(`/api/workspaces/${workspaceId}/artifacts/${artifactId}`, { method: "DELETE" }),

  // ── Knowledge ──────────────────────────────────────────────────────────────
  getKnowledgeSources: (workspaceId: string) =>
    request<{ knowledgeSources: KnowledgeSource[]; pagination: { nextCursor: string | null } }>(`/api/workspaces/${workspaceId}/knowledge-sources`),

  createKnowledgeSource: (workspaceId: string, artifactId: string, visibility: KnowledgeVisibility = "WORKSPACE_PRIVATE") =>
    request<{ knowledgeSource: KnowledgeSource }>(`/api/workspaces/${workspaceId}/knowledge-sources`, {
      method: "POST",
      body: JSON.stringify({ artifactId, visibility }),
    }),

  deleteKnowledgeSource: (sourceId: string) =>
    request<{ status: string }>(`/api/knowledge-sources/${sourceId}`, { method: "DELETE" }),

  reindexKnowledgeSource: (sourceId: string) =>
    request<{ status: string }>(`/api/knowledge-sources/${sourceId}/reindex`, { method: "POST" }),

  // ── Audit ──────────────────────────────────────────────────────────────────
  getAuditEvents: (workspaceId: string, eventType?: string) =>
    request<{ auditEvents: AuditEvent[]; pagination: { nextCursor: string | null } }>(
      `/api/workspaces/${workspaceId}/audit-events${eventType ? `?eventType=${encodeURIComponent(eventType)}` : ""}`,
    ),

  exportAuditEvents: async (workspaceId: string, format: "json" | "ndjson" = "json") => {
    const res = await authorizedFetch(`/api/workspaces/${workspaceId}/audit-events/export?format=${format}`);
    if (!res.ok) throw new Error("Export failed");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${workspaceId}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },

  // ── Admin: users ───────────────────────────────────────────────────────────
  getUsers: () => request<{ users: AdminUser[] }>("/api/auth/users"),

  createUser: (email: string, password: string, role: Role = "OPERATOR") =>
    request<{ user: AdminUser }>("/api/auth/users", {
      method: "POST",
      body: JSON.stringify({ email, password, role }),
    }),

  disableUser: (userId: string) =>
    request<{ user: AdminUser }>(`/api/auth/users/${userId}/disable`, { method: "POST" }),

  getModelProviderStatus: () => request<ModelProviderStatusResult>("/api/admin/model-providers/status"),

  decideApproval: (approvalId: string, decision: "APPROVED" | "REJECTED", note?: string) =>
    request<{ approval: ToolApproval }>(`/api/agent-approvals/${approvalId}/decision`, {
      method: "POST",
      body: JSON.stringify(note ? { decision, note } : { decision }),
    }),
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export type DataClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "SYNTHETIC";

export interface Artifact {
  id: string;
  workspaceId?: string;
  filename: string;
  mimeType: string;
  kind: string;
  classification: DataClassification;
  sizeBytes?: number;
  lifecycleStatus?: "ACTIVE" | "DELETING" | "DELETED";
  extractionStatus?: "NOT_REQUIRED" | "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  createdAt?: string;
}

export type Role = "ADMIN" | "OPERATOR" | "REVIEWER";
export type KnowledgeVisibility = "WORKSPACE_PRIVATE" | "ORGANIZATION_SHARED";

export interface KnowledgeSourceIndexView {
  id: string;
  indexId: string;
  status: "PENDING" | "INDEXING" | "READY" | "STALE" | "REMOVING" | "REMOVED" | "FAILED";
  chunkCount: number;
  indexedAt?: string;
  lastError?: string;
}

export interface KnowledgeSource {
  id: string;
  workspaceId: string;
  artifactId: string;
  visibility: KnowledgeVisibility;
  status: "ACTIVE" | "ARCHIVED" | "DELETING" | "DELETED";
  createdAt: string;
  artifact: Artifact;
  sourceIndexes: KnowledgeSourceIndexView[];
}

export interface AuditEvent {
  id: string;
  actorId: string | null;
  workspaceId: string | null;
  runId: string | null;
  eventType: string;
  metadata: unknown;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  role: Role;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ModelCapability = "general" | "document" | "vision" | "code" | "embedding" | "reranking";
export type ProviderProbeStatus = "available" | "degraded" | "unavailable" | "not_configured" | "disabled";

export interface ModelProviderStatus {
  providerId: string;
  location: "local" | "remote";
  status: ProviderProbeStatus;
  capabilities: ModelCapability[];
  availableCapabilities: ModelCapability[];
  profiles: Array<{ profileId: string; modelId: string; capabilities: ModelCapability[]; available: boolean | null }>;
  latencyMs?: number;
  errorCode?: string;
}

export interface ModelProviderStatusResult {
  checkedAt: string;
  providers: ModelProviderStatus[];
}

export interface ToolCall {
  toolName: string;
  status: "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "REJECTED" | "CANCELLED";
  input: unknown;
  output: unknown;
  startedAt: string;
  completedAt?: string;
}

export interface Evidence {
  id: string;
  sourceRef: string;
  title: string;
  summary: string;
  facts: string[];
}

export interface ToolApproval {
  id: string;
  runId: string;
  toolName: string;
  toolInput: unknown;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  requestedAt: string;
  decidedAt?: string;
  decisionNote?: string;
}

export interface Run {
  id: string;
  status: "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "CANCELLED";
  task: string;
  dataClassification: DataClassification;
  taskCapability: string;
  modelProfile: string;
  modelReason: string;
  toolCalls?: ToolCall[];
  evidence?: Evidence[];
  approvals?: ToolApproval[];
  result?: {
    analysis?: string;
    artifact?: Artifact;
  };
  createdAt: string;
}
