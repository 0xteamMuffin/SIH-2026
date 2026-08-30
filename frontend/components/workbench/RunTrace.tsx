"use client";

import { useMemo, useState, useEffect } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Run, ToolCall, Evidence, Artifact } from "../../lib/api";
import StatusBadge from "../ui/StatusBadge";
import { api } from "../../lib/api";
import DocViewer, { DocViewerRenderers } from "@cyntler/react-doc-viewer";


const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

// ── Colors from Screenshot ──────────────────────────────────────────────────
const C = {
  green: "#22c55e",
  blue: "#3b82f6",
  pink: "#ec4899",
  purple: "#a855f7",
  orange: "#f59e0b",
  gray: "#71717a",
  red: "#f87171",
  bg: "#111113",
  border: "rgba(255,255,255,0.08)",
  inputBg: "rgba(255,255,255,0.03)",
};

// ── Custom Node Components ──────────────────────────────────────────────────

function HighlightedJSON({ data }: { data: any }) {
  if (!data) return null;
  const jsonStr = JSON.stringify(data, null, 2);
  const colorized = jsonStr.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g,
    (match, p1, p2, p3) => {
      let color = "#eab308"; // number
      if (p1) {
        // string (key or value)
        color = "#22c55e";
        return `<span style="color: ${color}">${p1}</span>${p3 || ""}`;
      } else if (/true|false/.test(match)) {
        color = "#3b82f6";
      } else if (/null/.test(match)) {
        color = "#ef4444";
      }
      return `<span style="color: ${color}">${match}</span>`;
    }
  );
  return (
    <pre style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.5, color: "#a1a1aa", overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: colorized }} />
  );
}

function ArtifactViewer({ artifact }: { artifact: Artifact }) {
  const [url, setUrl] = useState<string>("");
  useEffect(() => {
    api.getArtifactBlobUrl(artifact.id).then(setUrl).catch(console.error);
  }, [artifact.id]);

  if (!url) return <div style={{ color: "var(--ink-3)", fontSize: 13, padding: 12 }}>Loading document...</div>;
  
  return (
    <div style={{ borderRadius: 8, overflow: "hidden", border: `1px solid ${C.border}`, height: 400, marginTop: 8, background: "#fff" }}>
      <DocViewer 
        documents={[{ uri: url, fileType: artifact.filename.split('.').pop() }]} 
        pluginRenderers={DocViewerRenderers} 
        config={{ header: { disableHeader: true } }}
        style={{ width: "100%", height: "100%" }} 
      />
    </div>
  );
}

function NodeHeader({ title, dotColor, isSelected }: { title: string; dotColor: string; isSelected?: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 14px", borderBottom: `1px solid ${C.border}`,
      background: isSelected ? "rgba(255,255,255,0.05)" : "transparent"
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: dotColor }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "#fff", fontFamily: "var(--sans)" }}>{title}</span>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    </div>
  );
}

function NodeRow({
  id, label, type, color, isList = false, rightAlign = false
}: {
  id?: string; label: string; type: "source" | "target" | "none"; color: string; isList?: boolean; rightAlign?: boolean;
}) {
  return (
    <div style={{
      position: "relative", padding: "8px 14px", display: "flex", alignItems: "center",
      justifyContent: rightAlign ? "flex-end" : "flex-start", gap: 8
    }}>
      {type === "target" && (
        <Handle type="target" id={id} position={Position.Left} style={{ background: color, border: "none", width: 6, height: 6, left: -3 }} />
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {!rightAlign && isList && <span style={{ color, fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600 }}>[ ]</span>}
        {!rightAlign && !isList && <div style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />}

        <span style={{ fontSize: 12, color: "var(--ink-2)", fontFamily: "var(--sans)" }}>{label}</span>

        {rightAlign && isList && <span style={{ color, fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600 }}>[ ]</span>}
        {rightAlign && !isList && <div style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />}
      </div>

      {type === "source" && (
        <Handle type="source" id={id} position={Position.Right} style={{ background: color, border: "none", width: 6, height: 6, right: -3 }} />
      )}
    </div>
  );
}

function NodeBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "0 14px 12px 14px" }}>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6 }}>{label}</div>
      <div style={{
        background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 6,
        padding: "8px 10px", fontSize: 12, color: "var(--ink-2)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
      }}>
        {value}
      </div>
    </div>
  );
}

