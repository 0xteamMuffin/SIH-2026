"use client";

import { useEffect, useState } from "react";
import { api, type Workspace, type Artifact } from "../../../lib/api";

function formatBytes(bytes?: number) {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ArtifactsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState("");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api.getWorkspaces()
      .then((d) => { setWorkspaces(d.workspaces); if (d.workspaces.length) setSelectedWs(d.workspaces[0].id); })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load workspaces"))
      .finally(() => setLoading(false));
  }, []);

  function refresh(workspaceId: string) {
    if (!workspaceId) return;
    setError("");
    api.getWorkspaceArtifacts(workspaceId).then((d) => setArtifacts(d.artifacts)).catch((err) => setError(err instanceof Error ? err.message : "Failed to load artifacts"));
  }

  useEffect(() => { refresh(selectedWs); }, [selectedWs]);

  async function handleDelete(artifactId: string) {
    if (!confirm("Delete this artifact? This queues async cleanup and cannot be undone.")) return;
    try {
      await api.deleteArtifact(selectedWs, artifactId);
      refresh(selectedWs);
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to delete artifact"); }
  }

  return (
    <div className="stub-page" style={{ padding: 32, maxWidth: 1100 }}>
      <h1>Artifacts</h1>
      <p className="text-muted" style={{ marginBottom: 20 }}>Uploaded source files and generated deliverables for a workspace.</p>

      <div className="row-gap" style={{ marginBottom: 16 }}>
        <select value={selectedWs} onChange={(e) => setSelectedWs(e.target.value)} className="field-input" style={{ width: 260 }}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : artifacts.length === 0 ? (
        <p className="text-muted">No artifacts in this workspace yet.</p>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                {["File", "Kind", "Classification", "Size", "Extraction", "Status", "Created", ""].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", color: "var(--ink-3)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {artifacts.map((a) => (
                <tr key={a.id} style={{ borderBottom: "1px solid var(--line)" }}>
                  <td style={{ padding: "10px 14px", color: "var(--ink)" }}>{a.filename}</td>
                  <td style={{ padding: "10px 14px" }}><span className="chip">{a.kind}</span></td>
                  <td style={{ padding: "10px 14px" }}><span className="chip">{a.classification}</span></td>
                  <td style={{ padding: "10px 14px", color: "var(--ink-2)" }}>{formatBytes(a.sizeBytes)}</td>
                  <td style={{ padding: "10px 14px", color: "var(--ink-2)" }}>{a.extractionStatus ?? "—"}</td>
                  <td style={{ padding: "10px 14px" }}>{a.lifecycleStatus && <span className={`status status-${a.lifecycleStatus === "ACTIVE" ? "completed" : "cancelled"}`}>{a.lifecycleStatus}</span>}</td>
                  <td style={{ padding: "10px 14px", color: "var(--ink-3)" }}>{a.createdAt ? new Date(a.createdAt).toLocaleString() : "—"}</td>
                  <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                    <button onClick={() => api.downloadArtifact(a.id, a.filename).catch((err) => setError(err instanceof Error ? err.message : "Download failed"))} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 11, marginRight: 6 }}>Download</button>
                    <button onClick={() => handleDelete(a.id)} className="btn-danger" style={{ padding: "4px 8px", fontSize: 11 }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
