import { isTerminalRunState, type RunTrace, type ToolCallState } from "./types.js";

/**
 * Lays a run out as a vertical flow: the task, the routing decision, each tool
 * call in order, and the outcome.
 *
 * Positions are computed rather than laid out by a solver because a run is
 * strictly sequential — there is nothing to untangle, and a fixed layout keeps
 * nodes from jumping around as the graph grows during a live run.
 *
 * Deliberately free of any rendering library: the layout is plain data, so it
 * can be tested without a DOM and the view layer stays swappable.
 */

const COLUMN_X = 0;
const TASK_OFFSET_X = 30;
const END_OFFSET_X = 70;
/** Tool nodes alternate either side of the spine so long runs stay readable. */
const TOOL_STAGGER_X = 40;

const TASK_GAP_Y = 140;
const AGENT_GAP_Y = 160;
const TOOL_GAP_Y = 150;

export interface TraceNode {
  id: string;
  type: TraceNodeData["nodeType"];
  position: { x: number; y: number };
  data: TraceNodeData;
}

export interface TraceEdge {
  id: string;
  source: string;
  target: string;
  /** True while the step it leads into is still running. */
  active: boolean;
}

export type TraceNodeData =
  | { nodeType: "task"; label: string; selected: boolean }
  | { nodeType: "agent"; profile: string; capability: string; reason: string; selected: boolean }
  | { nodeType: "tool"; label: string; state: ToolCallState; summary: string; input?: unknown; output?: unknown; selected: boolean }
  | { nodeType: "end"; status: RunTrace["status"]; result: RunTrace["result"]; selected: boolean };

export function buildTraceGraph(
  trace: RunTrace,
  selectedId: string | null,
): { nodes: TraceNode[]; edges: TraceEdge[] } {
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];
  let y = 0;

  const connect = (source: string, target: string, active: boolean): void => {
    // Plain alphanumeric ids: rendering libraries put these in DOM and SVG
    // marker references, where punctuation is not reliably safe.
    edges.push({ id: `edge-${source}-${target}`, source, target, active });
  };

  nodes.push({
    id: "task",
    type: "task",
    position: { x: COLUMN_X + TASK_OFFSET_X, y },
    data: { nodeType: "task", label: trace.task, selected: selectedId === "task" },
  });
  y += TASK_GAP_Y;

  nodes.push({
    id: "agent",
    type: "agent",
    position: { x: COLUMN_X, y },
    data: {
      nodeType: "agent",
      profile: trace.modelProfile,
      capability: trace.capability,
      reason: trace.modelReason,
      selected: selectedId === "agent",
    },
  });
  connect("task", "agent", false);
  y += AGENT_GAP_Y;

  let previous = "agent";
  trace.toolCalls.forEach((call, index) => {
    const id = `tool-${index}`;
    nodes.push({
      id,
      type: "tool",
      position: { x: index % 2 === 0 ? COLUMN_X - TOOL_STAGGER_X : COLUMN_X + TOOL_STAGGER_X, y },
      data: {
        nodeType: "tool",
        label: call.toolName,
        state: call.state,
        summary: call.summary,
        input: call.input,
        output: call.output,
        selected: selectedId === id,
      },
    });
    connect(previous, id, call.state === "running");
    previous = id;
    y += TOOL_GAP_Y;
  });

  // The outcome node appears only once there is an outcome; while the run is
  // live the last edge simply trails off, which reads as "still going".
  if (isTerminalRunState(trace.status)) {
    nodes.push({
      id: "end",
      type: "end",
      position: { x: COLUMN_X + END_OFFSET_X, y },
      data: { nodeType: "end", status: trace.status, result: trace.result, selected: selectedId === "end" },
    });
    connect(previous, "end", false);
  }

  return { nodes, edges };
}
