import { Handle, Position, MarkerType, type Edge, type Node } from "@xyflow/react";
import type { Run } from "../../lib/api";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const NODE_W = 320;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function truncateObj(obj: any, length: number = 80) {
  if (!obj) return "";
  const str = JSON.stringify(obj);
  return str.length > length ? str.slice(0, length) + "…" : str;
}

// ─── Canvas node types ────────────────────────────────────────────────────────
export function TaskNode({ data }: { data: any }) {
  return (
    <div style={NODES.task(data.selected, data.delay)} className="node-wrapper">
      <Handle type="source" position={Position.Bottom} id="bottom" style={HANDLE} />
      <span className="node-badge">Task</span>
      <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.5, wordBreak: "break-word" }}>{data.label}</div>
    </div>
  );
}

export function AgentNode({ data }: { data: any }) {
  return (
    <div style={NODES.agent(data.selected, data.delay)} className="node-wrapper">
      <Handle type="target" position={Position.Top} id="top" style={HANDLE} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={HANDLE} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="node-badge" style={{ color: "var(--accent)" }}>Agent Router</span>
          <span style={{ fontSize: 13, fontFamily: "monospace", color: "var(--ink)" }}>{data.profile}</span>
        </div>
        <span className="chip" style={{ fontSize: 9 }}>{data.capability}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-2)", lineHeight: 1.4, marginTop: 8, padding: "8px", background: "rgba(255,255,255,0.03)", borderRadius: 6 }}>
        {data.reason}
      </div>
    </div>
  );
}

export function ToolNode({ data }: { data: any }) {
  const col = data.status === "FAILED" ? "var(--red)" : data.status === "RUNNING" ? "var(--accent)" : "var(--green)";
  return (
    <div style={NODES.tool(col, data.selected, data.delay)} className={`node-wrapper ${data.status === "RUNNING" ? "node-running" : ""}`}>
      <Handle type="target" position={Position.Top} id="top" style={HANDLE} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={HANDLE} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <span style={{ fontFamily: "monospace", fontSize: 12.5, color: "var(--ink)", wordBreak: "break-all" }}>{data.label}</span>
        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: `${col}22`, color: col, flexShrink: 0, textTransform: "uppercase", letterSpacing: "0.06em" }}>{data.status}</span>
      </div>
      {data.toolCall?.input && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--ink-3)", fontFamily: "monospace", background: "rgba(0,0,0,0.2)", padding: 6, borderRadius: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <strong style={{ color: "var(--ink-2)" }}>In:</strong> {truncateObj(data.toolCall.input, 60)}
        </div>
      )}
      {data.toolCall?.output && (
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--ink-3)", fontFamily: "monospace", background: "rgba(0,0,0,0.2)", padding: 6, borderRadius: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <strong style={{ color: "var(--ink-2)" }}>Out:</strong> {truncateObj(data.toolCall.output, 60)}
        </div>
      )}
    </div>
  );
}

export function EndNode({ data }: { data: any }) {
  const col = data.status === "COMPLETED" ? "var(--green)" : data.status === "FAILED" ? "var(--red)" : "var(--ink-3)";
  const running = !TERMINAL.has(data.status) && data.status !== "PENDING";
  return (
    <div style={NODES.end(col, data.selected, data.delay)} className={`node-wrapper ${running ? "node-running" : ""}`}>
      <Handle type="target" position={Position.Top} id="top" style={HANDLE} />
      <span className="node-badge" style={{ color: col }}>Done</span>
      <span style={{ fontSize: 14, fontWeight: 600, color: col }}>{data.status}</span>
    </div>
  );
}

export const nodeTypes = { task: TaskNode, agent: AgentNode, tool: ToolNode, end: EndNode };

