"use client";

import { useState, useEffect, type FormEvent } from "react";
import { api, type Workspace, type Run } from "../../../lib/api";
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
      </div>
    </div>
  );
}
