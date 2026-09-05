import { describe, expect, it, vi } from "vitest";

const { agentRunMock, loggerMock } = vi.hoisted(() => ({
  agentRunMock: { findMany: vi.fn(), findFirst: vi.fn() },
  loggerMock: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: { agentRun: agentRunMock } }));
vi.mock("../src/lib/logger.js", () => ({ logger: loggerMock }));

const { conversationPrompt, loadConversationHistory } = await import(
  "../src/modules/agent/conversation-history.js"
);

function completedRun(task: string, analysis: string) {
  return { task, result: { analysis } };
}

describe("loadConversationHistory", () => {
  it("returns nothing for a standalone run", async () => {
    const history = await loadConversationHistory({
      workspaceId: "workspace-1",
      conversationId: null,
      excludeRunId: "run-1",
    });

    expect(history).toEqual([]);
    // A run with no conversation should not cost a query.
    expect(agentRunMock.findMany).not.toHaveBeenCalled();
  });

  it("asks only for completed turns of the same conversation, excluding itself", async () => {
    agentRunMock.findMany.mockResolvedValue([]);
    agentRunMock.findFirst.mockResolvedValue(null);

    await loadConversationHistory({
      workspaceId: "workspace-1",
      conversationId: "chat-1",
      excludeRunId: "run-2",
    });

    expect(agentRunMock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace-1",
          conversationId: "chat-1",
          status: "COMPLETED",
          id: { not: "run-2" },
        }),
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("reports a thread whose earlier turns sit in another workspace", async () => {
    // This is a client bug — a chat must stay in one workspace — and scoping
    // hides it as a plain empty history, so it has to be said out loud.
    agentRunMock.findMany.mockResolvedValue([]);
    agentRunMock.findFirst.mockResolvedValue({ workspaceId: "workspace-2" });

    const history = await loadConversationHistory({
      workspaceId: "workspace-1",
      conversationId: "chat-1",
      excludeRunId: "run-2",
    });

    expect(history).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestedWorkspaceId: "workspace-1", foundInWorkspaceId: "workspace-2" }),
      expect.stringContaining("different workspace"),
    );
  });

  it("stays quiet when a thread simply has no earlier turns", async () => {
    agentRunMock.findMany.mockResolvedValue([]);
    agentRunMock.findFirst.mockResolvedValue(null);
    loggerMock.warn.mockClear();

    await loadConversationHistory({ workspaceId: "workspace-1", conversationId: "chat-1", excludeRunId: "run-2" });

    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("returns turns oldest first, so the transcript reads forwards", async () => {
    agentRunMock.findMany.mockResolvedValue([
      completedRun("second question", "second answer"),
      completedRun("first question", "first answer"),
    ]);

    const history = await loadConversationHistory({
      workspaceId: "workspace-1",
      conversationId: "chat-1",
      excludeRunId: "run-3",
    });

    expect(history.map((turn) => turn.task)).toEqual(["first question", "second question"]);
  });

  it("skips a completed run that produced no analysis", async () => {
    agentRunMock.findMany.mockResolvedValue([
      { task: "artifact only", result: { artifact: { id: "a" } } },
      completedRun("answered", "an answer"),
    ]);

    const history = await loadConversationHistory({
      workspaceId: "workspace-1",
      conversationId: "chat-1",
      excludeRunId: "run-3",
    });

    expect(history).toHaveLength(1);
    expect(history[0]!.task).toBe("answered");
  });

  it("truncates a long answer rather than dropping the turn", async () => {
    agentRunMock.findMany.mockResolvedValue([completedRun("q", "x".repeat(5_000))]);

    const history = await loadConversationHistory({
      workspaceId: "workspace-1",
      conversationId: "chat-1",
      excludeRunId: "run-3",
    });

    expect(history[0]!.answer.length).toBeLessThan(1_400);
    expect(history[0]!.answer.endsWith("…")).toBe(true);
  });

  it("drops the oldest turns once the history budget is spent", async () => {
    // Newest first, as the query returns them. Each turn is ~1.2k characters,
    // so an 8k budget cannot hold all ten.
    const runs = Array.from({ length: 10 }, (_, index) =>
      completedRun(`question ${9 - index}`, "y".repeat(1_200)),
    );
    agentRunMock.findMany.mockResolvedValue(runs);

    const history = await loadConversationHistory({
      workspaceId: "workspace-1",
      conversationId: "chat-1",
      excludeRunId: "run-99",
    });

    expect(history.length).toBeLessThan(10);
    // The most recent turn is the one that must survive.
    expect(history.at(-1)!.task).toBe("question 9");
  });
});

describe("conversationPrompt", () => {
  it("renders turns as a labelled transcript", () => {
    const prompt = conversationPrompt([
      { task: "What is the minimum reading?", answer: "6.81 mm at station 41." },
      { task: "Is that below retirement?", answer: "No, retirement is 6.53 mm." },
    ]);

    expect(prompt).toBe(
      "User: What is the minimum reading?\nAssistant: 6.81 mm at station 41.\n\n" +
        "User: Is that below retirement?\nAssistant: No, retirement is 6.53 mm.",
    );
  });

  it("renders an empty history as an empty string", () => {
    expect(conversationPrompt([])).toBe("");
  });
});
