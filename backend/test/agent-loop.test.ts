import { DataClassification } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, ModelToolCall } from "../src/infrastructure/models/model-provider.js";

const { runMessageMock } = vi.hoisted(() => ({
  runMessageMock: { create: vi.fn(), findMany: vi.fn() },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: { runMessage: runMessageMock } }));

const { runAgentLoop, FINAL_ANSWER_TOOL } = await import("../src/modules/agent/agent-loop.js");
const { RunWaitingForApproval } = await import("../src/modules/agent/agent-approval.service.js");
const { AppError } = await import("../src/lib/errors.js");

/** Transcript rows the mocked store hands back, in write order. */
let rows: Array<{ content: unknown }> = [];

beforeEach(() => {
  rows = [];
  runMessageMock.create.mockReset();
  runMessageMock.findMany.mockReset();
  runMessageMock.create.mockImplementation(async ({ data }: { data: { content: unknown } }) => {
    rows.push({ content: data.content });
    return {};
  });
  runMessageMock.findMany.mockImplementation(async () => rows);
});

function call(name: string, args: unknown, id = `call-${Math.random().toString(36).slice(2, 8)}`): ModelToolCall {
  return { id, name, argumentsJson: JSON.stringify(args) };
}

const finalCall = (answer = "Done.") =>
  call(FINAL_ANSWER_TOOL, { answer, confidence: "high" });

/** Builds a loop input whose model replies come from a scripted queue. */
function loop(options: {
  replies: Array<{ text?: string | null; toolCalls?: ModelToolCall[] }>;
  dispatch?: Record<string, (input: unknown) => Promise<unknown>>;
  maxTurns?: number;
  maxToolCalls?: number;
}) {
  const invoke = vi.fn();
  for (const reply of options.replies) {
    invoke.mockResolvedValueOnce({
      text: reply.text ?? null,
      toolCalls: reply.toolCalls ?? [],
      profileId: "remote-general",
    });
  }

  return {
    invoke,
    input: {
      runId: "run-1",
      classification: DataClassification.SYNTHETIC,
      systemPrompt: () => "system",
      openingMessage: "do the thing",
      dispatch: (options.dispatch ?? {}) as never,
      budget: { maxTurns: options.maxTurns ?? 6, maxToolCalls: options.maxToolCalls ?? 8 },
      invoke: invoke as never,
      signal: new AbortController().signal,
    },
  };
}

function transcript(): ChatMessage[] {
  return rows
    .map((row) => row.content as { kind?: string; message?: ChatMessage })
    .filter((envelope) => envelope.kind === "transcript")
    .map((envelope) => envelope.message!);
}

describe("runAgentLoop termination", () => {
  it("finishes when the model calls the terminal tool", async () => {
    const { input } = loop({ replies: [{ toolCalls: [finalCall("The line is fit for service.")] }] });

    const outcome = await runAgentLoop(input);

    expect(outcome.answer.answer).toBe("The line is fit for service.");
    expect(outcome.exhausted).toBe(false);
    expect(outcome.iterations).toBe(1);
  });

  it("keeps going across several tool calls before finishing", async () => {
    const read = vi.fn().mockResolvedValue({ ok: true, summary: "read 4kB" });
    const search = vi.fn().mockResolvedValue({ ok: true, summary: "2 citations" });
    const { input } = loop({
      replies: [
        { toolCalls: [call("artifact.read", { artifactId: "11111111-1111-4111-8111-111111111111", extractionVersion: "1" })] },
        { toolCalls: [call("knowledge.search", { query: "retirement thickness" })] },
        { toolCalls: [finalCall()] },
      ],
      dispatch: { "artifact.read": read, "knowledge.search": search },
    });

    const outcome = await runAgentLoop(input);

    expect(read).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(outcome.iterations).toBe(3);
  });

  it("never persists the opening turn, which may carry image bytes", async () => {
    const { input } = loop({ replies: [{ toolCalls: [finalCall()] }] });

    await runAgentLoop(input);

    // Derived from the run on every invocation instead, so a vision run's
    // rendered pages stay out of durable storage.
    expect(transcript().filter((message) => message.role === "user")).toHaveLength(0);
  });
});

