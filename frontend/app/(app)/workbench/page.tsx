"use client";

import { useState, useEffect, type FormEvent } from "react";
import { api, type Workspace, type Run, type Artifact } from "../../../lib/api";
import WorkspacePanel from "../../../components/workbench/WorkspacePanel";
import TaskForm from "../../../components/workbench/TaskForm";
import RunTrace from "../../../components/workbench/RunTrace";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export default function WorkbenchPage() {
  // ── Workspaces ──────────────────────────────────────────
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState("");
  const [wsLoading, setWsLoading] = useState(true);
  const [newWsName, setNewWsName] = useState("");
  const [wsError, setWsError] = useState("");

  // ── Run ──────────────────────────────────────────────────
  const [task, setTask] = useState(
    "Read this inspection report and draft an approval note with the key findings."
  );
  const [file, setFile] = useState<File | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState("");
  
  // ── History ──────────────────────────────────────────────
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [runsList, setRunsList] = useState<Run[]>([]);

  // Load workspaces on mount
  useEffect(() => {
    api
      .getWorkspaces()
      .then((d) => {
        setWorkspaces(d.workspaces);
        if (d.workspaces.length > 0) setSelectedWs(d.workspaces[0].id);
      })
      .catch((err) => setWsError(err.message))
      .finally(() => setWsLoading(false));
  }, []);

  // Fetch history when workspace changes
  useEffect(() => {
    if (!selectedWs) {
      setArtifacts([]);
      setRunsList([]);
      return;
    }
    api.getWorkspaceArtifacts(selectedWs).then(d => setArtifacts(d.artifacts)).catch(console.error);
    api.getWorkspaceRuns(selectedWs).then(d => setRunsList(d.runs)).catch(console.error);
  }, [selectedWs]);

  // Poll run while active
  useEffect(() => {
    if (!run || TERMINAL.has(run.status)) return;
    const timer = setInterval(async () => {
      try {
        const updated = await api.getRun(run.id);
        setRun(updated);
      } catch {}
    }, 1500);
    return () => clearInterval(timer);
  }, [run]);

  async function handleCreateWorkspace() {
    const name = newWsName.trim();
    if (!name) return;
    setWsError("");
    try {
      const d = await api.createWorkspace(name);
      setWorkspaces((prev) => [d.workspace, ...prev]);
      setSelectedWs(d.workspace.id);
      setNewWsName("");
    } catch (err) {
      setWsError(err instanceof Error ? err.message : "Failed to create workspace");
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedWs) { setRunError("Select a workspace first"); return; }
    if (!task.trim()) { setRunError("Enter a task description"); return; }
    setRunError("");
    setRunLoading(true);
    setRun(null);
    try {
      let artifactId: string | undefined;
      if (file) {
        const d = await api.uploadArtifact(selectedWs, file);
        artifactId = d.artifact.id;
      }
      const d = await api.createRun(selectedWs, task, artifactId);
      setRun(d.run);
      // Refresh history immediately
      api.getWorkspaceArtifacts(selectedWs).then(d => setArtifacts(d.artifacts)).catch(console.error);
      api.getWorkspaceRuns(selectedWs).then(d => setRunsList(d.runs)).catch(console.error);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunLoading(false);
    }
  }

  async function handleCancel() {
    if (!run) return;
    try {
      const d = await api.cancelRun(run.id);
      setRun(d.run);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  const isRunActive = run ? !TERMINAL.has(run.status) : false;

  return (
    <div className="workbench">
      <WorkspacePanel
        workspaces={workspaces}
        selected={selectedWs}
        loading={wsLoading}
        newName={newWsName}
        error={wsError}
        onSelect={setSelectedWs}
        onNewName={setNewWsName}
        onCreate={handleCreateWorkspace}
      />

      <div className="task-panel">
        <TaskForm
          task={task}
          file={file}
          loading={runLoading}
          hasWorkspace={!!selectedWs}
          error={runError}
          isRunning={isRunActive}
          onTask={setTask}
          onFile={setFile}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />

        {run && <RunTrace run={run} />}

        {artifacts.length > 0 && (
          <section className="card animated-border" style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both", marginTop: 8 }}>
            <h2 className="card-title">Workspace Files</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {artifacts.map(a => (
                <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--inset)", borderRadius: 8, border: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                      <line x1="16" y1="13" x2="8" y2="13"></line>
                      <line x1="16" y1="17" x2="8" y2="17"></line>
                      <polyline points="10 9 9 9 8 9"></polyline>
                    </svg>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{a.filename}</span>
                    <span className="chip" style={{ fontSize: 10 }}>{a.kind}</span>
                  </div>
                  <button type="button" className="btn-ghost" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => api.downloadArtifact(a.id, a.filename)}>Download</button>
                </div>
              ))}
            </div>
          </section>
        )}

        {runsList.filter(r => r.id !== run?.id).length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <h2 className="section-title" style={{ marginTop: 8 }}>Run History</h2>
            {runsList.filter(r => r.id !== run?.id).map(r => (
              <RunTrace key={r.id} run={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
