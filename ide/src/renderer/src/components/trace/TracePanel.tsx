import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { RunTrace } from "@shared/types.js";
import { buildTraceGraph, type TraceNodeData } from "@shared/trace-graph.js";

import { useTheme } from "../../theme/ThemeProvider.js";
import { Icon } from "../ui/Icon.js";
import { IconButton } from "../ui/IconButton.js";
import { PanelTabs, type PanelTab } from "../ui/PanelTabs.js";
import { traceNodeTypes } from "./TraceNodes.js";

export interface TracePanelProps {
  trace: RunTrace;
  onClose: () => void;
  onSelectTab: (tab: PanelTab) => void;
}

/**
 * Execution graph for one agent turn.
 *
 * The thread answers "what did it produce"; this answers "how". Clicking a
 * node opens its full detail — the routing rationale, or a tool call's exact
 * arguments and raw result — which is what makes a run auditable rather than
 * merely observable.
 */
/** Fit options, shared by the initial fit and every refit. */
const FIT_OPTIONS = { padding: 0.2, maxZoom: 1 } as const;

export function TracePanel(props: TracePanelProps): React.JSX.Element {
  // The provider has to sit outside the component that calls `useReactFlow`,
  // which the refit below needs.
  return (
    <ReactFlowProvider>
      <TraceInspector {...props} />
    </ReactFlowProvider>
  );
}

function TraceInspector({ trace, onClose, onSelectTab }: TracePanelProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const colors = useGraphColors();

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
        const stroke = edge.active ? colors.edgeActive : colors.edge;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: "bottom",
          targetHandle: "top",
          animated: edge.active,
          style: { stroke, strokeWidth: 1.75 },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
        };
      }),
    };
  }, [trace, selectedId, colors]);

  const selected = nodes.find((node) => node.id === selectedId)?.data as TraceNodeData | undefined;

  return (
    <aside className="panel" aria-label="Run trace">
      <header className="panel__head">
        <PanelTabs active="trace" onSelect={onSelectTab} traceEnabled />
        <div className="panel__actions">
          {selected && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSelectedId(null)}>
              <Icon name="chevron-left" size={13} />
              Graph
            </button>
          )}
          <IconButton
            icon="close"
            label="Close panel"
            size="sm"
            onClick={onClose}
            tooltipAlign="end"
          />
        </div>
      </header>

      {selected ? (
        <NodeDetail node={selected} />
      ) : (
        <div className="trace__canvas" ref={canvasRef}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={traceNodeTypes}
            onNodeClick={(_event, node: Node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={FIT_OPTIONS}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
          >
            <KeepGraphFramed canvasRef={canvasRef} signature={`${trace.runId}:${nodes.length}`} />
            <Background color={colors.dots} gap={22} size={1.5} />
          </ReactFlow>
        </div>
      )}
    </aside>
  );
}

/**
 * Keeps the whole run in frame.
 *
 * React Flow's `fitView` prop only fits once, on mount. Two things break that
 * assumption here: nodes arrive as a live run makes tool calls, and the panel
 * is now user-resizable — so without this, dragging the divider leaves the
 * graph parked off to one side of its own canvas.
 */
function KeepGraphFramed({
  canvasRef,
  signature,
}: {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  signature: string;
}): null {
  const { fitView } = useReactFlow();

  // Deferred a frame, because the fit has to be measured against the layout
  // that caused it, not the one being replaced.
  const fit = useCallback(() => {
    requestAnimationFrame(() => void fitView(FIT_OPTIONS));
  }, [fitView]);

  useEffect(fit, [signature, fit]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;

    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvasRef, fit]);

  return null;
}

interface GraphColors {
  edge: string;
  edgeActive: string;
  dots: string;
}

/**
 * Resolves the graph's colours from the active theme.
 *
 * React Flow writes edge strokes and marker fills into SVG attributes and its
 * own generated `<marker>` defs, which are not reliable places for a
 * `var()` reference — so the tokens are read off the document once per theme
 * instead of being passed through as variable names.
 */
function useGraphColors(): GraphColors {
  const { resolved } = useTheme();

  return useMemo(() => {
    const styles = getComputedStyle(document.documentElement);
    const read = (token: string, fallback: string): string =>
      styles.getPropertyValue(token).trim() || fallback;

    return {
      edge: read("--graph-edge", "rgba(255,255,255,0.14)"),
      edgeActive: read("--graph-edge-active", "rgba(88,166,255,0.65)"),
      dots: read("--graph-dots", "rgba(255,255,255,0.055)"),
    };
    // `resolved` is the signal that the custom properties have new values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);
}

function NodeDetail({ node }: { node: TraceNodeData }): React.JSX.Element {
  return (
    <div className="trace__detail selectable">
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
            <span className="trace__chip">
              <Icon name="cpu" size={12} />
              {node.profile}
            </span>
          </Section>
          <Section title="Capability">
            <span className="trace__chip">{node.capability}</span>
          </Section>
        </>
      )}

      {node.nodeType === "tool" && (
        <>
          <Section title="Tool">
            <span className="trace__chip">
              <Icon name="terminal" size={12} />
              {node.label}
            </span>
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
              <span className="trace__chip">
                <Icon name="file" size={12} />
                {node.result.artifactFilename}
              </span>
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

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
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
