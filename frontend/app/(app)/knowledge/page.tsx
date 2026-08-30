"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type Workspace, type Artifact, type KnowledgeSource, type KnowledgeVisibility } from "../../../lib/api";

export default function KnowledgePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState("");
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingArtifactId, setPendingArtifactId] = useState("");
  const [visibility, setVisibility] = useState<KnowledgeVisibility>("WORKSPACE_PRIVATE");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.getWorkspaces()
      .then((d) => { setWorkspaces(d.workspaces); if (d.workspaces.length) setSelectedWs(d.workspaces[0].id); })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load workspaces"))
      .finally(() => setLoading(false));
  }, []);

  function refresh(workspaceId: string) {
    if (!workspaceId) return;
    setError("");
    api.getKnowledgeSources(workspaceId).then((d) => setSources(d.knowledgeSources)).catch((err) => setError(err instanceof Error ? err.message : "Failed to load knowledge sources"));
    api.getWorkspaceArtifacts(workspaceId).then((d) => setArtifacts(d.artifacts)).catch((err) => setError(err instanceof Error ? err.message : "Failed to load artifacts"));
  }

  useEffect(() => { refresh(selectedWs); }, [selectedWs]);

  const indexedArtifactIds = useMemo(() => new Set(sources.map((s) => s.artifactId)), [sources]);
  const indexableArtifacts = artifacts.filter((a) => a.kind === "SOURCE" && !indexedArtifactIds.has(a.id));

  async function handleAdd() {
    if (!pendingArtifactId) return;
    setSubmitting(true);
    setError("");
    try {
      await api.createKnowledgeSource(selectedWs, pendingArtifactId, visibility);
      setPendingArtifactId("");
      refresh(selectedWs);
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to add knowledge source"); } finally { setSubmitting(false); }
  }

  async function handleDelete(sourceId: string) {
    if (!confirm("Remove this source from the knowledge base? Its indexed content will be deleted.")) return;
    try { await api.deleteKnowledgeSource(sourceId); refresh(selectedWs); } catch (err) { setError(err instanceof Error ? err.message : "Failed to delete knowledge source"); }
  }

  async function handleReindex(sourceId: string) {
    try { await api.reindexKnowledgeSource(sourceId); refresh(selectedWs); } catch (err) { setError(err instanceof Error ? err.message : "Failed to reindex"); }
  }

  return (
    <div className="stub-page" style={{ padding: 32, maxWidth: 1100 }}>
      <h1>Knowledge Base</h1>
      <p className="text-muted" style={{ marginBottom: 20 }}>Documents indexed for retrieval, scoped to a workspace or shared org-wide.</p>

      <div className="row-gap" style={{ marginBottom: 16 }}>
        <select value={selectedWs} onChange={(e) => setSelectedWs(e.target.value)} className="field-input" style={{ width: 260 }}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Add an uploaded document to the knowledge base</div>
        <div className="row-gap">
          <select value={pendingArtifactId} onChange={(e) => setPendingArtifactId(e.target.value)} className="field-input" style={{ flex: 1, minWidth: 220 }}>
            <option value="">Select an uploaded source file…</option>
            {indexableArtifacts.map((a) => <option key={a.id} value={a.id}>{a.filename}</option>)}
          </select>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as KnowledgeVisibility)} className="field-input" style={{ width: 200 }}>
            <option value="WORKSPACE_PRIVATE">Workspace private</option>
            <option value="ORGANIZATION_SHARED">Organization shared</option>
          </select>
          <button onClick={handleAdd} disabled={!pendingArtifactId || submitting} className="btn-primary">Add</button>
        </div>
        {indexableArtifacts.length === 0 && artifacts.length > 0 && (
          <p className="text-muted">All uploaded source files in this workspace are already indexed.</p>
        )}
        {artifacts.length === 0 && <p className="text-muted">Upload a document from the Workbench first.</p>}
      </div>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : sources.length === 0 ? (
        <p className="text-muted">Nothing indexed yet for this workspace.</p>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                {["Document", "Visibility", "Status", "Indexing", "Chunks", "Added", ""].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", color: "var(--ink-3)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const latestIndex = s.sourceIndexes[0];
                return (
                  <tr key={s.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={{ padding: "10px 14px", color: "var(--ink)" }}>{s.artifact.filename}</td>
                    <td style={{ padding: "10px 14px" }}><span className="chip">{s.visibility === "ORGANIZATION_SHARED" ? "Org-shared" : "Private"}</span></td>
                    <td style={{ padding: "10px 14px" }}><span className={`status status-${s.status === "ACTIVE" ? "completed" : "cancelled"}`}>{s.status}</span></td>
                    <td style={{ padding: "10px 14px", color: "var(--ink-2)" }}>{latestIndex?.status ?? "—"}{latestIndex?.lastError ? ` (${latestIndex.lastError})` : ""}</td>
                    <td style={{ padding: "10px 14px", color: "var(--ink-2)" }}>{latestIndex?.chunkCount ?? 0}</td>
                    <td style={{ padding: "10px 14px", color: "var(--ink-3)" }}>{new Date(s.createdAt).toLocaleString()}</td>
                    <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                      <button onClick={() => handleReindex(s.id)} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 11, marginRight: 6 }}>Reindex</button>
                      <button onClick={() => handleDelete(s.id)} className="btn-danger" style={{ padding: "4px 8px", fontSize: 11 }}>Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
