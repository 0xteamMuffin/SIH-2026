"use client";

import { useState, useEffect, useMemo, useRef, type FormEvent } from "react";
import {
  ReactFlow, Background,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api, type Workspace, type Run, type Artifact, type DataClassification,
} from "../../../lib/api";
import { nodeTypes, buildGraph } from "../../../components/workbench/CanvasNodes";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

function FilePreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  if (!url) return null;
  return (
    <iframe title={`Preview ${file.name}`} src={url} sandbox="" style={{ width: "100%", height: "100%", border: 0 }} />
  );
}

// The agent's side of a turn — content depends on where the run currently is.
function AssistantMessage({ run, onViewTrace, isViewing }: { run: Run; onViewTrace: () => void; isViewing: boolean }) {
  const busy = run.status === "PENDING" || run.status === "RUNNING";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", color: "var(--ink-3)" }}>AGENT</span>
        <span className={`status status-${run.status.toLowerCase()}`} style={{ fontSize: 9 }}>{run.status}</span>
        <span style={{ fontSize: 10, color: "var(--ink-3)", fontFamily: "monospace" }}>{run.modelProfile}</span>
      </div>
      <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, borderTopLeftRadius: 2, padding: "12px 14px", width: "100%" }}>
        {busy && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-3)", fontSize: 13 }}>
            <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            {run.status === "PENDING" ? "Queued…" : "Working…"}
          </div>
        )}
        {run.status === "WAITING_APPROVAL" && (
          <p style={{ fontSize: 13, color: "var(--ink-2)" }}>Waiting on reviewer approval before continuing.</p>
        )}
        {run.status === "FAILED" && (
          <p style={{ fontSize: 13, color: "var(--red)" }}>The run failed. Open the trace on the right for details.</p>
        )}
        {run.status === "CANCELLED" && (
          <p style={{ fontSize: 13, color: "var(--ink-3)" }}>Cancelled.</p>
        )}
        {run.status === "COMPLETED" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {run.result?.analysis && (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.result.analysis}</ReactMarkdown>
              </div>
            )}
            {run.result?.artifact && (
              <button
                onClick={() => api.downloadArtifact(run.result!.artifact!.id, run.result!.artifact!.filename)}
                className="btn-ghost"
                style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                {run.result.artifact.filename}
              </button>
            )}
            {!run.result?.analysis && !run.result?.artifact && <p style={{ fontSize: 13, color: "var(--ink-3)" }}>Completed.</p>}
          </div>
        )}
      </div>
      <button onClick={onViewTrace} className="btn-ghost" style={{ fontSize: 11.5, padding: "4px 10px", borderColor: isViewing ? "rgba(249,115,22,0.4)" : "var(--line)", color: isViewing ? "var(--accent)" : "var(--ink-3)" }}>
        {isViewing ? "Viewing trace →" : "View trace →"}
      </button>
    </div>
  );
}

