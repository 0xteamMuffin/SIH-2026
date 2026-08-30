"use client";

import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import {
  ReactFlow, Controls, Background, Handle, Position, MarkerType,
  type Node, type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  api, type Workspace, type Run, type Artifact,
} from "../../../lib/api";
import { nodeTypes, buildGraph, TraceStep } from "../../../components/workbench/CanvasNodes";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

// ─── Main Application ─────────────────────────────────────────────────────────
export default function WorkbenchPage() {
  // Navigation State
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState("");
  const [wsLoading, setWsLoading] = useState(true);
  const [newWsName, setNewWsName] = useState("");
  const [leftTab, setLeftTab] = useState<"runs" | "artifacts">("runs");

  // Interaction State
  const [task, setTask] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [runLoading, setRunLoading] = useState(false);

  // Data State
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [runsList, setRunsList] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null); // The active live run
  const [viewingRun, setViewingRun] = useState<Run | null>(null); // The historical run selected

  // Graph State
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeData, setSelectedNodeData] = useState<any>(null);
  const [rfInstance, setRfInstance] = useState<any>(null);


  // Load Initial Workspaces
  useEffect(() => {
    api.getWorkspaces().then(d => { setWorkspaces(d.workspaces); if (d.workspaces.length) setSelectedWs(d.workspaces[0].id); }).finally(() => setWsLoading(false));
  }, []);

  // Load Context on Workspace Change
  useEffect(() => {
    if (!selectedWs) { setArtifacts([]); setRunsList([]); return; }
    api.getWorkspaceArtifacts(selectedWs).then(d => setArtifacts(d.artifacts)).catch(console.error);
    api.getWorkspaceRuns(selectedWs).then(d => { setRunsList(d.runs); if (!run && !viewingRun && d.runs.length > 0) setViewingRun(d.runs[0]); }).catch(console.error);
  }, [selectedWs]);

  // Live Run Polling
  useEffect(() => {
    if (!run || TERMINAL.has(run.status)) return;
    const timer = setInterval(async () => {
      try { const r = await api.getRun(run.id); setRun(r); if (TERMINAL.has(r.status)) refreshHistory(); } catch {}
    }, 1500);
    return () => clearInterval(timer);
  }, [run]);

  const refreshHistory = () => {
    api.getWorkspaceArtifacts(selectedWs).then(d => setArtifacts(d.artifacts)).catch(console.error);
    api.getWorkspaceRuns(selectedWs).then(d => setRunsList(d.runs)).catch(console.error);
  };

  const displayRun = run ?? viewingRun;
  const isRunActive = run ? !TERMINAL.has(run.status) : false;

  const { nodes, edges } = useMemo(() =>
    displayRun ? buildGraph(displayRun, selectedNodeId) : { nodes: [], edges: [] },
    [displayRun, selectedNodeId]
  );

  // Auto-fit view when nodes are added
  useEffect(() => {
    if (rfInstance) {
      setTimeout(() => rfInstance.fitView({ padding: 0.2, duration: 800, maxZoom: 1.2 }), 50);
    }
  }, [nodes.length, rfInstance]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedWs || !task.trim()) return;
    setRunLoading(true); setRun(null); setViewingRun(null); setSelectedNodeId(null); setSelectedNodeData(null);
    try {
      let artifactId: string | undefined;
      if (file) { const d = await api.uploadArtifact(selectedWs, file); artifactId = d.artifact.id; }
      const d = await api.createRun(selectedWs, task, artifactId);
      setRun(d.run); setTask(""); setFile(null); refreshHistory();
    } catch (err) { console.error(err); } finally { setRunLoading(false); }
  }

  return (
    <div style={{ display: "flex", height: "100vh", width: "100%", overflow: "hidden", background: "var(--canvas)" }}>
      
      {/* ─── PANE 1: LEFT NAVIGATION ─────────────────────────────────────────── */}
      <div style={{ width: 280, flexShrink: 0, background: "rgba(12,12,14,0.95)", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", zIndex: 20 }}>
        
        {/* Workspace Selector */}
        <div style={{ padding: "16px", borderBottom: "1px solid var(--line)" }}>
          <select value={selectedWs} onChange={e => { setSelectedWs(e.target.value); setRun(null); setViewingRun(null); }} style={{ width: "100%", padding: "8px 12px", background: "rgba(255,255,255,0.05)", border: "1px solid var(--line)", borderRadius: 8, color: "#fff", outline: "none", fontSize: 13, appearance: "none", cursor: "pointer" }}>
            {workspaces.map(w => <option key={w.id} value={w.id} style={{ background: "#1c1c1e", color: "#fff" }}>{w.name}</option>)}
          </select>
          <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
            <input value={newWsName} onChange={e => setNewWsName(e.target.value)} placeholder="New workspace…" style={{ flex: 1, padding: "6px 10px", background: "transparent", border: "1px solid var(--line)", borderRadius: 6, color: "var(--ink)", fontSize: 12 }} />
            <button onClick={() => { if (newWsName) api.createWorkspace(newWsName).then(d => { setWorkspaces(p => [d.workspace, ...p]); setSelectedWs(d.workspace.id); setNewWsName(""); }); }} style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, width: 30, height: 30 }}>+</button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--line)", background: "rgba(0,0,0,0.2)" }}>
          <button onClick={() => setLeftTab("runs")} style={{ flex: 1, padding: "12px", fontSize: 12, fontWeight: 600, borderBottom: `2px solid ${leftTab === "runs" ? "var(--accent)" : "transparent"}`, color: leftTab === "runs" ? "var(--ink)" : "var(--ink-3)" }}>Runs</button>
          <button onClick={() => setLeftTab("artifacts")} style={{ flex: 1, padding: "12px", fontSize: 12, fontWeight: 600, borderBottom: `2px solid ${leftTab === "artifacts" ? "var(--accent)" : "transparent"}`, color: leftTab === "artifacts" ? "var(--ink)" : "var(--ink-3)" }}>Artifacts</button>
        </div>

        {/* Tab Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px" }}>
          {leftTab === "runs" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {runsList.map(r => {
                const isActive = (displayRun?.id === r.id);
                return (
                  <button key={r.id} onClick={() => { setViewingRun(r); setRun(null); setSelectedNodeData(null); setSelectedNodeId(null); }} style={{ textAlign: "left", padding: "12px", borderRadius: 8, background: isActive ? "var(--field)" : "transparent", border: `1px solid ${isActive ? "rgba(249,115,22,0.3)" : "transparent"}`, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className={`status status-${r.status.toLowerCase()}`} style={{ fontSize: 9 }}>{r.status}</span>
                      <span style={{ fontSize: 10, color: "var(--ink-3)", fontFamily: "monospace" }}>{r.modelProfile}</span>
                    </div>
                    <span style={{ fontSize: 12, color: "var(--ink)", lineHeight: 1.4 }}>{r.task.slice(0, 70)}{r.task.length > 70 ? "…" : ""}</span>
                  </button>
                );
              })}
            </div>
          )}
          {leftTab === "artifacts" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {artifacts.map(a => (
                <div key={a.id} style={{ padding: "10px", borderRadius: 8, background: "var(--field)", border: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <span style={{ fontSize: 12, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.filename}</span>
                  </div>
                  <button onClick={() => api.downloadArtifact(a.id, a.filename)} className="btn-ghost" style={{ padding: "4px 6px", fontSize: 10 }}>↓</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ─── PANE 2: CENTER VISUALIZATION & INTERACTION ──────────────────────── */}
      <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", background: "var(--canvas)" }}>
        
        {/* React Flow Canvas Area */}
        <div style={{ flex: 1, position: "relative" }}>
          {!displayRun ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>
              <span style={{ color: "var(--ink-3)", fontSize: 14 }}>Select a run from the left panel or start a new task below.</span>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes}
              onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedNodeData(node.data); }}
              onPaneClick={() => { setSelectedNodeId(null); setSelectedNodeData(null); }}
              onInit={setRfInstance}
              fitView fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="rgba(255,255,255,0.03)" gap={24} size={2} />
            </ReactFlow>
          )}
        </div>

        {/* Bottom Command Bar */}
        <div style={{ padding: "20px", display: "flex", justifyContent: "center", borderTop: "1px solid var(--line)", background: "rgba(12,12,14,0.95)", zIndex: 10 }}>
          <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 800, background: "var(--field)", border: "1px solid var(--line)", borderRadius: 12, padding: "8px 12px", display: "flex", alignItems: "center", gap: 12, transition: "border-color 200ms" }} onFocus={e => e.currentTarget.style.borderColor = "rgba(249,115,22,0.5)"} onBlur={e => e.currentTarget.style.borderColor = "var(--line)"}>
            
            <label style={{ cursor: "pointer", color: file ? "var(--accent)" : "var(--ink-3)", display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 8, background: file ? "rgba(249,115,22,0.1)" : "transparent", transition: "all 150ms" }} title={file ? file.name : "Attach a file"}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6A4 4 0 0 1 18 9l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>
              <input type="file" style={{ display: "none" }} onChange={e => setFile(e.target.files?.[0] ?? null)} />
            </label>

            <input value={task} onChange={e => setTask(e.target.value)} placeholder="Ask the agent to do something..." style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--ink)", fontSize: 14 }} />
            
            <div style={{ display: "flex", gap: 8 }}>
              {isRunActive && <button type="button" onClick={() => run && api.cancelRun(run.id).then(r => setRun(r.run))} className="btn-danger" style={{ padding: "6px 12px", fontSize: 12 }}>Stop</button>}
              <button type="submit" disabled={runLoading || !selectedWs || !task.trim()} style={{ background: (runLoading || !selectedWs || !task.trim()) ? "rgba(255,255,255,0.05)" : "var(--accent)", color: (runLoading || !selectedWs || !task.trim()) ? "var(--ink-3)" : "#fff", border: "none", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: (runLoading || !selectedWs || !task.trim()) ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {runLoading ? <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* ─── FLOATING RIGHT PANE: OBSERVABILITY & DEEP DIVE ────────────────── */}
      {selectedNodeData && (
        <div style={{ position: "absolute", right: 24, top: 24, bottom: 24, width: 400, background: "rgba(12,12,14,0.85)", backdropFilter: "blur(24px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, display: "flex", flexDirection: "column", zIndex: 20, boxShadow: "0 12px 48px rgba(0,0,0,0.6)", animation: "nodeAppear 0.3s cubic-bezier(0.16, 1, 0.3, 1)" }}>
          
          {/* Right Pane Header */}
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between", height: 53, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--ink-2)" }}>
            {selectedNodeData ? "Node Deep Dive" : "Run Execution Trace"}
          </span>
          {selectedNodeData && <button onClick={() => { setSelectedNodeId(null); setSelectedNodeData(null); }} className="btn-ghost" style={{ padding: "4px 6px" }}>Close Node</button>}
        </div>

        {/* Right Pane Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 20px" }}>
          {!displayRun && !selectedNodeData && (
             <p style={{ color: "var(--ink-3)", fontSize: 13, textAlign: "center", marginTop: 40 }}>Select a run to view its trace.</p>
          )}

          {/* MODE A: Show Run Trace Timeline if no node is selected */}
          {displayRun && !selectedNodeData && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "relative" }}>
              <div style={{ position: "absolute", left: 16, top: 20, bottom: 20, width: 2, background: "var(--line)" }} />
              
              <TraceStep icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>} title="Task Dispatched" desc={displayRun.task} />
              <TraceStep icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M12 12L2.1 12A10 10 0 0 1 12 2v10z"/></svg>} title="Model Router" desc={`Routed to ${displayRun.modelProfile} (${displayRun.taskCapability})`} />
              
              {(displayRun.toolCalls ?? []).map((tc, i) => (
                <TraceStep key={i} icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>} title={tc.toolName} desc={tc.status} status={tc.status} />
              ))}
              
              <TraceStep icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>} title="Workflow Concluded" desc={`Status: ${displayRun.status}`} />
            </div>
          )}

          {/* MODE B: Show Node Deep Dive if a node is selected */}
          {selectedNodeData && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              {selectedNodeData.nodeType === "task" && (
                <div><div className="section-title">Initial Prompt</div><p style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.6 }}>{selectedNodeData.label}</p></div>
              )}
              {selectedNodeData.nodeType === "agent" && (<>
                <div><div className="section-title">Routing Logic</div><p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>{selectedNodeData.reason}</p></div>
                <div style={{ display: "flex", gap: 12 }}><div style={{ flex: 1 }}><div className="section-title">Profile</div><span className="chip">{selectedNodeData.profile}</span></div><div style={{ flex: 1 }}><div className="section-title">Capability</div><span className="chip">{selectedNodeData.capability}</span></div></div>
              </>)}
              {selectedNodeData.nodeType === "tool" && (<>
                <div><div className="section-title">Tool Status</div><span className={`status status-${selectedNodeData.status.toLowerCase()}`}>{selectedNodeData.status}</span></div>
                {selectedNodeData.toolCall?.input && <div><div className="section-title">JSON Payload (Input)</div><pre style={{ fontSize: 11, background: "rgba(0,0,0,0.3)", padding: 12, borderRadius: 8, border: "1px solid var(--line)", overflowX: "auto", color: "var(--green)" }}>{JSON.stringify(selectedNodeData.toolCall.input, null, 2)}</pre></div>}
                {selectedNodeData.toolCall?.output && <div><div className="section-title">JSON Response (Output)</div><pre style={{ fontSize: 11, background: "rgba(0,0,0,0.3)", padding: 12, borderRadius: 8, border: "1px solid var(--line)", overflowX: "auto", color: "var(--ink-2)" }}>{JSON.stringify(selectedNodeData.toolCall.output, null, 2)}</pre></div>}
              </>)}
              {selectedNodeData.nodeType === "end" && (
                <div><div className="section-title">Final Payload</div><pre style={{ fontSize: 11, background: "rgba(0,0,0,0.3)", padding: 12, borderRadius: 8, border: "1px solid var(--line)", overflowX: "auto", color: "var(--ink)" }}>{JSON.stringify(selectedNodeData.result, null, 2)}</pre></div>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