describe("runAgentLoop when the model does not call the terminal tool", () => {
  it("asks it to, rather than accepting a stray reply as the answer", async () => {
    const { input, invoke } = loop({
      replies: [{ text: "Here is some prose." }, { toolCalls: [finalCall("Proper answer.")] }],
    });

    const outcome = await runAgentLoop(input);

    expect(outcome.answer.answer).toBe("Proper answer.");
    expect(invoke).toHaveBeenCalledTimes(2);
    // The nudge is a real message, so the model sees it on the next call.
    expect(transcript().some((message) => message.role === "user" && String(message.content).includes("final.answer"))).toBe(true);
  });

  it("accepts prose as the answer once the turn budget is spent", async () => {
    const { input } = loop({
      replies: [{ text: "First." }, { text: "Second, still prose." }],
      maxTurns: 2,
    });

    const outcome = await runAgentLoop(input);

    expect(outcome.answer.answer).toBe("Second, still prose.");
    expect(outcome.answer.confidence).toBe("low");
    expect(outcome.exhausted).toBe(true);
  });
});

describe("runAgentLoop budgets", () => {
  it("forces the terminal tool once turns run out", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, summary: "ok" });
    const { input, invoke } = loop({
      replies: [
        { toolCalls: [call("knowledge.search", { query: "a" })] },
        { toolCalls: [finalCall("Forced.")] },
      ],
      dispatch: { "knowledge.search": handler },
      maxTurns: 2,
    });

    const outcome = await runAgentLoop(input);

    // The last call must offer only the terminal tool, and require it.
    const lastCall = invoke.mock.calls.at(-1)![0] as { tools: Array<{ name: string }>; toolChoice: string };
    expect(lastCall.tools.map((tool) => tool.name)).toEqual([FINAL_ANSWER_TOOL]);
    expect(lastCall.toolChoice).toBe("required");
    expect(outcome.answer.answer).toBe("Forced.");
  });

  it("tells the model to finish when a tool reports the budget is spent", async () => {
    const handler = vi.fn().mockRejectedValue(
      new AppError(422, "Agent run tool-call limit exceeded", "RUN_TOOL_CALL_LIMIT_EXCEEDED"),
    );
    const { input, invoke } = loop({
      replies: [
        { toolCalls: [call("knowledge.search", { query: "a" })] },
        { toolCalls: [finalCall("Best effort.")] },
      ],
      dispatch: { "knowledge.search": handler },
    });

    const outcome = await runAgentLoop(input);

    // A spent budget must not fail the run; it must force a graceful finish.
    expect(outcome.answer.answer).toBe("Best effort.");
    const lastCall = invoke.mock.calls.at(-1)![0] as { toolChoice: string };
    expect(lastCall.toolChoice).toBe("required");
  });

  it("counts only executed tool calls against the budget", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, summary: "ok" });
    const { input, invoke } = loop({
      replies: [
        // A rejected argument set costs a turn but not a tool call.
        { toolCalls: [call("knowledge.search", { wrong: true })] },
        { toolCalls: [call("knowledge.search", { query: "a" })] },
        { toolCalls: [finalCall()] },
      ],
      dispatch: { "knowledge.search": handler },
      maxToolCalls: 2,
    });

    await runAgentLoop(input);

    expect(handler).toHaveBeenCalledTimes(1);
    const budgets = invoke.mock.calls.map(([arg]) => (arg as { toolChoice: string }).toolChoice);
    expect(budgets).not.toContain("required");
  });
});