// ─── Main Application ─────────────────────────────────────────────────────────
export default function WorkbenchPage() {
  // Navigation State
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState("");
  const [wsLoading, setWsLoading] = useState(true);
  const [newWsName, setNewWsName] = useState("");
  const [leftTab, setLeftTab] = useState<"runs" | "artifacts">("runs");

  // Mobile drawer state — the left nav and right trace panel become slide-in
  // drawers below the 860px breakpoint (see .wb-left/.wb-right in globals.css).
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  // Interaction State
  const [task, setTask] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [classification, setClassification] = useState<DataClassification>("SYNTHETIC");
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState("");

  // Data State
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [runsList, setRunsList] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null); // The active live run
  const [viewingRun, setViewingRun] = useState<Run | null>(null); // The run shown in the right-hand trace panel

  // Graph State
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeData, setSelectedNodeData] = useState<any>(null);
  const [rfInstance, setRfInstance] = useState<any>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  const threadEndRef = useRef<HTMLDivElement>(null);

  // Load Initial Workspaces
  useEffect(() => {
    api.getWorkspaces()
      .then(d => { setWorkspaces(d.workspaces); if (d.workspaces.length) setSelectedWs(d.workspaces[0].id); })
      .catch(err => setError(err instanceof Error ? err.message : "Failed to load workspaces"))
      .finally(() => setWsLoading(false));
  }, []);

  // Load Context on Workspace Change
  useEffect(() => {
    if (!selectedWs) { setArtifacts([]); setRunsList([]); return; }
    setError("");
    api.getWorkspaceArtifacts(selectedWs).then(d => setArtifacts(d.artifacts)).catch(err => setError(err instanceof Error ? err.message : "Failed to load artifacts"));
    api.getWorkspaceRuns(selectedWs).then(d => { setRunsList(d.runs); if (!run && !viewingRun && d.runs.length > 0) setViewingRun(d.runs[0]); }).catch(err => setError(err instanceof Error ? err.message : "Failed to load runs"));
  }, [selectedWs]);

  // Live Run Polling
  useEffect(() => {
    if (!run || TERMINAL.has(run.status)) return;
    const timer = setInterval(async () => {
      try {
        const { run: updatedRun } = await api.getRun(run.id);
        setRun(updatedRun);
        if (TERMINAL.has(updatedRun.status)) refreshHistory();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to refresh run");
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [run]);

  const refreshHistory = () => {
    api.getWorkspaceArtifacts(selectedWs).then(d => setArtifacts(d.artifacts)).catch(err => setError(err instanceof Error ? err.message : "Failed to refresh artifacts"));
    api.getWorkspaceRuns(selectedWs).then(d => setRunsList(d.runs)).catch(err => setError(err instanceof Error ? err.message : "Failed to refresh runs"));
  };

  const displayRun = run ?? viewingRun;

  // Chronological (oldest → newest) conversation thread. The live-polled `run`
  // always wins over its stale counterpart in `runsList` for the same id.
  const threadRuns = useMemo(() => {
    const byId = new Map<string, Run>();
    for (const r of runsList) byId.set(r.id, r);
    if (run) byId.set(run.id, run);
    return Array.from(byId.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [runsList, run]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [threadRuns.length, run?.status]);

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

  function viewTrace(r: Run) {
    setSelectedNodeId(null);
    setSelectedNodeData(null);
    setLeftOpen(false);
    setRightOpen(true); // no-op on desktop; opens the drawer on mobile
    if (run?.id === r.id) { setViewingRun(null); return; } // already the live run being shown
    setError("");
    api.getRun(r.id).then(({ run: selectedRun }) => setViewingRun(selectedRun)).catch(err => setError(err instanceof Error ? err.message : "Failed to load run"));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedWs || !task.trim()) return;
    setError("");
    setRunLoading(true); setRun(null); setViewingRun(null); setSelectedNodeId(null); setSelectedNodeData(null);
    try {
      let artifactId: string | undefined;
      if (file) { const d = await api.uploadArtifact(selectedWs, file, classification); artifactId = d.artifact.id; }
      const d = await api.createRun(selectedWs, task, artifactId, classification);
      setRun(d.run); setTask(""); setFile(null); refreshHistory();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to start run"); } finally { setRunLoading(false); }
  }

  return (
    <div className="wb-shell">

      <div className={`wb-overlay ${(leftOpen || rightOpen) ? "wb-open" : ""}`} onClick={() => { setLeftOpen(false); setRightOpen(false); }} />

      {/* ─── PANE 1: LEFT NAVIGATION ─────────────────────────────────────────── */}
      <div className={`wb-left ${leftOpen ? "wb-open" : ""}`}>

        {/* Workspace Selector */}
        <div style={{ padding: "16px", borderBottom: "1px solid var(--line)" }}>
          <select value={selectedWs} onChange={e => { setSelectedWs(e.target.value); setRun(null); setViewingRun(null); }} style={{ width: "100%", padding: "8px 12px", background: "rgba(255,255,255,0.05)", border: "1px solid var(--line)", borderRadius: 8, color: "#fff", outline: "none", fontSize: 13, appearance: "none", cursor: "pointer" }}>
            {workspaces.map(w => <option key={w.id} value={w.id} style={{ background: "#1c1c1e", color: "#fff" }}>{w.name}</option>)}
          </select>
          <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
            <input value={newWsName} onChange={e => setNewWsName(e.target.value)} placeholder="New workspace…" style={{ flex: 1, padding: "6px 10px", background: "transparent", border: "1px solid var(--line)", borderRadius: 6, color: "var(--ink)", fontSize: 12 }} />
            <button onClick={() => { if (newWsName) api.createWorkspace(newWsName).then(d => { setWorkspaces(p => [d.workspace, ...p]); setSelectedWs(d.workspace.id); setNewWsName(""); }).catch(err => setError(err instanceof Error ? err.message : "Failed to create workspace")); }} style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, width: 30, height: 30 }}>+</button>
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
                  <button key={r.id} onClick={() => viewTrace(r)} style={{ textAlign: "left", padding: "12px", borderRadius: 8, background: isActive ? "var(--field)" : "transparent", border: `1px solid ${isActive ? "rgba(249,115,22,0.3)" : "transparent"}`, display: "flex", flexDirection: "column", gap: 6 }}>
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
                  <button onClick={() => api.downloadArtifact(a.id, a.filename).catch(err => setError(err instanceof Error ? err.message : "Download failed"))} className="btn-ghost" style={{ padding: "4px 6px", fontSize: 10 }}>↓</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ─── PANE 2: CHAT THREAD ──────────────────────────────────────────────── */}
      <div className="wb-center">
        {/* Mobile-only top bar to reach the drawers */}
        <div className="wb-mobile-toggle" style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={() => setLeftOpen(true)} className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            Runs
          </button>
          <button onClick={() => setRightOpen(true)} className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }} disabled={!displayRun}>
            Trace
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/></svg>
          </button>
        </div>
        {error && (
          <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 30, maxWidth: 560, padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(239,68,68,0.35)", background: "rgba(69,10,10,0.92)", color: "var(--red)", fontSize: 12 }}>
            {error}
          </div>
        )}

        {/* Scrolling conversation */}
        <div style={{ flex: 1, overflowY: "auto", padding: "28px 32px" }}>
          {threadRuns.length === 0 ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>
              <span style={{ color: "var(--ink-3)", fontSize: 14 }}>Ask the agent something below to get started.</span>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 28, maxWidth: 720, margin: "0 auto" }}>
              {threadRuns.map(r => (
                <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {/* User turn */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", alignSelf: "flex-end", maxWidth: 640 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", color: "var(--ink-3)" }}>YOU</span>
                    <div style={{ background: "var(--accent-dim)", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 12, borderTopRightRadius: 2, padding: "10px 14px" }}>
                      <p style={{ fontSize: 13.5, color: "var(--ink)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{r.task}</p>
                    </div>
                  </div>
                  {/* Agent turn */}
                  <AssistantMessage run={r} onViewTrace={() => viewTrace(r)} isViewing={displayRun?.id === r.id} />
                </div>
              ))}
              <div ref={threadEndRef} />
            </div>
          )}
        </div>

        {/* Bottom Command Bar */}
        <div className="wb-command-bar" style={{ padding: "20px", display: "flex", justifyContent: "center", borderTop: "1px solid var(--line)", background: "rgba(12,12,14,0.95)", zIndex: 10 }}>
          <form onSubmit={handleSubmit} className="wb-command-form" style={{ width: "100%", maxWidth: 720, background: "var(--field)", border: "1px solid var(--line)", borderRadius: 12, padding: "8px 12px", display: "flex", alignItems: "center", gap: 12, transition: "border-color 200ms" }} onFocus={e => e.currentTarget.style.borderColor = "rgba(249,115,22,0.5)"} onBlur={e => e.currentTarget.style.borderColor = "var(--line)"}>

            <label style={{ cursor: "pointer", color: file ? "var(--accent)" : "var(--ink-3)", display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 8, background: file ? "rgba(249,115,22,0.1)" : "transparent", transition: "all 150ms", flexShrink: 0 }} title="Attach a file">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6A4 4 0 0 1 18 9l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>
              <input type="file" style={{ display: "none" }} onChange={e => setFile(e.target.files?.[0] ?? null)} />
            </label>

            {file && (
              <div
                style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--canvas)", border: "1px solid var(--line)", padding: "4px 8px", borderRadius: 6, cursor: "pointer" }}
                onClick={() => setShowPreviewModal(true)}
              >
                <span style={{ fontSize: 12, color: "var(--ink-2)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
                <button type="button" onClick={(e) => { e.stopPropagation(); setFile(null); }} style={{ background: "none", border: "none", color: "var(--ink-3)", cursor: "pointer", display: "flex", alignItems: "center", padding: 2 }}>✕</button>
              </div>
            )}

            <select aria-label="Data classification" value={classification} onChange={e => setClassification(e.target.value as DataClassification)} className="wb-classification-select" style={{ background: "var(--canvas)", border: "1px solid var(--line)", borderRadius: 6, color: "var(--ink-2)", padding: "6px 8px", fontSize: 11 }}>
              <option value="SYNTHETIC">Synthetic</option>
              <option value="PUBLIC">Public</option>
              <option value="INTERNAL">Internal (local model required)</option>
              <option value="CONFIDENTIAL">Confidential (local model required)</option>
            </select>

            <input value={task} onChange={e => setTask(e.target.value)} placeholder="Ask the agent to do something..." style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--ink)", fontSize: 14, minWidth: 0 }} />

            <div style={{ display: "flex", gap: 8 }}>
              {run && !TERMINAL.has(run.status) && <button type="button" onClick={() => run && api.cancelRun(run.id).then(r => setRun(r.run)).catch(err => setError(err instanceof Error ? err.message : "Failed to stop run"))} className="btn-danger" style={{ padding: "6px 12px", fontSize: 12 }}>Stop</button>}
              <button type="submit" disabled={runLoading || !selectedWs || !task.trim()} style={{ background: (runLoading || !selectedWs || !task.trim()) ? "rgba(255,255,255,0.05)" : "var(--accent)", color: (runLoading || !selectedWs || !task.trim()) ? "var(--ink-3)" : "#fff", border: "none", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: (runLoading || !selectedWs || !task.trim()) ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {runLoading ? <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* ─── PANE 3: RIGHTMOST — EXECUTION GRAPH / NODE DEEP DIVE ────────────── */}
      <div className={`wb-right ${rightOpen ? "wb-open" : ""}`}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between", height: 53, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--ink-2)" }}>
            {selectedNodeData ? "Node Deep Dive" : "Execution Graph"}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            {selectedNodeData && <button onClick={() => { setSelectedNodeId(null); setSelectedNodeData(null); }} className="btn-ghost" style={{ padding: "4px 6px", fontSize: 11 }}>Back to graph</button>}
            <button onClick={() => setRightOpen(false)} className="btn-ghost wb-mobile-toggle" style={{ padding: "4px 6px", fontSize: 11 }}>Close</button>
          </div>
        </div>

        {!displayRun && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
            <p style={{ color: "var(--ink-3)", fontSize: 13, textAlign: "center" }}>Select a message to view its trace.</p>
          </div>
        )}

        {displayRun && !selectedNodeData && (
          <div style={{ flex: 1, position: "relative" }}>
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
          </div>
        )}

        {displayRun && selectedNodeData && (
          <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
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
          </div>
        )}
      </div>

      {/* File Preview Modal */}
      {showPreviewModal && file && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.8)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setShowPreviewModal(false)}>
          <div style={{ background: "var(--canvas)", border: "1px solid var(--line)", borderRadius: 12, width: "90%", maxWidth: 1000, height: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{file.name}</span>
              <button onClick={() => setShowPreviewModal(false)} className="btn-ghost" style={{ padding: "4px 8px" }}>Close</button>
            </div>
            <div style={{ flex: 1, overflow: "hidden", background: "#fff" }}>
              <FilePreview file={file} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
