import { describe, expect, it } from "vitest";

import type { RunTrace } from "@shared/types.js";

import { buildTraceGraph } from "@shared/trace-graph.js";
import { toTrace } from "../src/main/services/backend-agent.js";
import type { BackendRun } from "../src/main/services/backend-client.js";

function trace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: "run-1",
    task: "Draft an approval note",
    status: "completed",
    modelProfile: "remote-general",
    modelReason: "Task capability 'document' selected profile 'remote-general' by configured priority.",
    capability: "document",
    toolCalls: [],
    ...overrides,
  };
}

const toolCall = (toolName: string, state: RunTrace["toolCalls"][number]["state"]) => ({
  toolName,
  state,
  summary: `${toolName} summary`,
});

describe("toTrace", () => {
  const run: BackendRun = {
    id: "run-9",
    status: "COMPLETED",
    task: "Summarise the report",
    modelProfile: "groq-general",
    modelReason: "routed by priority",
    taskCapability: "document",
    toolCalls: [{
      toolName: "artifact.read",
      status: "COMPLETED",
      input: { artifactId: "abc" },
      output: { ok: true, summary: "Extracted report.pdf" },
    }],
    result: { analysis: "All within tolerance.", artifact: { id: "a1", filename: "note.docx", mimeType: "x", kind: "GENERATED_DOCX" } },
  };

  it("carries the routing decision the thread deliberately omits", () => {
    const result = toTrace(run);

    expect(result.modelProfile).toBe("groq-general");
    expect(result.modelReason).toBe("routed by priority");
    expect(result.capability).toBe("document");
  });

  it("keeps each tool call's raw arguments and output for inspection", () => {
    const [call] = toTrace(run).toolCalls;

    expect(call?.input).toEqual({ artifactId: "abc" });
    expect(call?.output).toMatchObject({ summary: "Extracted report.pdf" });
    expect(call?.state).toBe("completed");
  });

  it("records the terminal outcome", () => {
    const result = toTrace(run).result;

    expect(result?.analysis).toBe("All within tolerance.");
    expect(result?.artifactFilename).toBe("note.docx");
  });

  it("omits the result entirely while a run is still going", () => {
    const { result: _result, ...running } = run;
    expect(toTrace({ ...running, status: "RUNNING" }).result).toBeUndefined();
  });

  it("surfaces a failure reason", () => {
    const failed = toTrace({ ...run, status: "FAILED", result: { error: "Sandbox exited 2" } });

    expect(failed.status).toBe("failed");
    expect(failed.result?.error).toBe("Sandbox exited 2");
  });
});

describe("buildTraceGraph", () => {
  it("always starts with the task and the routing decision", () => {
    const { nodes } = buildTraceGraph(trace(), null);

    expect(nodes.map((node) => node.id).slice(0, 2)).toEqual(["task", "agent"]);
  });

  it("adds one node per tool call, in order", () => {
    const { nodes } = buildTraceGraph(
      trace({ toolCalls: [toolCall("artifact.read", "completed"), toolCall("knowledge.search", "failed")] }),
      null,
    );

    expect(nodes.map((node) => node.id)).toEqual(["task", "agent", "tool-0", "tool-1", "end"]);
  });

  it("chains every node into a single path", () => {
    const { nodes, edges } = buildTraceGraph(
      trace({ toolCalls: [toolCall("artifact.read", "completed"), toolCall("knowledge.search", "completed")] }),
      null,
    );

    // A run is sequential, so the graph is a path: one fewer edge than nodes.
    expect(edges).toHaveLength(nodes.length - 1);
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["task", "agent"],
      ["agent", "tool-0"],
      ["tool-0", "tool-1"],
      ["tool-1", "end"],
    ]);
  });

  it("gives every edge an id free of punctuation", () => {
    const { edges } = buildTraceGraph(trace({ toolCalls: [toolCall("artifact.read", "completed")] }), null);

    for (const edge of edges) {
      expect(edge.id).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });

  it("omits the outcome node while the run is live", () => {
    const { nodes } = buildTraceGraph(trace({ status: "running", toolCalls: [toolCall("artifact.read", "running")] }), null);

    expect(nodes.some((node) => node.id === "end")).toBe(false);
  });

  it("adds the outcome node once the run settles", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const { nodes } = buildTraceGraph(trace({ status }), null);
      expect(nodes.some((node) => node.id === "end"), status).toBe(true);
    }
  });

  it("marks only the edge into a running tool as active", () => {
    const { edges } = buildTraceGraph(
      trace({ status: "running", toolCalls: [toolCall("artifact.read", "completed"), toolCall("knowledge.search", "running")] }),
      null,
    );

    expect(edges.find((edge) => edge.target === "tool-0")?.active).toBe(false);
    expect(edges.find((edge) => edge.target === "tool-1")?.active).toBe(true);
  });

  it("marks only the selected node", () => {
    const { nodes } = buildTraceGraph(trace({ toolCalls: [toolCall("artifact.read", "completed")] }), "tool-0");
    const selected = nodes.filter((node) => (node.data as { selected: boolean }).selected);

    expect(selected.map((node) => node.id)).toEqual(["tool-0"]);
  });

  it("staggers consecutive tool nodes to opposite sides of the spine", () => {
    const { nodes } = buildTraceGraph(
      trace({ toolCalls: [toolCall("a", "completed"), toolCall("b", "completed")] }),
      null,
    );
    const [first, second] = nodes.filter((node) => node.id.startsWith("tool-"));

    expect(first!.position.x).not.toBe(second!.position.x);
  });

  it("lays nodes out top to bottom", () => {
    const { nodes } = buildTraceGraph(trace({ toolCalls: [toolCall("a", "completed")] }), null);

    for (let index = 1; index < nodes.length; index += 1) {
      expect(nodes[index]!.position.y).toBeGreaterThan(nodes[index - 1]!.position.y);
    }
  });
});
