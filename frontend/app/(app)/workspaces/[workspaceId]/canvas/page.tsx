"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, type Workspace, type Run, type Artifact } from "../../../../../lib/api";
import WorkspaceCanvas from "../../../../../components/workbench/WorkspaceCanvas";

export default function WorkspaceCanvasPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api.getWorkspaces().then(res => setWorkspace(res.workspaces.find(w => w.id === workspaceId) || null)),
      api.getWorkspaceRuns(workspaceId).then(res => setRuns(res.runs)),
      api.getWorkspaceArtifacts(workspaceId).then(res => setArtifacts(res.artifacts))
    ])
    .catch(err => setError(err.message))
    .finally(() => setLoading(false));
  }, [workspaceId]);

  return (
    <div className="workbench" style={{ flexDirection: "column", padding: "16px", height: "100vh" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 16px 16px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/workbench" className="btn-ghost" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to Workbench
          </Link>
          <h1 style={{ fontSize: 16, fontWeight: 600 }}>Global Workspace Visualizer</h1>
        </div>
      </header>
      
      <main style={{ flex: 1, position: "relative", borderRadius: 16, overflow: "hidden", border: "1px solid var(--line)", marginTop: 16 }} className="animated-border">
        {error ? (
          <div style={{ padding: 24, color: "var(--red)" }}>{error}</div>
        ) : loading ? (
          <div style={{ padding: 24, color: "var(--ink-2)" }}>Loading global canvas...</div>
        ) : workspace ? (
          <WorkspaceCanvas workspace={workspace} runs={runs} artifacts={artifacts} />
        ) : (
          <div style={{ padding: 24, color: "var(--red)" }}>Workspace not found</div>
        )}
      </main>
    </div>
  );
}
