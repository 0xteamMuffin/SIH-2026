import { ApprovalStatus, DataClassification, RunStatus, RunToolCallStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/errors.js";

const { approvalNoteMock, artifactMock, auditMock, agentRunMock, evidenceMock, extractArtifactMock, modelProfilesMock, generatePptxMock, generateXlsxMock, getArtifactBoundedMock, invokeModelMock, knowledgeSearchMock, outboxEventMock, queryRawMock, renderPdfPagesMock, runCodeMock, runMessageMock, runToolCallMock, toolApprovalMock, transactionMock } = vi.hoisted(() => ({
  approvalNoteMock: vi.fn(),
  artifactMock: { create: vi.fn(), find: vi.fn() },
  auditMock: vi.fn(),
  agentRunMock: {
    count: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  evidenceMock: { create: vi.fn(), findFirst: vi.fn() },
  extractArtifactMock: vi.fn(),
  modelProfilesMock: vi.fn(),
  generatePptxMock: vi.fn(),
  generateXlsxMock: vi.fn(),
  getArtifactBoundedMock: vi.fn(),
  invokeModelMock: vi.fn(),
  knowledgeSearchMock: vi.fn(),
  outboxEventMock: { create: vi.fn() },
  renderPdfPagesMock: vi.fn(),
  runCodeMock: vi.fn(),
  runMessageMock: { create: vi.fn(), findMany: vi.fn() },
  runToolCallMock: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  toolApprovalMock: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  transactionMock: vi.fn(),
  queryRawMock: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { agentRun: agentRunMock, evidence: evidenceMock, outboxEvent: outboxEventMock, runMessage: runMessageMock, runToolCall: runToolCallMock, toolApproval: toolApprovalMock, $transaction: transactionMock } }));
vi.mock("../src/lib/audit.js", () => ({ audit: auditMock }));
vi.mock("../src/infrastructure/models/model-orchestrator.js", () => ({ invokeModelWithFallbacks: invokeModelMock }));
vi.mock("../src/infrastructure/pdf-renderer/pdf-renderer-client.js", () => ({ renderPdfPages: renderPdfPagesMock }));
vi.mock("../src/infrastructure/sandbox/sandbox-client.js", () => ({ runCode: runCodeMock }));
vi.mock("../src/modules/artifacts/artifacts.service.js", () => ({ createArtifact: artifactMock.create, findArtifact: artifactMock.find, getArtifactBounded: getArtifactBoundedMock }));
vi.mock("../src/modules/artifacts/artifact-extraction.service.js", () => ({ extractArtifact: extractArtifactMock }));
// Routing reads the profile registry, so the pool is stated here rather than
// inherited from config/models.json and whichever API keys happen to be set.
vi.mock("../src/infrastructure/models/model-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/infrastructure/models/model-registry.js")>()),
  modelProfiles: modelProfilesMock,
}));
vi.mock("../src/modules/agent/agent-knowledge-search.js", () => ({ searchAgentKnowledge: knowledgeSearchMock }));
vi.mock("../src/modules/agent/approval-note.js", () => ({ approvalNoteDocx: approvalNoteMock }));
vi.mock("../src/modules/deliverables/pptx-generator.js", () => ({ generatePptx: generatePptxMock, PPTX_MIME_TYPE: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
vi.mock("../src/modules/deliverables/xlsx-generator.js", () => ({ generateXlsx: generateXlsxMock, XLSX_MIME_TYPE: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

import { cancelRun, createRun, executeRunTool, failRun, getRun, listRuns, processRun } from "../src/modules/agent/agent.service.js";

/** Rows written by the mocked run-message store, in write order. */
let messageRows: Array<{ content: unknown }> = [];

/** A tool call as the model would emit it. */
function modelToolCall(name: string, args: unknown, id = `call-${name}`) {
  return { id, name, argumentsJson: JSON.stringify(args) };
}

/** The terminal call the agent uses to finish a run. */
function finalAnswer(answer: string, confidence: "high" | "medium" | "low" = "high") {
  return modelToolCall("final.answer", { answer, confidence }, "call-final");
}

/**
 * Scripts the loop's model turns in order.
 *
 * Each entry is one assistant reply; the last should finish with
 * `final.answer` or the loop will keep asking.
 */
function scriptModel(
  profile: unknown,
  turns: Array<{ text?: string | null; toolCalls?: ReturnType<typeof modelToolCall>[] }>,
) {
  for (const turn of turns) {
    invokeModelMock.mockResolvedValueOnce({
      profile,
      response: { text: turn.text ?? null, toolCalls: turn.toolCalls ?? [] },
    });
  }
}

describe("agent run access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((input) => Array.isArray(input)
      ? Promise.all(input)
      : input({ $queryRaw: queryRawMock, agentRun: agentRunMock, outboxEvent: outboxEventMock, runToolCall: runToolCallMock, toolApproval: toolApprovalMock }));
    agentRunMock.count.mockResolvedValue(0);
    runToolCallMock.count.mockResolvedValue(0);
    evidenceMock.findFirst.mockResolvedValue(null);
    knowledgeSearchMock.mockResolvedValue([]);
    modelProfilesMock.mockReturnValue([localProfile, localVisionProfile]);

    // The loop rebuilds its transcript from this table, so the mock has to
    // read back what it was told to write.
    messageRows = [];
    runMessageMock.create.mockImplementation(async ({ data }: { data: { content: unknown } }) => {
      messageRows.push({ content: data.content });
      return {};
    });
    runMessageMock.findMany.mockImplementation(async () => messageRows);
  });

  it("creates a run and queue outbox event atomically", async () => {
    const run = { id: "run-1", workspaceId: "workspace-1", status: RunStatus.PENDING };
    agentRunMock.create.mockResolvedValue(run);
    outboxEventMock.create.mockResolvedValue({ id: "event-1" });

    await expect(createRun({ workspaceId: "workspace-1", userId: "user-1", task: "Summarize the public report", dataClassification: DataClassification.PUBLIC })).resolves.toEqual(run);

    expect(transactionMock).toHaveBeenCalledOnce();
    expect(agentRunMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      sourceArtifactId: undefined,
      state: expect.objectContaining({ tokenBudget: { maxInputTokens: 32768, maxOutputTokens: 8192, maxTotalTokens: 40960 } }),
    }) });
    expect(outboxEventMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ topic: "agent.run.requested", aggregateId: expect.any(String), payload: { runId: expect.any(String) } }) });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", eventType: "AGENT_RUN_CREATED" }));
    expect(queryRawMock.mock.calls[0]?.[0].join("")).toContain("::text");
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(agentRunMock.count.mock.invocationCallOrder[0]);
    expect(agentRunMock.count.mock.invocationCallOrder[1]).toBeLessThan(agentRunMock.create.mock.invocationCallOrder[0]);
    expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "ReadCommitted" });
  });

  it("rejects workspace and user concurrency limits at their boundaries", async () => {
    agentRunMock.count.mockResolvedValueOnce(1);
    await expect(createRun({ workspaceId: "workspace-1", userId: "user-1", task: "Summarize the public report", dataClassification: DataClassification.PUBLIC }))
      .rejects.toMatchObject({ status: 409, code: "WORKSPACE_RUN_CONCURRENCY_LIMIT_EXCEEDED" });

    vi.clearAllMocks();
    transactionMock.mockImplementation((work) => work({ $queryRaw: queryRawMock, agentRun: agentRunMock, outboxEvent: outboxEventMock }));
    agentRunMock.count.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    await expect(createRun({ workspaceId: "workspace-2", userId: "user-1", task: "Summarize another public report", dataClassification: DataClassification.PUBLIC }))
      .rejects.toMatchObject({ status: 429, code: "USER_RUN_CONCURRENCY_LIMIT_EXCEEDED" });

    expect(agentRunMock.create).not.toHaveBeenCalled();
    expect(outboxEventMock.create).not.toHaveBeenCalled();
  });

  it("serializes concurrent user admission so only the remaining slot is accepted", async () => {
    let activeUserRuns = 1;
    let lockTail = Promise.resolve();
    transactionMock.mockImplementation(async (work) => {
      const previousLock = lockTail;
      let releaseLock!: () => void;
      lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
      const transaction = {
        $queryRaw: vi.fn(async () => previousLock),
        agentRun: agentRunMock,
        outboxEvent: outboxEventMock,
      };
      try {
        return await work(transaction);
      } finally {
        releaseLock();
      }
    });
    agentRunMock.count.mockImplementation(({ where }) => Promise.resolve(typeof where.activeWorkspaceId === "string" ? 0 : activeUserRuns));
    agentRunMock.create.mockImplementation(({ data }) => {
      activeUserRuns += 1;
      return Promise.resolve({ ...data, status: RunStatus.PENDING });
    });
    outboxEventMock.create.mockResolvedValue({ id: "event-1" });

    const results = await Promise.allSettled([
      createRun({ workspaceId: "workspace-1", userId: "user-1", task: "Summarize the first public report", dataClassification: DataClassification.PUBLIC }),
      createRun({ workspaceId: "workspace-2", userId: "user-1", task: "Summarize the second public report", dataClassification: DataClassification.PUBLIC }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(agentRunMock.create).toHaveBeenCalledOnce();
    expect(activeUserRuns).toBe(2);
  });

  it("defers a pending run without consuming retries when global DB admission is full", async () => {
    const run = {
      id: "run-capacity",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Explain preventive maintenance",
      taskCapability: "general",
      modelProfile: "local-general",
      modelReason: "persisted route",
      dataClassification: DataClassification.INTERNAL,
      sourceArtifactId: null,
      status: RunStatus.PENDING,
      deadlineAt: new Date(Date.now() + 60_000),
    };
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.count.mockResolvedValue(1);

    await expect(processRun(run.id)).resolves.toBeUndefined();

    expect(queryRawMock).toHaveBeenCalledOnce();
    expect(queryRawMock.mock.calls[0]?.[0].join("")).toContain("::text");
    expect(agentRunMock.updateMany).not.toHaveBeenCalled();
    expect(outboxEventMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      topic: "agent.run.requested",
      aggregateId: run.id,
      payload: { runId: run.id },
      availableAt: expect.any(Date),
    }) });
    expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "ReadCommitted" });
  });

  it("terminally fails token-budget errors without queue retry", async () => {
    const run = {
      id: "run-budget",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Explain preventive maintenance",
      taskCapability: "general",
      modelProfile: "local-general",
      modelReason: "persisted route",
      dataClassification: DataClassification.INTERNAL,
      sourceArtifactId: null,
      status: RunStatus.PENDING,
      state: { version: 1, phase: "SOURCE", turn: 0, phaseStarted: false, tokenBudget: { maxInputTokens: 10, maxOutputTokens: 5, maxTotalTokens: 15 } },
      deadlineAt: new Date(Date.now() + 60_000),
      maxTurns: 4,
      maxToolCalls: 5,
    };
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...run, status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({});
    runMessageMock.create.mockResolvedValue({});
    invokeModelMock.mockRejectedValue(new AppError(422, "Agent run total-token budget exceeded", "RUN_TOKEN_BUDGET_EXCEEDED"));

    await expect(processRun(run.id)).resolves.toBeUndefined();

    expect(agentRunMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: run.id, status: RunStatus.RUNNING }),
      data: expect.objectContaining({ status: RunStatus.FAILED, result: { error: "Agent run total-token budget exceeded", code: "RUN_TOKEN_BUDGET_EXCEEDED" }, activeWorkspaceId: null }),
    }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: "AGENT_RUN_FAILED", metadata: expect.objectContaining({ exhausted: false }) }));
    expect(auditMock).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: "AGENT_RUN_ATTEMPT_FAILED" }));
  });

  it("selects a local profile for restricted data instead of the higher-priority remote profile", async () => {
    const run = { id: "run-1", workspaceId: "workspace-1", status: RunStatus.PENDING };
    agentRunMock.create.mockResolvedValue(run);
    outboxEventMock.create.mockResolvedValue({ id: "event-1" });

    await createRun({ workspaceId: "workspace-1", userId: "user-1", task: "Explain preventive maintenance", dataClassification: DataClassification.CONFIDENTIAL });

    expect(agentRunMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ modelProfile: "local-general" }) });
  });

  it("treats a duplicate delivery for a terminal run as a no-op", async () => {
    agentRunMock.findUnique.mockResolvedValue({ id: "run-1", status: RunStatus.COMPLETED });

    await expect(processRun("run-1")).resolves.toBeUndefined();

    expect(agentRunMock.updateMany).not.toHaveBeenCalled();
  });


  // ─── Loop-driven execution ────────────────────────────────────────────────

  const localProfile = { id: "local-general", providerId: "local-runtime", location: "local", baseUrl: "http://localhost:11434/v1", modelId: "qwen3.5:4b", capabilities: ["general", "document"], supportsTools: true, priority: 1000, enabled: true, sovereign: true, maxOutputTokens: 8192 };
  const localVisionProfile = { ...localProfile, id: "local-vision", capabilities: ["vision"], priority: 1001 };

  function documentRun(overrides: Record<string, unknown> = {}) {
    return {
      id: "run-loop",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Summarise the attached report",
      taskCapability: "document",
      modelProfile: "local-general",
      modelReason: "persisted route",
      dataClassification: DataClassification.SYNTHETIC,
      status: RunStatus.PENDING,
      state: {},
      maxTurns: 6,
      maxToolCalls: 8,
      deadlineAt: new Date(Date.now() + 60_000),
      sourceArtifactId: null,
      conversationId: null,
      ...overrides,
    };
  }

  function admitRun(run: ReturnType<typeof documentRun>) {
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue(run);
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    evidenceMock.create.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
  }

  it("lets the model choose its tools instead of following a fixed order", async () => {
    const run = documentRun();
    admitRun(run);
    knowledgeSearchMock.mockResolvedValue([]);
    scriptModel(localProfile, [
      { toolCalls: [modelToolCall("knowledge.search", { query: "retirement thickness" })] },
      { toolCalls: [finalAnswer("Retirement thickness is 6.53 mm.")] },
    ]);

    await processRun(run.id);

    expect(knowledgeSearchMock).toHaveBeenCalledOnce();
    expect(agentRunMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: RunStatus.COMPLETED,
        result: expect.objectContaining({ analysis: "Retirement thickness is 6.53 mm." }),
      }),
    }));
  });

  it("iterates: a tool result informs the next decision", async () => {
    const run = documentRun();
    admitRun(run);
    knowledgeSearchMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ artifactId: "20000000-0000-4000-8000-000000000001", title: "SOP", text: "Alert at 7.00 mm.", sourceRef: "artifact:20000000-0000-4000-8000-000000000001", score: 0.9 }]);
    scriptModel(localProfile, [
      { toolCalls: [modelToolCall("knowledge.search", { query: "first attempt" }, "c1")] },
      // Nothing came back, so the agent tries a different query rather than
      // answering from an empty result.
      { toolCalls: [modelToolCall("knowledge.search", { query: "second attempt" }, "c2")] },
      { toolCalls: [finalAnswer("The alert threshold is 7.00 mm.")] },
    ]);

    await processRun(run.id);

    expect(knowledgeSearchMock).toHaveBeenCalledTimes(2);
    expect(knowledgeSearchMock.mock.calls[1]![0]).toMatchObject({ query: "second attempt" });
  });

  it("records the answer's confidence and what it could not resolve", async () => {
    const run = documentRun();
    admitRun(run);
    invokeModelMock.mockResolvedValueOnce({
      profile: localProfile,
      response: {
        text: null,
        toolCalls: [modelToolCall("final.answer", {
          answer: "Partially answered.",
          confidence: "low",
          unresolved: ["No inspection date was given."],
        }, "call-final")],
      },
    });

    await processRun(run.id);

    expect(agentRunMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        result: expect.objectContaining({
          confidence: "low",
          unresolved: ["No inspection date was given."],
        }),
      }),
    }));
  });

  it("feeds a tool failure back so the run still completes", async () => {
    const run = documentRun();
    admitRun(run);
    knowledgeSearchMock.mockRejectedValue(new Error("Embedding provider rate limit exceeded"));
    scriptModel(localProfile, [
      { toolCalls: [modelToolCall("knowledge.search", { query: "anything" })] },
      { toolCalls: [finalAnswer("Answered without citations.")] },
    ]);

    await processRun(run.id);

    // A failing tool costs a turn, not the run.
    expect(agentRunMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: RunStatus.COMPLETED }),
    }));
  });

  it("suspends for approval before running code, without failing the run", async () => {
    const run = documentRun({ id: "run-approval", task: "Run a calculation" });
    admitRun(run);
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({ id: "tool-call-1" });
    toolApprovalMock.create.mockResolvedValue({ id: "approval-1" });
    scriptModel(localProfile, [
      { toolCalls: [modelToolCall("sandbox.execute", { language: "python", code: "print(1)" })] },
    ]);

    await processRun(run.id);

    // The sandbox never ran, the run is not marked failed, and an approval was
    // requested — the run is parked, waiting.
    expect(runCodeMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: "TOOL_APPROVAL_REQUESTED" }));
    expect(agentRunMock.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: RunStatus.FAILED }),
    }));
  });

  it("attaches rendered pages to the opening turn for a vision run", async () => {
    const artifactId = "30000000-0000-4000-8000-000000000001";
    const run = documentRun({ id: "run-vision", task: "Inspect this drawing", taskCapability: "vision", modelProfile: "local-vision", sourceArtifactId: artifactId });
    admitRun(run);
    artifactMock.find.mockResolvedValue({
      id: artifactId,
      workspaceId: "workspace-1",
      filename: "drawing.png",
      detectedMimeType: "image/png",
      objectKey: "artifacts/drawing.png",
      sizeBytes: BigInt(1024),
      extractionStatus: "PENDING",
    });
    getArtifactBoundedMock.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const visionProfile = { ...localProfile, id: "local-vision", capabilities: ["vision"] };
    scriptModel(visionProfile, [{ toolCalls: [finalAnswer("A P&ID excerpt.")] }]);

    await processRun(run.id);

    const [{ messages }] = invokeModelMock.mock.calls[0]!;
    const opening = messages[0];
    expect(Array.isArray(opening.content)).toBe(true);
    expect(opening.content.some((part: { type: string }) => part.type === "image")).toBe(true);
    // Image bytes must not reach run telemetry.
    expect(JSON.stringify(runMessageMock.create.mock.calls)).not.toContain('"type":"Buffer"');
  });

  it("re-routes to a vision profile when the agent asks to look at the document", async () => {
    // The run starts on a text profile because the PDF extracted fine. The
    // agent then finds the text useless and asks to see the page, which is a
    // need it discovers — it never names a model.
    const artifactId = "30000000-0000-4000-8000-000000000004";
    const run = documentRun({ id: "run-escalate", sourceArtifactId: artifactId });
    admitRun(run);
    artifactMock.find.mockResolvedValue({
      id: artifactId,
      workspaceId: "workspace-1",
      filename: "drawing.pdf",
      detectedMimeType: "application/pdf",
      objectKey: "artifacts/drawing.pdf",
      sizeBytes: BigInt(4096),
      extractionStatus: "COMPLETED",
    });
    extractArtifactMock.mockResolvedValue({ text: "Sheet 3 of 8. See drawing." });
    getArtifactBoundedMock.mockResolvedValue(Buffer.from([0x25, 0x50, 0x44, 0x46]));
    renderPdfPagesMock.mockResolvedValue({
      pages: [{ pageNumber: 1, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), width: 800, height: 600, sizeBytes: 4 }],
      sourcePageCount: 8,
      selectionPolicy: "first-page",
      renderer: "test",
      rendererVersion: "1",
      dpi: 150,
      totalBytes: 4,
    });
    scriptModel(localProfile, [
      { toolCalls: [modelToolCall("artifact.inspectVisually", { reason: "The text only refers to the drawing." })] },
    ]);
    scriptModel(localVisionProfile, [{ toolCalls: [finalAnswer("The drawing shows a flanged tee.")] }]);

    await processRun(run.id);

    const [first, second] = invokeModelMock.mock.calls;
    expect(first![0].decision.capability).toBe("general");
    // The turn after the request is routed on the new requirement.
    expect(second![0].decision.capability).toBe("vision");
    expect(second![0].decision.profile.id).toBe("local-vision");
    // The pages arrive as their own turn, carrying real image parts.
    const attached = second![0].messages.at(-1);
    expect(attached.role).toBe("user");
    expect(attached.content.some((part: { type: string }) => part.type === "image")).toBe(true);
    // The opening turn must not have been rewritten to carry them.
    expect(Array.isArray(second![0].messages[0].content)).toBe(false);
    // Image bytes must not reach durable run messages.
    expect(JSON.stringify(runMessageMock.create.mock.calls)).not.toContain('"type":"Buffer"');
  });

  it("extracts an attached document even when inference never runs", async () => {
    // Extraction used to be guaranteed by a fixed first phase. Now that the
    // model chooses its own tools, a run whose inference fails must still have
    // read its own attachment — otherwise the document is left unextracted
    // because nothing ever asked for it.
    const artifactId = "30000000-0000-4000-8000-000000000002";
    const run = documentRun({ id: "run-extract", sourceArtifactId: artifactId });
    admitRun(run);
    artifactMock.find.mockResolvedValue({
      id: artifactId,
      workspaceId: "workspace-1",
      filename: "note.pdf",
      detectedMimeType: "application/pdf",
      objectKey: "artifacts/note.pdf",
      sizeBytes: BigInt(2048),
      extractionStatus: "PENDING",
    });
    invokeModelMock.mockRejectedValue(new Error("no inference backend reachable"));

    await processRun(run.id).catch(() => undefined);

    expect(extractArtifactMock).toHaveBeenCalledWith(artifactId, expect.anything());
  });

  it("does not fail the run when extracting the attachment fails", async () => {
    // The agent gets the failure as a tool error when it calls artifact.read,
    // which it can act on; ending the run before it starts tells the user less.
    const artifactId = "30000000-0000-4000-8000-000000000003";
    const run = documentRun({ id: "run-extract-fails", sourceArtifactId: artifactId });
    admitRun(run);
    artifactMock.find.mockResolvedValue({
      id: artifactId,
      workspaceId: "workspace-1",
      filename: "note.pdf",
      detectedMimeType: "application/pdf",
      objectKey: "artifacts/note.pdf",
      sizeBytes: BigInt(2048),
      extractionStatus: "PENDING",
    });
    extractArtifactMock.mockRejectedValue(new Error("docling unavailable"));
    scriptModel(localProfile, [{ toolCalls: [finalAnswer("Could not read the attachment.")] }]);

    await processRun(run.id);

    expect(agentRunMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: RunStatus.COMPLETED }),
    }));
  });

  it("offers the tools with their schemas on every turn", async () => {
    const run = documentRun();
    admitRun(run);
    scriptModel(localProfile, [{ toolCalls: [finalAnswer("Done.")] }]);

    await processRun(run.id);

    const [{ tools, toolChoice }] = invokeModelMock.mock.calls[0]!;
    const names = tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("final.answer");
    expect(names).toContain("knowledge.search");
    expect(toolChoice).toBe("auto");
    // Schemas travel with the tools, so the model knows the argument shape.
    expect(tools.every((tool: { parameters: unknown }) => typeof tool.parameters === "object")).toBe(true);
  });

  it("checkpoints each iteration so a resumed run does not repeat work", async () => {
    const run = documentRun();
    admitRun(run);
    knowledgeSearchMock.mockResolvedValue([]);
    scriptModel(localProfile, [
      { toolCalls: [modelToolCall("knowledge.search", { query: "a" })] },
      { toolCalls: [finalAnswer("Done.")] },
    ]);

    await processRun(run.id);

    expect(agentRunMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: expect.objectContaining({ version: 2, iteration: expect.any(Number) }) }),
    }));
    // The transcript is what a resumed run reads back.
    const transcriptRows = messageRows.filter((row) => (row.content as { kind?: string }).kind === "transcript");
    expect(transcriptRows.length).toBeGreaterThan(2);
  });

  it("does not overwrite a cancelled run after worker failure", async () => {
    agentRunMock.findUnique.mockResolvedValue({ id: "run-1", status: RunStatus.CANCELLED });

    await expect(failRun("run-1", new Error("late worker failure"))).resolves.toBeUndefined();

    expect(agentRunMock.updateMany).not.toHaveBeenCalled();
  });

  it("scopes operator reads to workspace membership", async () => {
    agentRunMock.findFirst.mockResolvedValue({ id: "run-1" });

    await getRun("run-1", { id: "user-1", role: "OPERATOR" });

    expect(agentRunMock.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1", workspace: { members: { some: { userId: "user-1" } } } },
      include: expect.objectContaining({ modelInvocations: { orderBy: { attempt: "asc" } } }),
    }));
  });

  it("allows administrators to read runs without membership", async () => {
    agentRunMock.findFirst.mockResolvedValue({ id: "run-1" });

    await getRun("run-1", { id: "admin-1", role: "ADMIN" });

    expect(agentRunMock.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "run-1" } }));
  });

  it("lists only a workspace-scoped run page with a stable cursor", async () => {
    const first = { id: "10000000-0000-4000-8000-000000000002", createdAt: new Date("2026-08-30T12:00:00.000Z") };
    const second = { id: "10000000-0000-4000-8000-000000000001", createdAt: new Date("2026-08-30T11:00:00.000Z") };
    agentRunMock.findMany.mockResolvedValue([first, second]);

    const result = await listRuns({ workspaceId: "workspace-1", limit: 1 });

    expect(agentRunMock.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
      select: expect.objectContaining({ id: true, result: true, createdAt: true }),
    }));
    expect(result.runs).toEqual([first]);
    expect(JSON.parse(Buffer.from(result.nextCursor!, "base64url").toString("utf8"))).toEqual({ createdAt: first.createdAt.toISOString(), id: first.id });
  });

  it("applies a composite keyset cursor within the requested workspace", async () => {
    agentRunMock.findMany.mockResolvedValue([]);
    const cursor = { createdAt: new Date("2026-08-30T12:00:00.000Z"), id: "10000000-0000-4000-8000-000000000001" };

    await listRuns({ workspaceId: "workspace-2", limit: 25, cursor });

    expect(agentRunMock.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: "workspace-2",
        OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
      },
    }));
  });

  it("does not reveal inaccessible runs during cancellation", async () => {
    agentRunMock.findFirst.mockResolvedValue(null);

    await expect(cancelRun("run-1", { id: "user-1", role: "OPERATOR" })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(agentRunMock.updateMany).not.toHaveBeenCalled();
  });

  it("cancels active runs with an atomic state transition", async () => {
    const run = { id: "run-1", workspaceId: "workspace-1", status: RunStatus.RUNNING };
    const cancelled = { ...run, status: RunStatus.CANCELLED };
    agentRunMock.findFirst.mockResolvedValue(run);
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    agentRunMock.findUniqueOrThrow.mockResolvedValue(cancelled);

    await expect(cancelRun("run-1", { id: "user-1", role: "OPERATOR" })).resolves.toEqual(cancelled);
    expect(agentRunMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1", status: { in: [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.WAITING_APPROVAL] } },
    }));
    expect(outboxEventMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ topic: "agent.run.cancelled", aggregateId: "run-1" }) });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ actorId: "user-1", eventType: "AGENT_RUN_CANCELLED" }));
  });

  it("treats repeated cancellation as an idempotent success", async () => {
    const cancelled = { id: "run-1", workspaceId: "workspace-1", status: RunStatus.CANCELLED };
    agentRunMock.findFirst.mockResolvedValue(cancelled);

    await expect(cancelRun("run-1", { id: "user-1", role: "OPERATOR" })).resolves.toEqual(cancelled);

    expect(transactionMock).not.toHaveBeenCalled();
    expect(outboxEventMock.create).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("cancels runs that are waiting for approval", async () => {
    const waiting = { id: "run-1", workspaceId: "workspace-1", status: RunStatus.WAITING_APPROVAL };
    agentRunMock.findFirst.mockResolvedValue(waiting);
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...waiting, status: RunStatus.CANCELLED });

    await cancelRun("run-1", { id: "user-1", role: "OPERATOR" });

    expect(toolApprovalMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: ApprovalStatus.PENDING }) }));
    expect(runToolCallMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: RunToolCallStatus.CANCELLED }) }));
  });

  it("rejects cancellation after another transition wins", async () => {
    agentRunMock.findFirst.mockResolvedValue({ id: "run-1", status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 0 });
    agentRunMock.findUnique.mockResolvedValue({ id: "run-1", status: RunStatus.COMPLETED });

    await expect(cancelRun("run-1", { id: "user-1", role: "OPERATOR" })).rejects.toMatchObject({ status: 409, code: "RUN_NOT_ACTIVE" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns a completed tool result without repeating its side effect", async () => {
    const output = { ok: true, summary: "already generated", data: { artifactId: "artifact-1" } };
    runToolCallMock.findUnique.mockResolvedValue({ status: "COMPLETED", output });
    const work = vi.fn();

    await expect(executeRunTool("run-1", "deliverable.create", { format: "docx" }, work)).resolves.toEqual(output);

    expect(work).not.toHaveBeenCalled();
    expect(runToolCallMock.update).not.toHaveBeenCalled();
  });

  it("pauses before executing a new high-risk sandbox call", async () => {
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({ id: "tool-call-1" });
    toolApprovalMock.create.mockResolvedValue({ id: "approval-1" });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    const work = vi.fn();

    await expect(executeRunTool(
      "run-1",
      "sandbox.execute",
      { language: "javascript", code: "console.log('safe')" },
      work,
      undefined,
      { workspaceId: "workspace-1", leaseId: "lease-1", maxToolCalls: 5 },
    )).rejects.toThrow("waiting for tool approval");

    expect(work).not.toHaveBeenCalled();
    expect(toolApprovalMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      toolName: "sandbox.execute",
      toolInput: { language: "javascript", code: "console.log('safe')" },
    }) });
  });

  it("executes an approved waiting tool and returns a rejected tool as an observation", async () => {
    const persistedInput = { language: "javascript", code: "console.log('persisted')" };
    const waitingCall = { id: "tool-call-1", modelToolCallId: "model-call-1", status: RunToolCallStatus.WAITING_APPROVAL, input: persistedInput };
    runToolCallMock.findUnique.mockResolvedValue(waitingCall);
    runToolCallMock.updateMany.mockResolvedValue({ count: 1 });
    runToolCallMock.update.mockResolvedValue({});
    toolApprovalMock.findUnique.mockResolvedValue({ id: "approval-1", status: ApprovalStatus.APPROVED });
    const approvedWork = vi.fn().mockResolvedValue({ ok: true, summary: "executed", stdout: "2", stderr: "", exitCode: 0 });

    await expect(executeRunTool("run-1", "sandbox.execute", persistedInput, approvedWork)).resolves.toMatchObject({ ok: true });
    expect(approvedWork).toHaveBeenCalledWith(persistedInput);

    vi.clearAllMocks();
    runToolCallMock.findUnique.mockResolvedValue(waitingCall);
    runToolCallMock.updateMany.mockResolvedValue({ count: 1 });
    toolApprovalMock.findUnique.mockResolvedValue({ id: "approval-1", status: ApprovalStatus.REJECTED });
    const rejectedWork = vi.fn();

    await expect(executeRunTool("run-1", "sandbox.execute", { language: "javascript", code: "1 + 1" }, rejectedWork)).resolves.toMatchObject({ ok: false, errorCode: "TOOL_APPROVAL_REJECTED" });
    expect(rejectedWork).not.toHaveBeenCalled();
  });

});