describe("runAgentLoop tool failure handling", () => {
  it("feeds a bad-argument rejection back instead of failing the run", async () => {
    const { input } = loop({
      replies: [
        { toolCalls: [call("knowledge.search", { notAQuery: 1 })] },
        { toolCalls: [finalCall("Recovered.")] },
      ],
      dispatch: { "knowledge.search": vi.fn() },
    });

    const outcome = await runAgentLoop(input);

    expect(outcome.answer.answer).toBe("Recovered.");
    const results = transcript().filter((message) => message.role === "tool");
    expect(String(results[0]?.content)).toContain("Arguments rejected");
  });

  it("reports a thrown tool error to the model and carries on", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("Embedding provider rate limit exceeded"));
    const { input } = loop({
      replies: [
        { toolCalls: [call("knowledge.search", { query: "a" })] },
        { toolCalls: [finalCall("Answered without citations.")] },
      ],
      dispatch: { "knowledge.search": handler },
    });

    const outcome = await runAgentLoop(input);

    expect(outcome.answer.answer).toBe("Answered without citations.");
    expect(transcript().some((message) => message.role === "tool" && String(message.content).includes("rate limit"))).toBe(true);
  });

  it("rejects malformed JSON arguments with a repairable message", async () => {
    const { input } = loop({
      replies: [
        { toolCalls: [{ id: "c1", name: "knowledge.search", argumentsJson: "{not json" }] },
        { toolCalls: [finalCall()] },
      ],
      dispatch: { "knowledge.search": vi.fn() },
    });

    await runAgentLoop(input);

    expect(transcript().some((message) => message.role === "tool" && String(message.content).includes("not valid JSON"))).toBe(true);
  });

  it("refuses a tool that is not offered for this run", async () => {
    const { input } = loop({
      replies: [
        { toolCalls: [call("sandbox.execute", { language: "python", code: "print(1)" })] },
        { toolCalls: [finalCall()] },
      ],
      dispatch: {},
    });

    await runAgentLoop(input);

    expect(transcript().some((message) => message.role === "tool" && String(message.content).includes("not available"))).toBe(true);
  });

  it("rejects a terminal call that is missing required fields", async () => {
    const { input } = loop({
      replies: [
        { toolCalls: [call(FINAL_ANSWER_TOOL, { answer: "no confidence given" })] },
        { toolCalls: [finalCall("Now valid.")] },
      ],
    });

    const outcome = await runAgentLoop(input);

    expect(outcome.answer.answer).toBe("Now valid.");
    expect(transcript().some((message) => message.role === "tool" && String(message.content).includes("confidence"))).toBe(true);
  });
});

describe("runAgentLoop suspension and resume", () => {
  it("lets an approval suspension propagate so the run can pause", async () => {
    const handler = vi.fn().mockRejectedValue(new RunWaitingForApproval("approval-1"));
    const { input } = loop({
      replies: [{ toolCalls: [call("sandbox.execute", { language: "python", code: "print(1)" }, "c-sandbox")] }],
      dispatch: { "sandbox.execute": handler },
    });

    await expect(runAgentLoop(input)).rejects.toBeInstanceOf(RunWaitingForApproval);
    // The tool call is already on the transcript, which is what lets the
    // resumed run replay it.
    const assistant = transcript().find((message) => message.role === "assistant");
    expect(assistant?.toolCalls?.[0]?.id).toBe("c-sandbox");
  });

  it("replays a tool call whose result was never recorded, then continues", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, summary: "exit 0" });
    const { input, invoke } = loop({
      replies: [{ toolCalls: [finalCall("Ran after approval.")] }],
      dispatch: { "sandbox.execute": handler },
    });

    // Stand in for a suspended run: opening message and an assistant tool call,
    // with no result written because the run paused mid-execution.
    rows = [
      { content: { kind: "transcript", message: { role: "user", content: "do the thing" } } },
      { content: { kind: "transcript", message: {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c-sandbox", name: "sandbox.execute", argumentsJson: JSON.stringify({ language: "python", code: "print(1)" }) }],
      } } },
    ];

    const outcome = await runAgentLoop(input);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcome.answer.answer).toBe("Ran after approval.");
    // It resumed rather than restarting: the persisted assistant turn was
    // replayed and the model was asked exactly once for the next step.
    const sent = invoke.mock.calls[0]![0].messages as ChatMessage[];
    expect(sent.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(sent.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not replay a call whose result is already recorded", async () => {
    const handler = vi.fn();
    const { input } = loop({
      replies: [{ toolCalls: [finalCall()] }],
      dispatch: { "sandbox.execute": handler },
    });

    rows = [
      { content: { kind: "transcript", message: { role: "user", content: "do the thing" } } },
      { content: { kind: "transcript", message: {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c-sandbox", name: "sandbox.execute", argumentsJson: "{}" }],
      } } },
      { content: { kind: "transcript", message: { role: "tool", toolCallId: "c-sandbox", content: '{"ok":true}' } } },
    ];

    await runAgentLoop(input);

    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores progress rows that share the message table", async () => {
    const { input, invoke } = loop({ replies: [{ toolCalls: [finalCall()] }] });

    rows = [
      { content: { event: "RUN_STARTED", model: "remote-general" } },
      { content: { tool: "artifact.read", status: "completed" } },
    ];

    const outcome = await runAgentLoop(input);

    // Those rows are not transcript, so the loop starts a fresh conversation.
    expect(outcome.answer.answer).toBe("Done.");
    expect(invoke.mock.calls[0]![0].messages).toHaveLength(1);
  });
});
