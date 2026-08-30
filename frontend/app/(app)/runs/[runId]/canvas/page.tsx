"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, type Run } from "../../../../../lib/api";
import RunCanvas from "../../../../../components/workbench/RunCanvas";

export default function RunCanvasPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.getRun(runId)
      .then(({ run }) => setRun(run))
      .catch(err => setError(err.message));
  }, [runId]);

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
          <h1 style={{ fontSize: 16, fontWeight: 600 }}>Workflow Visualizer</h1>
        </div>
        {run && (
          <span className={`status status-${run.status.toLowerCase()}`}>
            {run.status}
          </span>
        )}
      </header>
      
      <main style={{ flex: 1, position: "relative", borderRadius: 16, overflow: "hidden", border: "1px solid var(--line)", marginTop: 16 }} className="animated-border">
        {error ? (
          <div style={{ padding: 24, color: "var(--red)" }}>{error}</div>
        ) : !run ? (
          <div style={{ padding: 24, color: "var(--ink-2)" }}>Loading canvas...</div>
        ) : (
          <RunCanvas run={run} />
        )}
      </main>
    </div>
  );
}
