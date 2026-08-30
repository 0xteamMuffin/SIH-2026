"use client";

import { useMemo, useState, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  Handle,
  Position,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Workspace, Run, Artifact } from "../../lib/api";

// ── Custom Node Components ────────────────────────────────────────────────

function WorkspaceNode({ data }: { data: any }) {
  return (
    <div className="card animated-border" style={{ width: 260, padding: "20px", borderRadius: "16px", background: "var(--surface)", border: "1px solid var(--accent)", boxShadow: "0 0 20px rgba(139, 92, 246, 0.2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 8, background: "rgba(139, 92, 246, 0.1)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        </div>
        <div>
          <div className="section-title" style={{ margin: 0 }}>Workspace Hub</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{data.name}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "var(--accent)", border: "none", width: 8, height: 8 }} />
    </div>
  );
}

function RunNode({ data }: { data: any }) {
  const isFailed = data.status === "FAILED";
  return (
    <div className="card" style={{ width: 280, padding: "14px", borderRadius: "12px", border: `1px solid ${isFailed ? 'var(--red)' : 'var(--line)'}` }}>
      <Handle type="target" position={Position.Left} style={{ background: "var(--line-strong)", border: "none" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <span className={`status status-${data.status.toLowerCase()}`}>{data.status}</span>
        <span className="chip" style={{ fontSize: 10 }}>{data.profile}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink)", lineHeight: 1.5, wordBreak: "break-word" }}>
        {data.task.slice(0, 80)}{data.task.length > 80 ? "..." : ""}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "var(--line-strong)", border: "none" }} />
    </div>
  );
}

function ArtifactNode({ data }: { data: any }) {
  return (
    <div style={{ background: "var(--inset)", border: "1px dashed var(--ink-3)", borderRadius: "8px", padding: "8px 12px", width: 220, display: "flex", alignItems: "center", gap: 8 }}>
      <Handle type="target" position={Position.Left} style={{ background: "var(--ink-3)", border: "none" }} />
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--ink)", wordBreak: "break-all" }}>{data.filename}</span>
        <span style={{ fontSize: 9, color: "var(--ink-3)" }}>{data.kind}</span>
      </div>
    </div>
  );
}

const nodeTypes = {
  workspace: WorkspaceNode,
  run: RunNode,
  artifact: ArtifactNode,
};

// ── Component ─────────────────────────────────────────────────────────────

interface Props {
  workspace: Workspace;
  runs: Run[];
  artifacts: Artifact[];
}

export default function WorkspaceCanvas({ workspace, runs, artifacts }: Props) {
  const [selectedNodeData, setSelectedNodeData] = useState<any>(null);

  const { nodes, edges } = useMemo(() => {
    const nds: Node[] = [];
    const eds: Edge[] = [];
    
    // 1. Workspace Node (Center Left)
    nds.push({
      id: `ws-${workspace.id}`,
      type: "workspace",
      position: { x: 50, y: 300 },
      data: { nodeType: "workspace", name: workspace.name, fullWorkspace: workspace },
    });

    let runYOffset = 50;

    // 2. Runs & Artifacts
    runs.forEach((run, i) => {
      const runNodeId = `run-${run.id}`;
      nds.push({
        id: runNodeId,
        type: "run",
        position: { x: 450, y: runYOffset },
        data: { nodeType: "run", task: run.task, status: run.status, profile: run.modelProfile, fullRun: run },
      });

      eds.push({
        id: `e-ws-${run.id}`,
        source: `ws-${workspace.id}`,
        target: runNodeId,
        animated: run.status === "RUNNING",
        style: { stroke: "var(--line-strong)", strokeWidth: 1.5 },
      });

      // Does this run have a generated artifact?
      if (run.result?.artifact) {
        const art = run.result.artifact;
        const artNodeId = `art-${art.id}`;
        nds.push({
          id: artNodeId,
          type: "artifact",
          position: { x: 850, y: runYOffset },
          data: { nodeType: "artifact", filename: art.filename, kind: art.kind, fullArtifact: art },
        });
        eds.push({
          id: `e-run-${run.id}-art-${art.id}`,
          source: runNodeId,
          target: artNodeId,
          animated: true,
          style: { stroke: "var(--accent)", strokeWidth: 1.5 },
        });
      }

      runYOffset += 160;
    });

    // Orphan Artifacts (e.g. source files uploaded by user, not generated by a run)
    const generatedArtifactIds = new Set(runs.map(r => r.result?.artifact?.id).filter(Boolean));
    const orphanArtifacts = artifacts.filter(a => !generatedArtifactIds.has(a.id));
    
    let orphanYOffset = runYOffset + 50;
    orphanArtifacts.forEach(art => {
      const artNodeId = `art-${art.id}`;
      nds.push({
        id: artNodeId,
        type: "artifact",
        position: { x: 450, y: orphanYOffset },
        data: { nodeType: "artifact", filename: art.filename, kind: art.kind, fullArtifact: art },
      });
      eds.push({
        id: `e-ws-art-${art.id}`,
        source: `ws-${workspace.id}`,
        target: artNodeId,
        style: { stroke: "var(--ink-3)", strokeWidth: 1, strokeDasharray: "4 4" },
      });
      orphanYOffset += 80;
    });

    return { nodes: nds, edges: eds };
  }, [workspace, runs, artifacts]);

  const onNodeClick = useCallback((event: any, node: Node) => setSelectedNodeData(node.data), []);
  const onPaneClick = useCallback(() => setSelectedNodeData(null), []);

  return (
    <div style={{ display: "flex", width: "100%", height: "100%" }}>
      <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--line-strong)" gap={20} size={2} />
          <Controls style={{ background: "var(--surface)", border: "1px solid var(--line)", fill: "var(--ink-2)" }} />
        </ReactFlow>
      </div>

      {selectedNodeData && (
        <div style={{ width: 360, background: "var(--surface)", borderLeft: "1px solid var(--line)", display: "flex", flexDirection: "column", overflowY: "auto", animation: "fade-up 300ms ease" }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>Node Details</h3>
            <button onClick={onPaneClick} className="btn-ghost" style={{ padding: 4 }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
          </div>
          
          <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 24 }}>
            {selectedNodeData.nodeType === "run" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <div className="section-title">Run Task</div>
                  <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>{selectedNodeData.fullRun.task}</p>
                </div>
                <div>
                  <div className="section-title">Status</div>
                  <span className={`status status-${selectedNodeData.status.toLowerCase()}`}>{selectedNodeData.status}</span>
                </div>
                <div>
                  <div className="section-title">Model Profile</div>
                  <span className="chip">{selectedNodeData.profile}</span>
                </div>
              </div>
            )}
            {selectedNodeData.nodeType === "workspace" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <div className="section-title">Workspace Name</div>
                  <p style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{selectedNodeData.name}</p>
                </div>
                <div>
                  <div className="section-title">Total Runs</div>
                  <p style={{ fontSize: 24, fontWeight: 600, color: "var(--accent)" }}>{runs.length}</p>
                </div>
                <div>
                  <div className="section-title">Total Artifacts</div>
                  <p style={{ fontSize: 24, fontWeight: 600, color: "var(--green)" }}>{artifacts.length}</p>
                </div>
              </div>
            )}
            {selectedNodeData.nodeType === "artifact" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <div className="section-title">Filename</div>
                  <p style={{ fontSize: 13, color: "var(--ink)", wordBreak: "break-all" }}>{selectedNodeData.filename}</p>
                </div>
                <div>
                  <div className="section-title">Kind</div>
                  <span className="chip">{selectedNodeData.kind}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
