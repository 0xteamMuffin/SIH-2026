const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const DEFAULT_DATA_CLASSIFICATION: DataClassification = "INTERNAL";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const extraHeaders: Record<string, string> = {};
  if (token) extraHeaders["Authorization"] = `Bearer ${token}`;
  if (options?.body && typeof options.body === "string") {
    extraHeaders["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...extraHeaders, ...options?.headers },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed ${res.status}`);
  return data as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

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
    const token = getToken();
    const form = new FormData();
    form.append("file", file);
    form.append("classification", classification);
    const res = await fetch(`${BASE}/api/workspaces/${workspaceId}/artifacts`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? "Upload failed");
    return data as { artifact: Artifact };
  },

  downloadArtifact: async (artifactId: string, filename: string) => {
    const token = getToken();
    const res = await fetch(`${BASE}/api/artifacts/${artifactId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error("Download failed");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  getArtifactBlobUrl: async (artifactId: string) => {
    const token = getToken();
    const res = await fetch(`${BASE}/api/artifacts/${artifactId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error("Download failed");
    return URL.createObjectURL(await res.blob());
  },
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
  filename: string;
  mimeType: string;
  kind: string;
  classification: DataClassification;
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
  result?: {
    analysis?: string;
    artifact?: Artifact;
  };
  createdAt: string;
}
