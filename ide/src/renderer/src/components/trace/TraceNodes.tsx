import { Handle, Position, type NodeProps } from "@xyflow/react";

import type { RunState, ToolCallState } from "@shared/types.js";

import type { TraceNodeData } from "@shared/trace-graph.js";

import { Icon, type IconName } from "../ui/Icon.js";

/**
 * Node renderers for the run graph.
 *
 * Styling lives in CSS rather than inline objects so the nodes pick up the
 * app's tokens — which is what lets the graph follow the light/dark theme
 * without React Flow knowing a theme exists.
 */

const TOOL_STATE_CLASS: Record<ToolCallState, string> = {
  running: "is-running",
  completed: "is-completed",
  failed: "is-failed",
  rejected: "is-rejected",
  "awaiting-approval": "is-waiting",
};

const TOOL_STATE_ICON: Record<ToolCallState, IconName> = {
  running: "circle-dot",
  completed: "check",
  failed: "close",
  rejected: "ban",
  "awaiting-approval": "pause",
};

const OUTCOME_ICON: Record<RunState, IconName> = {
  queued: "clock",
  running: "circle-dot",
  "awaiting-approval": "pause",
  completed: "check-circle",
  failed: "x-circle",
  cancelled: "ban",
};

function Ports({
  target = true,
  source = true,
}: {
  target?: boolean;
  source?: boolean;
}): React.JSX.Element {
  return (
    <>
      {target && (
        <Handle type="target" position={Position.Top} id="top" className="trace-node__port" />
      )}
      {source && (
        <Handle type="source" position={Position.Bottom} id="bottom" className="trace-node__port" />
      )}
    </>
  );
}

function selectedClass(selected: boolean): string {
  return selected ? " trace-node--selected" : "";
}

export function TaskNode({ data }: NodeProps): React.JSX.Element {
  const node = data as Extract<TraceNodeData, { nodeType: "task" }>;
  return (
    <div className={`trace-node trace-node--task${selectedClass(node.selected)}`}>
      <Ports target={false} />
      <span className="trace-node__badge">
        <Icon name="message" size={11} />
        Task
      </span>
      <p className="trace-node__task">{node.label}</p>
    </div>
  );
}

export function AgentNode({ data }: NodeProps): React.JSX.Element {
  const node = data as Extract<TraceNodeData, { nodeType: "agent" }>;
  return (
    <div className={`trace-node trace-node--agent${selectedClass(node.selected)}`}>
      <Ports />
      <div className="trace-node__row">
        <span className="trace-node__badge trace-node__badge--accent">
          <Icon name="cpu" size={11} />
          Model routing
        </span>
        {node.capability && <span className="trace-node__chip">{node.capability}</span>}
      </div>
      {/* The profile is unknown until the backend has routed the run. */}
      <p className="trace-node__profile">{node.profile || "Selecting…"}</p>
      <p className="trace-node__reason">{node.reason}</p>
    </div>
  );
}

export function ToolNode({ data }: NodeProps): React.JSX.Element {
  const node = data as Extract<TraceNodeData, { nodeType: "tool" }>;
  return (
    <div
      className={`trace-node trace-node--tool ${TOOL_STATE_CLASS[node.state]}${selectedClass(node.selected)}`}
    >
      <Ports />
      <div className="trace-node__row">
        <span className="trace-node__tool-name">{node.label}</span>
        <span className="trace-node__state">
          <Icon name={TOOL_STATE_ICON[node.state]} size={11} strokeWidth={2.2} />
          {node.state}
        </span>
      </div>
      <p className="trace-node__summary">{node.summary}</p>
    </div>
  );
}

export function EndNode({ data }: NodeProps): React.JSX.Element {
  const node = data as Extract<TraceNodeData, { nodeType: "end" }>;
  return (
    <div className={`trace-node trace-node--end is-${node.status}${selectedClass(node.selected)}`}>
      <Ports source={false} />
      <span className="trace-node__badge">Outcome</span>
      <span className="trace-node__outcome">
        <Icon name={OUTCOME_ICON[node.status]} size={15} />
        {node.status}
      </span>
    </div>
  );
}

export const traceNodeTypes = { task: TaskNode, agent: AgentNode, tool: ToolNode, end: EndNode };
