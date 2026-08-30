"use client";

import { useMemo, useState } from "react";
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

function NodeHeader({ title, dotColor, isSelected }: { title: string; dotColor: string; isSelected?: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 14px", borderBottom: `1px solid transparent`, // screenshot has no explicit line under header
      background: "transparent"
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 14, height: 14, borderRadius: 4, backgroundColor: dotColor }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: "#fff", fontFamily: "var(--sans)" }}>{title}</span>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" style={{ cursor: "pointer" }}>
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
      position: "relative", padding: "6px 14px", display: "flex", alignItems: "center",
      justifyContent: rightAlign ? "flex-end" : "flex-start", gap: 8
    }}>
      {type === "target" && (
        <Handle type="target" id={id} position={Position.Left} style={{ background: color, border: "none", width: 8, height: 8, left: -4 }} />
      )}
      
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {!rightAlign && isList && <span style={{ color, fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700 }}>[ ]</span>}
        {!rightAlign && !isList && <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />}
        
        <span style={{ fontSize: 12, color: "var(--ink-2)", fontFamily: "var(--sans)" }}>{label}</span>
        
        {rightAlign && isList && <span style={{ color, fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700 }}>[ ]</span>}
        {rightAlign && !isList && <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />}
      </div>

      {type === "source" && (
        <Handle type="source" id={id} position={Position.Right} style={{ background: color, border: "none", width: 8, height: 8, right: -4 }} />
      )}
    </div>
  );
}

function NodeBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "8px 14px 10px 14px" }}>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 8 }}>{label}</div>
      <div style={{
        background: "#0a0a0a", border: `1px solid #222`, borderRadius: 6,
        padding: "10px 12px", fontSize: 12, color: "var(--ink-2)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
      }}>
        {value}
      </div>
    </div>
  );
}

function NodeContainer({ children, selected }: { children: React.ReactNode, selected: boolean }) {
  return (
    <div style={{ 
      background: "#18181b", // very dark grey from screenshot
      border: `1px solid ${selected ? "#555" : "#27272a"}`, 
      borderRadius: 12, 
      width: 280, 
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)" 
    }}>
      {children}
    </div>
  );
}

const nodeTypes = {
  startNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <NodeContainer selected={selected}>
      <NodeHeader title="Task Initialization" dotColor={C.green} isSelected={selected} />
      <div style={{ paddingBottom: "12px" }}>
        <NodeRow label="Task Output" type="source" color={C.green} isList rightAlign />
        <NodeBox label="Model Profile" value={data.run.modelProfile} />
        <NodeBox label="Task Capability" value={data.run.taskCapability} />
      </div>
      <div style={{ padding: "10px 14px", borderTop: `1px solid #27272a`, fontSize: 11, color: "var(--ink-3)", display: "flex", justifyContent: "space-between", cursor: "pointer" }}>
        <span>Advanced settings</span>
        <span>›</span>
      </div>
    </NodeContainer>
  ),

  toolNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <NodeContainer selected={selected}>
      <NodeHeader title={data.tool.toolName} dotColor={C.blue} isSelected={selected} />
      <div style={{ paddingBottom: "12px" }}>
        <NodeRow id="in" label="Tool Input" type="target" color={C.blue} />
        <NodeRow id="out" label="Tool Output" type="source" color={C.blue} rightAlign />
        <NodeBox label="Status" value={data.tool.status} />
      </div>
    </NodeContainer>
  ),

  evidenceNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <NodeContainer selected={selected}>
      <NodeHeader title="Evidence Gathered" dotColor={C.pink} isSelected={selected} />
      <div style={{ paddingBottom: "12px" }}>
        <NodeRow id="in" label="Source" type="target" color={C.pink} />
        <NodeRow id="out" label="Evidence" type="source" color={C.pink} isList rightAlign />
        <NodeBox label="Title" value={data.evidence.title} />
      </div>
    </NodeContainer>
  ),

  analysisNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <NodeContainer selected={selected}>
      <NodeHeader title="Final Analysis" dotColor={C.purple} isSelected={selected} />
      <div style={{ paddingBottom: "12px" }}>
        <NodeRow id="in" label="Analysis Input" type="target" color={C.purple} />
        <NodeRow id="out" label="Analysis Output" type="source" color={C.purple} isList rightAlign />
      </div>
    </NodeContainer>
  ),

  artifactNode: ({ data, selected }: { data: any, selected: boolean }) => (
    <NodeContainer selected={selected}>
      <NodeHeader title="Output Layout" dotColor={C.gray} isSelected={selected} />
      <div style={{ paddingBottom: "12px" }}>
        <NodeRow id="in" label="File Artifact" type="target" color={C.blue} isList />
        <NodeBox label="Filename" value={data.artifact.filename} />
      </div>
      <div style={{ padding: "10px 14px", borderTop: `1px solid #27272a`, fontSize: 11, color: "var(--ink-3)", display: "flex", justifyContent: "space-between", cursor: "pointer" }}>
        <span>Advanced settings</span>
        <span>›</span>
      </div>
    </NodeContainer>
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
        type: "default",
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
        type: "default",
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
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase" }}>Task</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.6 }}>{selected.run.task}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase" }}>Model Reason</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.6 }}>{selected.run.modelReason}</div>
                </div>
              </>
            )}

            {selected.type === "tool" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase" }}>Tool Name</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", fontFamily: "var(--mono)" }}>{selected.tool.toolName}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase" }}>Input Payload</div>
                  <pre style={{ background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, fontSize: 12, color: "var(--ink-2)", overflowX: "auto" }}>
                    {JSON.stringify(selected.tool.input, null, 2)}
                  </pre>
                </div>
                {selected.tool.output && (
                  <div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase" }}>Output</div>
                    <pre style={{ background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, fontSize: 12, color: "var(--ink-2)", overflowX: "auto" }}>
                      {JSON.stringify(selected.tool.output, null, 2)}
                    </pre>
                  </div>
                )}
              </>
            )}

            {selected.type === "evidence" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase" }}>Title</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 600 }}>{selected.evidence.title}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase" }}>Summary</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.6 }}>{selected.evidence.summary}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase" }}>Facts</div>
                  <ul style={{ paddingLeft: 20, margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>
                    {selected.evidence.facts.map((f: string, i: number) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              </>
            )}

            {selected.type === "analysis" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase" }}>Final Analysis</div>
                  <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{selected.analysis}</div>
                </div>
              </>
            )}

            {selected.type === "artifact" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6, textTransform: "uppercase" }}>Artifact Download</div>
                  <button
                    className="btn-ghost"
                    style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
                    onClick={() => api.downloadArtifact(selected.artifact.id, selected.artifact.filename)}
                  >
                    Download {selected.artifact.filename}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
