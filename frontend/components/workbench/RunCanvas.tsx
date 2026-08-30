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
import type { Run } from "../../lib/api";

// ── Custom Node Components ────────────────────────────────────────────────

function StartNode({ data }: { data: any }) {
  return (
    <div className="card" style={{ width: 320, padding: "16px", borderRadius: "12px", border: "1px solid var(--line)", background: "var(--surface)" }}>
      <div className="section-title">Initial Task</div>
      <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.5, wordBreak: "break-word" }}>
        {data.label}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "var(--line-strong)", border: "none" }} />
    </div>
  );
}

function AgentNode({ data }: { data: any }) {
  return (
    <div className="card animated-border" style={{ width: 240, padding: "14px", borderRadius: "12px" }}>
      <Handle type="target" position={Position.Left} style={{ background: "var(--line-strong)", border: "none" }} />
      <div className="section-title" style={{ color: "var(--accent)" }}>Agent Routed</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="chip" style={{ width: "fit-content", borderColor: "rgba(139, 92, 246, 0.3)", color: "#a78bfa", background: "rgba(139, 92, 246, 0.1)" }}>
          {data.profile}
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>Capability: {data.capability}</span>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "var(--line-strong)", border: "none" }} />
    </div>
  );
}

function ToolNode({ data }: { data: any }) {
  const isFailed = data.status === "FAILED";
  const isRunning = data.status === "RUNNING";
  const borderColor = isFailed ? "var(--red)" : isRunning ? "var(--accent)" : "var(--green)";
  const bg = isFailed ? "rgba(248, 113, 113, 0.1)" : isRunning ? "rgba(139, 92, 246, 0.1)" : "rgba(74, 222, 128, 0.05)";

  return (
    <div style={{
      background: "var(--inset)",
      border: `1px solid ${borderColor}`,
      borderRadius: "8px",
      padding: "10px 14px",
      width: 280,
      display: "flex",
      flexDirection: "column",
      gap: 8,
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
    }}>
      <Handle type="target" position={Position.Left} style={{ background: "var(--line-strong)", border: "none" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <span style={{ fontFamily: "monospace", fontSize: 12.5, color: "var(--ink)", wordBreak: "break-all", whiteSpace: "pre-wrap", flex: 1 }}>{data.label}</span>
        <span className={`status status-${data.status.toLowerCase()}`} style={{ fontSize: 10, background: bg, flexShrink: 0 }}>
          {data.status}
        </span>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "var(--line-strong)", border: "none" }} />
    </div>
  );
}

function EndNode({ data }: { data: any }) {
  return (
    <div className="card" style={{ width: 200, padding: "16px", borderRadius: "12px", border: "1px solid var(--line)" }}>
      <Handle type="target" position={Position.Left} style={{ background: "var(--line-strong)", border: "none" }} />
      <div className="section-title">Workflow End</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: data.status === "COMPLETED" ? "var(--green)" : data.status === "FAILED" ? "var(--red)" : "var(--ink-2)" }}>
        Status: {data.status}
      </div>
    </div>
  );
}

const nodeTypes = {
  start: StartNode,
  agent: AgentNode,
  tool: ToolNode,
  end: EndNode,
};

// ── Component ─────────────────────────────────────────────────────────────

interface Props {
  run: Run;
}