// ─── Node style helpers ───────────────────────────────────────────────────────
const HANDLE: React.CSSProperties = { background: "var(--line-strong)", border: "none", width: 8, height: 8 };
const BASE: React.CSSProperties = {
  background: "rgba(16,16,18,0.95)",
  backdropFilter: "blur(12px)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  padding: "16px 18px",
  width: NODE_W,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
  cursor: "pointer",
  transition: "border-color 200ms ease, box-shadow 200ms ease, transform 200ms ease",
};
const SELECTED_STYLE: React.CSSProperties = {
  borderColor: "rgba(249,115,22,0.8)",
  boxShadow: "0 0 0 2px rgba(249,115,22,0.25), 0 8px 32px rgba(0,0,0,0.8)",
  transform: "scale(1.02)"
};
const NODES = {
  task: (sel: boolean, delay: string) => ({ ...BASE, ...(sel ? SELECTED_STYLE : {}), width: 260, animationDelay: delay }),
  agent: (sel: boolean, delay: string) => ({ ...BASE, ...(sel ? SELECTED_STYLE : {}), borderColor: sel ? "rgba(249,115,22,0.8)" : "rgba(249,115,22,0.25)", animationDelay: delay }),
  tool: (col: string, sel: boolean, delay: string) => ({ ...BASE, ...(sel ? SELECTED_STYLE : {}), borderLeft: `3px solid ${col}`, animationDelay: delay }),
  end: (col: string, sel: boolean, delay: string) => ({ ...BASE, ...(sel ? SELECTED_STYLE : {}), borderColor: sel ? "rgba(249,115,22,0.8)" : `${col}44`, width: 180, animationDelay: delay }),
};

// ─── Graph Builder ────────────────────────────────────────────────────────────
export function buildGraph(run: Run, selectedId: string | null) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let y = 0;
  const x = 0;
  let delayIdx = 0;
  const getDelay = () => `${delayIdx++ * 0.8}s`;
  
  const edge = (id: string, src: string, tgt: string, anim = false, stroke = "rgba(255,255,255,0.15)", delay: string) =>
    edges.push({ id, source: src, target: tgt, animated: anim, sourceHandle: "bottom", targetHandle: "top", style: { stroke, strokeWidth: 2, animation: "edgeAppear 0.5s both", animationDelay: delay }, markerEnd: { type: MarkerType.ArrowClosed, color: stroke } });

  // 1. Task Node
  const taskDelay = getDelay();
  nodes.push({ id: "task", type: "task", position: { x: x + 30, y }, data: { nodeType: "task", label: run.task, selected: selectedId === "task", delay: taskDelay } });
  y += 140;

  // 2. Agent Node
  const agentDelay = getDelay();
  nodes.push({ id: "agent", type: "agent", position: { x, y }, data: { nodeType: "agent", profile: run.modelProfile, capability: run.taskCapability, reason: run.modelReason, selected: selectedId === "agent", delay: agentDelay } });
  edge("e-task-agent", "task", "agent", false, "rgba(255,255,255,0.15)", agentDelay);
  y += 160;

  // 3. Tool Nodes (staggered horizontally or vertically)
  let prev = "agent";
  (run.toolCalls ?? []).forEach((tc, i) => {
    const id = `tool-${i}`;
    const tcDelay = getDelay();
    nodes.push({ id, type: "tool", position: { x: (i % 2 === 0 ? x - 40 : x + 40), y }, data: { nodeType: "tool", label: tc.toolName, status: tc.status, toolCall: tc, selected: selectedId === id, delay: tcDelay } });
    edge(`e-${prev}-${id}`, prev, id, tc.status === "RUNNING", tc.status === "RUNNING" ? "rgba(249,115,22,0.6)" : "rgba(255,255,255,0.15)", tcDelay);
    prev = id;
    y += 150;
  });

  // 4. End Node
  const isEndActive = run.status === "RUNNING" || run.status === "PENDING";
  if (!isEndActive) {
    const endDelay = getDelay();
    nodes.push({ id: "end", type: "end", position: { x: x + 70, y }, data: { nodeType: "end", status: run.status, result: run.result, selected: selectedId === "end", delay: endDelay } });
    edge(`e-${prev}-end`, prev, "end", isEndActive, isEndActive ? "rgba(249,115,22,0.6)" : "rgba(255,255,255,0.15)", endDelay);
  }

  return { nodes, edges };
}

// ─── Run Trace Step Component ─────────────────────────────────────────────────
export function TraceStep({ icon, title, desc, status }: { icon: React.ReactNode, title: string, desc: string, status?: string }) {
  const col = status === "FAILED" ? "var(--red)" : status === "RUNNING" ? "var(--accent)" : "var(--ink)";
  return (
    <div style={{ display: "flex", gap: 16, position: "relative", zIndex: 1 }}>
      <div style={{ width: 34, height: 34, borderRadius: "50%", background: "var(--surface)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", color: col, flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: col, fontFamily: status ? "monospace" : "inherit" }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.4 }}>{desc}</span>
      </div>
    </div>
  );
}
