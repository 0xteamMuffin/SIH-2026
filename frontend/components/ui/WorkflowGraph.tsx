"use client";

import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type NodeTypes,
  type Connection,
  BackgroundVariant,
  Handle,
  Position,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ToolCall } from "../../lib/api";

// ── Constants ────────────────────────────────────────────────────────────────

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;
const H_GAP = 60; // horizontal gap between nodes
const V_OFFSET = 0; // single row for now

// ── Custom Node ──────────────────────────────────────────────────────────────

interface ToolNodeData {
  toolName: string;
  status: ToolCall["status"];
  startedAt: string;
  completedAt?: string;
  isLast: boolean;
  isRunning: boolean;
  [key: string]: unknown;
}

function durationLabel(startedAt: string, completedAt?: string): string {
  if (!completedAt) return "";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ToolNode({ data }: { data: ToolNodeData }) {
  const { toolName, status, startedAt, completedAt, isLast, isRunning } = data;
  const isNodeRunning =
    status === "RUNNING" || (isLast && isRunning && status !== "COMPLETED" && status !== "FAILED");
  const isFailed = status === "FAILED";
  const isDone = status === "COMPLETED";
  const dur = durationLabel(startedAt, completedAt);

  const borderColor = isFailed
    ? "var(--red, #ef4444)"
    : isNodeRunning
    ? "var(--ink-2, #a3a3a3)"
    : "var(--line-strong, #404040)";

  const glowColor = isFailed
    ? "rgba(239,68,68,0.25)"
    : isNodeRunning
    ? "rgba(163,163,163,0.2)"
    : "transparent";

  return (
    <div
      style={{
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        background: "var(--surface-1, #1a1a1a)",
        border: `1.5px solid ${borderColor}`,
        borderRadius: 10,
        padding: "10px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxShadow: `0 0 0 ${isNodeRunning || isFailed ? "6px" : "0px"} ${glowColor}, 0 4px 16px rgba(0,0,0,0.4)`,
        transition: "box-shadow 0.3s ease, border-color 0.3s ease",
        position: "relative",
        animation: isNodeRunning ? "pulse-border 1.5s ease-in-out infinite" : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "var(--line-strong, #404040)", width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} style={{ background: "var(--line-strong, #404040)", width: 8, height: 8 }} />

      {/* Top row: icon + tool name */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusIcon status={status} isNodeRunning={isNodeRunning} />
        <span
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ink, #e5e5e5)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
          }}
          title={toolName}
        >
          {toolName}
        </span>
      </div>

      {/* Bottom row: status + duration */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 500,
            color: isFailed
              ? "var(--red, #ef4444)"
              : isNodeRunning
              ? "var(--ink-2, #a3a3a3)"
              : isDone
              ? "var(--green, #4ade80)"
              : "var(--ink-3, #737373)",
            textTransform: "capitalize",
            letterSpacing: "0.04em",
          }}
        >
          {isNodeRunning ? "running…" : status.toLowerCase()}
        </span>
        {dur && (
          <span
            style={{
              fontSize: 10,
              color: "var(--ink-3, #737373)",
              fontFamily: "var(--font-mono, monospace)",
            }}
          >
            {dur}
          </span>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status, isNodeRunning }: { status: ToolCall["status"]; isNodeRunning: boolean }) {
  if (isNodeRunning) {
    return (
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: "50%",
          border: "1.5px solid var(--line-strong, #404040)",
          borderTopColor: "var(--ink-2, #a3a3a3)",
          flexShrink: 0,
          display: "inline-block",
          animation: "spin 700ms linear infinite",
        }}
      />
    );
  }
  if (status === "FAILED") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--red, #ef4444)" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--green, #4ade80)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

// ── Node type registry ────────────────────────────────────────────────────────

const nodeTypes: NodeTypes = {
  tool: ToolNode as unknown as NodeTypes["tool"],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildNodes(toolCalls: ToolCall[], isRunning: boolean): Node[] {
  return toolCalls.map((tc, i) => ({
    id: `tc-${i}`,
    type: "tool",
    position: {
      x: i * (NODE_WIDTH + H_GAP),
      y: V_OFFSET,
    },
    data: {
      toolName: tc.toolName,
      status: tc.status,
      startedAt: tc.startedAt,
      completedAt: tc.completedAt,
      isLast: i === toolCalls.length - 1,
      isRunning,
    } satisfies ToolNodeData,
    draggable: true,
  }));
}

function buildEdges(toolCalls: ToolCall[], isRunning: boolean): Edge[] {
  return toolCalls.slice(0, -1).map((tc, i) => {
    const animated = isRunning && (tc.status === "RUNNING" || toolCalls[i + 1].status === "RUNNING");
    return {
      id: `edge-${i}-${i + 1}`,
      source: `tc-${i}`,
      target: `tc-${i + 1}`,
      animated,
      style: {
        stroke: animated ? "var(--ink-2, #a3a3a3)" : "var(--line-strong, #404040)",
        strokeWidth: 1.5,
        strokeDasharray: animated ? "6 3" : undefined,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: animated ? "var(--ink-2, #a3a3a3)" : "var(--line-strong, #404040)",
        width: 14,
        height: 14,
      },
    };
  });
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  toolCalls: ToolCall[];
  isRunning: boolean;
}

export default function WorkflowGraph({ toolCalls, isRunning }: Props) {
  const initialNodes = useMemo(() => buildNodes(toolCalls, isRunning), [toolCalls, isRunning]);
  const initialEdges = useMemo(() => buildEdges(toolCalls, isRunning), [toolCalls, isRunning]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Keep nodes/edges in sync when toolCalls update (polling)
  useMemo(() => {
    setNodes(buildNodes(toolCalls, isRunning));
    setEdges(buildEdges(toolCalls, isRunning));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCalls, isRunning]);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges]
  );

  if (toolCalls.length === 0) {
    return (
      <div
        style={{
          height: 120,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--ink-3, #737373)",
          fontSize: 13,
          border: "1px dashed var(--line, #2a2a2a)",
          borderRadius: 10,
        }}
      >
        {isRunning ? "Waiting for first tool call…" : "No tool calls recorded."}
      </div>
    );
  }

  // Canvas height: enough to show nodes + some padding
  const canvasHeight = Math.max(220, NODE_HEIGHT + 120);

  return (
    <div
      style={{
        width: "100%",
        height: canvasHeight,
        borderRadius: 10,
        overflow: "hidden",
        border: "1px solid var(--line, #2a2a2a)",
        background: "var(--surface-0, #111111)",
      }}
    >
      <style>{`
        @keyframes pulse-border {
          0%, 100% { box-shadow: 0 0 0 4px rgba(163,163,163,0.15), 0 4px 16px rgba(0,0,0,0.4); }
          50% { box-shadow: 0 0 0 8px rgba(163,163,163,0.08), 0 4px 16px rgba(0,0,0,0.4); }
        }
        .react-flow__attribution { display: none; }
        .react-flow__controls {
          background: var(--surface-1, #1a1a1a) !important;
          border: 1px solid var(--line, #2a2a2a) !important;
          border-radius: 8px !important;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important;
        }
        .react-flow__controls-button {
          background: transparent !important;
          border: none !important;
          border-bottom: 1px solid var(--line, #2a2a2a) !important;
          color: var(--ink-2, #a3a3a3) !important;
          fill: var(--ink-2, #a3a3a3) !important;
        }
        .react-flow__controls-button:last-child { border-bottom: none !important; }
        .react-flow__controls-button:hover { background: var(--hover-2, #2a2a2a) !important; }
        .react-flow__minimap {
          background: var(--surface-1, #1a1a1a) !important;
          border: 1px solid var(--line, #2a2a2a) !important;
          border-radius: 8px !important;
        }
      `}</style>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--line, #2a2a2a)"
        />
        <Controls showInteractive={false} />
        {toolCalls.length > 5 && <MiniMap nodeColor="#404040" maskColor="rgba(0,0,0,0.6)" />}
      </ReactFlow>
    </div>
  );
}