export default function RunCanvas({ run }: Props) {
  const [selectedNodeData, setSelectedNodeData] = useState<any>(null);

  const { nodes, edges } = useMemo(() => {
    const nds: Node[] = [];
    const eds: Edge[] = [];
    let xOffset = 50;
    const yCenter = 200;

    // 1. Start Node
    nds.push({
      id: "start",
      type: "start",
      position: { x: xOffset, y: yCenter - 50 },
      data: { nodeType: "start", label: run.task, fullRun: run },
    });
    xOffset += 400;

    // 2. Agent Node
    nds.push({
      id: "agent",
      type: "agent",
      position: { x: xOffset, y: yCenter - 40 },
      data: { nodeType: "agent", profile: run.modelProfile, capability: run.taskCapability, reason: run.modelReason },
    });
    eds.push({
      id: "e-start-agent",
      source: "start",
      target: "agent",
      animated: true,
      style: { stroke: "var(--line-strong)", strokeWidth: 2 },
    });
    xOffset += 320;

    // 3. Tool Nodes
    let prevNodeId = "agent";
    if (run.toolCalls && run.toolCalls.length > 0) {
      run.toolCalls.forEach((tc, i) => {
        const toolId = `tool-${i}`;
        nds.push({
          id: toolId,
          type: "tool",
          position: { x: xOffset, y: yCenter - 30 + (i * 60) },
          data: { nodeType: "tool", label: tc.toolName, status: tc.status, toolCall: tc },
        });
        
        eds.push({
          id: `e-${prevNodeId}-${toolId}`,
          source: prevNodeId,
          target: toolId,
          animated: tc.status === "RUNNING",
          style: { stroke: "var(--line-strong)", strokeWidth: 2 },
        });
        
        prevNodeId = toolId;
        xOffset += 340;
      });
    }

    // 4. End Node
    nds.push({
      id: "end",
      type: "end",
      position: { x: xOffset, y: yCenter - 40 },
      data: { nodeType: "end", status: run.status, result: run.result },
    });
    eds.push({
      id: `e-${prevNodeId}-end`,
      source: prevNodeId,
      target: "end",
      animated: run.status === "RUNNING",
      style: { stroke: "var(--line-strong)", strokeWidth: 2 },
    });

    return { nodes: nds, edges: eds };
  }, [run]);

  const onNodeClick = useCallback((event: any, node: Node) => {
    setSelectedNodeData(node.data);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeData(null);
  }, []);

  return (
    <div style={{ display: "flex", width: "100%", height: "100%" }}>
      {/* Canvas Area */}
      <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--line-strong)" gap={20} size={2} />
          <Controls style={{ background: "var(--surface)", border: "1px solid var(--line)", fill: "var(--ink-2)" }} />
        </ReactFlow>
      </div>

      {/* Context Sidebar */}
      {selectedNodeData && (
        <div style={{
          width: 360,
          background: "var(--surface)",
          borderLeft: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          animation: "fade-up 300ms ease"
        }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>Node Details</h3>
            <button onClick={onPaneClick} className="btn-ghost" style={{ padding: 4 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
          
          <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 24 }}>
            {selectedNodeData.nodeType === "start" && (
              <div>
                <div className="section-title">Initial Task</div>
                <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>{selectedNodeData.label}</p>
              </div>
            )}

            {selectedNodeData.nodeType === "agent" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <div className="section-title">Selected Model</div>
                  <span className="chip" style={{ fontSize: 13 }}>{selectedNodeData.profile}</span>
                </div>
                <div>
                  <div className="section-title">Routing Reason</div>
                  <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink)" }}>{selectedNodeData.reason}</p>
                </div>
                <div>
                  <div className="section-title">Capability Required</div>
                  <span className="chip">{selectedNodeData.capability}</span>
                </div>
              </div>
            )}

            {selectedNodeData.nodeType === "tool" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <div className="section-title">Tool Execution</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 13 }}>{selectedNodeData.label}</span>
                    <span className={`status status-${selectedNodeData.status.toLowerCase()}`}>{selectedNodeData.status}</span>
                  </div>
                </div>
                {selectedNodeData.toolCall.startedAt && (
                  <div>
                    <div className="section-title">Started At</div>
                    <div style={{ fontSize: 12, color: "var(--ink-2)" }}>{new Date(selectedNodeData.toolCall.startedAt).toLocaleString()}</div>
                  </div>
                )}
                {selectedNodeData.toolCall.input && (
                  <div>
                    <div className="section-title">Payload (Input)</div>
                    <pre style={{ fontSize: 11, background: "var(--inset)", padding: 12, borderRadius: 8, overflowX: "auto", border: "1px solid var(--line)" }}>
                      {JSON.stringify(selectedNodeData.toolCall.input, null, 2)}
                    </pre>
                  </div>
                )}
                {selectedNodeData.toolCall.output && (
                  <div>
                    <div className="section-title">Response (Output)</div>
                    <pre style={{ fontSize: 11, background: "var(--inset)", padding: 12, borderRadius: 8, overflowX: "auto", border: "1px solid var(--line)" }}>
                      {JSON.stringify(selectedNodeData.toolCall.output, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {selectedNodeData.nodeType === "end" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <div className="section-title">Final Status</div>
                  <span className={`status status-${selectedNodeData.status.toLowerCase()}`}>{selectedNodeData.status}</span>
                </div>
                {selectedNodeData.result && (
                  <div>
                    <div className="section-title">Result Metadata</div>
                    <pre style={{ fontSize: 11, background: "var(--inset)", padding: 12, borderRadius: 8, overflowX: "auto", border: "1px solid var(--line)" }}>
                      {JSON.stringify(selectedNodeData.result, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
