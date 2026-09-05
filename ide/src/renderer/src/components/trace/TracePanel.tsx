import { useEffect, useMemo, useState } from "react";
import { Background, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { RunTrace } from "@shared/types.js";
import { buildTraceGraph, type TraceNodeData } from "@shared/trace-graph.js";

import { traceNodeTypes } from "./TraceNodes.js";

const EDGE_IDLE = "rgba(255,255,255,0.15)";
const EDGE_ACTIVE = "rgba(249,115,22,0.6)";

export interface TracePanelProps {
  trace: RunTrace;
  onClose: () => void;
}

/**
 * Execution graph for one agent turn.
 *
 * The thread answers "what did it produce"; this answers "how". Clicking a
 * node opens its full detail — the routing rationale, or a tool call's exact
 * arguments and raw result — which is what makes a run auditable rather than
 * merely observable.
 */
export function TracePanel({ trace, onClose }: TracePanelProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A live run grows nodes as tool calls land; a stale selection from the
  // previous turn would otherwise highlight the wrong step.
  useEffect(() => setSelectedId(null), [trace.runId]);

  // Layout is computed as plain data, then mapped onto React Flow's shapes
  // here — the only place that knows the rendering library exists.
  const { nodes, edges } = useMemo(() => {
    const layout = buildTraceGraph(trace, selectedId);
    return {
      nodes: layout.nodes as unknown as Node[],
      edges: layout.edges.map((edge): Edge => {
        const stroke = edge.active ? EDGE_ACTIVE : EDGE_IDLE;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: "bottom",
          targetHandle: "top",
          animated: edge.active,
          style: { stroke, strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        };
      }),
    };
  }, [trace, selectedId]);
  const selected = nodes.find((node) => node.id === selectedId)?.data as TraceNodeData | undefined;

  return (
    <aside className="trace" aria-label="Run trace">
      <header className="trace__head">
        <span className="trace__title">{selected ? "Step detail" : "Run trace"}</span>
        <div className="trace__head-actions">
          {selected && (
            <button type="button" className="trace__action" onClick={() => setSelectedId(null)}>
              Back to graph
            </button>
          )}
          <button type="button" className="trace__action" onClick={onClose}>
            Hide
          </button>
        </div>
      </header>

      {selected ? (
        <NodeDetail node={selected} />
      ) : (
        <div className="trace__canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={traceNodeTypes}
            onNodeClick={(_event, node: Node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
          >
            <Background color="rgba(255,255,255,0.05)" gap={24} size={2} />
          </ReactFlow>
        </div>
      )}
    </aside>
  );
}

function NodeDetail({ node }: { node: TraceNodeData }): React.JSX.Element {
  return (
    <div className="trace__detail">
      {node.nodeType === "task" && (
        <Section title="Prompt">
          <p className="trace__prose">{node.label}</p>
        </Section>
      )}

      {node.nodeType === "agent" && (
        <>
          <Section title="Why this model">
            <p className="trace__prose">{node.reason}</p>
          </Section>
          <Section title="Profile">
            <span className="trace__chip">{node.profile}</span>
          </Section>
          <Section title="Capability">
            <span className="trace__chip">{node.capability}</span>
          </Section>
        </>
      )}

      {node.nodeType === "tool" && (
        <>
          <Section title="Tool">
            <span className="trace__chip">{node.label}</span>
          </Section>
          <Section title="Result">
            <p className="trace__prose">{node.summary}</p>
          </Section>
          {node.input !== undefined && (
            <Section title="Arguments">
              <pre className="trace__payload">{stringify(node.input)}</pre>
            </Section>
          )}
          {node.output !== undefined && node.output !== null && (
            <Section title="Raw output">
              <pre className="trace__payload">{stringify(node.output)}</pre>
            </Section>
          )}
        </>
      )}

      {node.nodeType === "end" && (
        <>
          <Section title="Outcome">
            <span className="trace__chip">{node.status}</span>
          </Section>
          {node.result?.error && (
            <Section title="Error">
              <p className="trace__prose trace__prose--error">{node.result.error}</p>
            </Section>
          )}
          {node.result?.artifactFilename && (
            <Section title="Deliverable">
              <span className="trace__chip">{node.result.artifactFilename}</span>
            </Section>
          )}
          {node.result?.analysis && (
            <Section title="Answer">
              <p className="trace__prose">{node.result.analysis}</p>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="trace__section">
      <h3 className="trace__section-title">{title}</h3>
      {children}
    </section>
  );
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
