"use client";

import type { Run, Artifact } from "../../lib/api";
import LoadingState from "../ui/LoadingState";
import AgentTrace from "../ui/AgentTrace";
import StatusBadge from "../ui/StatusBadge";
import { api } from "../../lib/api";

interface Props {
  run: Run;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export default function RunTrace({ run }: Props) {
  const isRunning = !TERMINAL.has(run.status);

  return (
    <section className="card" id="trace-panel" style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusBadge status={run.status} />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span className="chip">{run.modelProfile}</span>
              <span className="chip">{run.taskCapability}</span>
            </div>
          </div>
          {/* Model reason tightly grouped under the chips */}
          {run.modelReason && (
            <p style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5, maxWidth: 640 }}>
              {run.modelReason}
            </p>
          )}
        </div>
        {isRunning && (
          <div style={{ flexShrink: 0, marginTop: 4 }}>
            <LoadingState label="Agent running" variant="Dots" />
          </div>
        )}
      </div>

      <div className="divider" style={{ margin: "4px 0" }} />

      {/* Tool call trace */}
      <AgentTrace toolCalls={run.toolCalls ?? []} isRunning={isRunning} />

      {/* Evidence */}
      {run.evidence && run.evidence.length > 0 && (
        <EvidenceSection evidence={run.evidence} />
      )}

      {/* Analysis result */}
      {run.result?.analysis && (
        <AnalysisSection analysis={run.result.analysis} />
      )}

      {/* Artifact download */}
      {run.result?.artifact && (
        <ArtifactRow artifact={run.result.artifact} />
      )}
    </section>
  );
}

function EvidenceSection({ evidence }: { evidence: Run["evidence"] }) {
  return (
    <div style={{ minWidth: 0 }}>
      <p className="section-title">Evidence</p>
      <div className="evidence-list">
        {evidence!.map((ev) => (
          <div key={ev.id} className="evidence-item" style={{ wordBreak: "break-word" }}>
            <strong>{ev.title}</strong>
            <p>{ev.summary.slice(0, 240)}{ev.summary.length > 240 ? "…" : ""}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalysisSection({ analysis }: { analysis: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <p className="section-title">Analysis</p>
      <pre className="analysis-pre" style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{analysis}</pre>
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: Artifact }) {
  return (
    <button
      id="artifact-download"
      type="button"
      className="btn-ghost"
      style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 8 }}
      onClick={() => api.downloadArtifact(artifact.id, artifact.filename)}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      Download {artifact.filename}
    </button>
  );
}