const nodeTypes = {
  startNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <div style={{ background: C.bg, border: `1px solid ${selected ? C.green : C.border}`, borderRadius: 10, width: 280, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
      <NodeHeader title="Task Initialization" dotColor={C.green} isSelected={selected} />
      <div style={{ padding: "12px 0" }}>
        <NodeRow label="Task Output" type="source" color={C.green} isList rightAlign />
        <NodeBox label="Model Profile" value={data.run.modelProfile} />
        <NodeBox label="Task Capability" value={data.run.taskCapability} />
      </div>
      <div style={{ padding: "10px 14px", borderTop: `1px solid #27272a`, fontSize: 11, color: "var(--ink-3)", display: "flex", justifyContent: "space-between", cursor: "pointer" }}>
        <span>Advanced settings</span>
        <span>›</span>
      </div>
    </div>
  ),

  doneNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <div style={{ background: C.bg, border: `1px solid ${selected ? C.green : C.border}`, borderRadius: 10, width: 280, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
      <NodeHeader title="Done" dotColor={C.green} isSelected={selected} />
      <div style={{ padding: "12px 14px" }}>
        <span style={{ color: C.green, fontWeight: 700, fontSize: 13, fontFamily: "var(--mono)" }}>COMPLETED</span>
      </div>
    </div>
  ),

  toolNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <div style={{ background: C.bg, border: `1px solid ${selected ? C.blue : C.border}`, borderRadius: 10, width: 280, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
      <NodeHeader title={data.tool.toolName} dotColor={C.blue} isSelected={selected} />
      <div style={{ padding: "12px 0" }}>
        <NodeRow id="in" label="Tool Input" type="target" color={C.blue} />
        <NodeRow id="out" label="Tool Output" type="source" color={C.blue} rightAlign />
        <NodeBox label="Status" value={data.tool.status} />
      </div>
    </div>
  ),

  evidenceNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <div style={{ background: C.bg, border: `1px solid ${selected ? C.pink : C.border}`, borderRadius: 10, width: 280, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
      <NodeHeader title="Evidence Gathered" dotColor={C.pink} isSelected={selected} />
      <div style={{ padding: "12px 0" }}>
        <NodeRow id="in" label="Source" type="target" color={C.pink} />
        <NodeRow id="out" label="Evidence" type="source" color={C.pink} rightAlign />
        <NodeBox label="Title" value={data.evidence.title} />
      </div>
    </div>
  ),

  analysisNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <div style={{ background: C.bg, border: `1px solid ${selected ? C.purple : C.border}`, borderRadius: 10, width: 280, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
      <NodeHeader title="Final Analysis" dotColor={C.purple} isSelected={selected} />
      <div style={{ padding: "12px 0" }}>
        <NodeRow id="in" label="Analysis Input" type="target" color={C.purple} />
        <NodeRow id="out" label="Analysis Output" type="source" color={C.purple} rightAlign />
      </div>
    </div>
  ),

  artifactNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <div style={{ background: C.bg, border: `1px solid ${selected ? C.gray : C.border}`, borderRadius: 10, width: 280, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
      <NodeHeader title="Output Layout" dotColor={C.gray} isSelected={selected} />
      <div style={{ padding: "12px 0" }}>
        <NodeRow id="in" label="File Artifact" type="target" color={C.blue} isList />
        <NodeBox label="Filename" value={data.artifact.filename} />
      </div>
    </div>
  ),
};

// ── Graph Builder ───────────────────────────────────────────────────────────

function buildGraph(run: Run) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const X_SPACING = 380;
  const Y_SPACING = 220;

  let currentX = 50;

  nodes.push({
    id: "start",
    type: "startNode",
    position: { x: currentX, y: 150 },
    data: { type: "start", run },
  });

  let lastNodeId = "start";
  currentX += X_SPACING;

  if (run.toolCalls && run.toolCalls.length > 0) {
    run.toolCalls.forEach((tool, idx) => {
      const nodeId = `tool-${idx}`;
      nodes.push({
        id: nodeId,
        type: "toolNode",
        position: { x: currentX, y: 150 },
        data: { type: "tool", tool },
      });
      edges.push({
        id: `e-${lastNodeId}-${nodeId}`,
        source: lastNodeId,
        target: nodeId,
        animated: tool.status === "RUNNING",
        style: { stroke: tool.status === "COMPLETED" ? C.blue : tool.status === "FAILED" ? C.red : C.orange, strokeWidth: 2, strokeDasharray: "5 5" },
        type: "smoothstep",
      });
      lastNodeId = nodeId;
      currentX += X_SPACING;
    });
  }

  if (run.evidence && run.evidence.length > 0) {
    const evX = currentX;
    run.evidence.forEach((ev, idx) => {
      const nodeId = `ev-${idx}`;
      nodes.push({
        id: nodeId,
        type: "evidenceNode",
        position: { x: evX, y: 150 + (idx % 2 === 0 ? 1 : -1) * Y_SPACING * Math.ceil((idx + 1) / 2) },
        data: { type: "evidence", evidence: ev },
      });
      edges.push({
        id: `e-${lastNodeId}-${nodeId}`,
        source: lastNodeId,
        target: nodeId,
        style: { stroke: C.pink, strokeWidth: 2, strokeDasharray: "5 5" },
        type: "smoothstep",
      });
    });
    currentX += X_SPACING;
  }

  if (run.result?.analysis) {
    nodes.push({
      id: "analysis",
      type: "analysisNode",
      position: { x: currentX, y: 150 },
      data: { type: "analysis", analysis: run.result.analysis },
    });
    edges.push({
      id: `e-${lastNodeId}-analysis`,
      source: lastNodeId,
      target: "analysis",
      animated: !TERMINAL.has(run.status),
      style: { stroke: C.purple, strokeWidth: 2, strokeDasharray: "5 5" },
      type: "smoothstep",
    });
    lastNodeId = "analysis";
    currentX += X_SPACING;
  }

  if (run.result?.artifact) {
    nodes.push({
      id: "artifact",
      type: "artifactNode",
      position: { x: currentX, y: 150 },
      data: { type: "artifact", artifact: run.result.artifact },
    });
    edges.push({
      id: `e-${lastNodeId}-artifact`,
      source: lastNodeId,
      target: "artifact",
      style: { stroke: C.blue, strokeWidth: 2, strokeDasharray: "5 5" },
      type: "smoothstep",
    });
    lastNodeId = "artifact";
    currentX += X_SPACING;
  }

  if (run.status === "COMPLETED") {
    nodes.push({
      id: "done",
      type: "doneNode",
      position: { x: currentX, y: 150 },
      data: { type: "done", run },
    });
    edges.push({
      id: `e-${lastNodeId}-done`,
      source: lastNodeId,
      target: "done",
      style: { stroke: C.green, strokeWidth: 2, strokeDasharray: "5 5" },
      type: "smoothstep",
    });
  }

  return { nodes, edges };
}

// ── Main Component ──────────────────────────────────────────────────────────

interface Props {
  run: Run;
}

export default function RunTrace({ run }: Props) {
  const { nodes, edges } = useMemo(() => buildGraph(run), [run]);
  const [selected, setSelected] = useState<any>(null);

  return (
    <section className="card" style={{ flex: 1, minHeight: 600, display: "flex", flexDirection: "row", overflow: "hidden" }}>
      <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", borderRight: selected ? `1px solid ${C.border}` : "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: `1px solid ${C.border}`, background: C.bg }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="card-title" style={{ padding: 0, border: "none", background: "none" }}>Workflow Trace</span>
            <StatusBadge status={run.status} />
          </div>
        </div>

        <div style={{ flex: 1, position: "relative", minHeight: 500, background: "#0a0a0c" }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelected(node.data)}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.2}
            maxZoom={1.5}
            nodesDraggable={true}
            nodesConnectable={false}
            elementsSelectable={true}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={2} color="rgba(255,255,255,0.05)" />
            <Controls style={{ display: "flex", flexDirection: "column", gap: 4, borderRadius: 8, overflow: "hidden", border: `1px solid ${C.border}`, background: C.bg }} />
          </ReactFlow>
        </div>
      </div>

      {/* Side Panel */}
      {selected && (
        <div style={{ width: 320, background: C.bg, display: "flex", flexDirection: "column", overflowY: "auto" }}>
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#fff", fontFamily: "var(--sans)" }}>Node Details</span>
            <button onClick={() => setSelected(null)} style={{ color: "var(--ink-3)", cursor: "pointer" }}>✕</button>
          </div>

          <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
            {selected.type === "start" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Task</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.6 }}>{selected.run.task}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Model Reason</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.6 }}>{selected.run.modelReason}</div>
                </div>
              </>
            )}

            {selected.type === "tool" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 8, textTransform: "uppercase", fontWeight: 600 }}>Tool Status</div>
                  <StatusBadge status={selected.tool.status} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 8, textTransform: "uppercase", fontWeight: 600 }}>JSON Payload (Input)</div>
                  <div style={{ background: "#0a0a0a", border: `1px solid #222`, borderRadius: 8, padding: 16 }}>
                    <HighlightedJSON data={selected.tool.input} />
                  </div>
                </div>
                {selected.tool.output && (
                  <div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 8, textTransform: "uppercase", fontWeight: 600 }}>JSON Response (Output)</div>
                    <div style={{ background: "#0a0a0a", border: `1px solid #222`, borderRadius: 8, padding: 16 }}>
                      <HighlightedJSON data={selected.tool.output} />
                    </div>
                  </div>
                )}
              </>
            )}

            {selected.type === "evidence" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Title</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 600 }}>{selected.evidence.title}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Summary</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.6 }}>{selected.evidence.summary}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Facts</div>
                  <ul style={{ paddingLeft: 20, margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>
                    {selected.evidence.facts.map((f: string, i: number) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              </>
            )}

            {selected.type === "analysis" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 8, textTransform: "uppercase", fontWeight: 600 }}>Final Analysis</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{selected.analysis}</div>
                </div>
              </>
            )}

            {selected.type === "artifact" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 8, textTransform: "uppercase", fontWeight: 600 }}>Document Viewer</div>
                  <ArtifactViewer artifact={selected.artifact} />
                  <button
                    className="btn-ghost"
                    style={{ width: "100%", justifyContent: "center", marginTop: 12 }}
                    onClick={() => api.downloadArtifact(selected.artifact.id, selected.artifact.filename)}
                  >
                    Download {selected.artifact.filename}
                  </button>
                </div>
              </>
            )}

            {selected.type === "done" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Model Used</div>
                  <div style={{ fontSize: 13, color: "var(--ink)" }}>{selected.run.modelProfile}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Capability</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", textTransform: "capitalize" }}>{selected.run.taskCapability}</div>
                </div>
                {selected.run.result?.analysis && (
                  <div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Final Analysis</div>
                    <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.6, whiteSpace: "pre-wrap", background: "rgba(255,255,255,0.02)", padding: 12, borderRadius: 8, border: `1px solid ${C.border}` }}>
                      {selected.run.result.analysis}
                    </div>
                  </div>
                )}
                {selected.run.result?.artifact && (
                  <div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Generated Artifact</div>
                    <div style={{ fontSize: 13, color: "var(--ink)", display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.02)", padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}` }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                      {selected.run.result.artifact.filename}
                    </div>
                  </div>
                )}
                {selected.run.evidence && selected.run.evidence.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Evidence Sources</div>
                    <div style={{ fontSize: 13, color: "var(--ink)", background: "rgba(255,255,255,0.02)", padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}` }}>
                      {selected.run.evidence.length} sources analyzed
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
