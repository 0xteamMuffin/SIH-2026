import { ApprovalStatus, DataClassification, RunStatus, RunToolCallStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/errors.js";

const { approvalNoteMock, artifactMock, auditMock, agentRunMock, evidenceMock, extractArtifactMock, generatePptxMock, generateXlsxMock, getArtifactBoundedMock, invokeModelMock, knowledgeSearchMock, outboxEventMock, queryRawMock, renderPdfPagesMock, runCodeMock, runMessageMock, runToolCallMock, toolApprovalMock, transactionMock } = vi.hoisted(() => ({
  approvalNoteMock: vi.fn(),
  artifactMock: { create: vi.fn(), find: vi.fn() },
  auditMock: vi.fn(),
  agentRunMock: {
    count: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  evidenceMock: { create: vi.fn(), findFirst: vi.fn() },
  extractArtifactMock: vi.fn(),
  generatePptxMock: vi.fn(),
  generateXlsxMock: vi.fn(),
  getArtifactBoundedMock: vi.fn(),
  invokeModelMock: vi.fn(),
  knowledgeSearchMock: vi.fn(),
  outboxEventMock: { create: vi.fn() },
  renderPdfPagesMock: vi.fn(),
  runCodeMock: vi.fn(),
  runMessageMock: { create: vi.fn() },
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
vi.mock("../src/modules/agent/agent-knowledge-search.js", () => ({ searchAgentKnowledge: knowledgeSearchMock }));
vi.mock("../src/modules/agent/approval-note.js", () => ({ approvalNoteDocx: approvalNoteMock }));
vi.mock("../src/modules/deliverables/pptx-generator.js", () => ({ generatePptx: generatePptxMock, PPTX_MIME_TYPE: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
vi.mock("../src/modules/deliverables/xlsx-generator.js", () => ({ generateXlsx: generateXlsxMock, XLSX_MIME_TYPE: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

import { cancelRun, createRun, executeRunTool, failRun, getRun, processRun } from "../src/modules/agent/agent.service.js";

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

  it("persists the selected profile when a worker fallback succeeds", async () => {
    const run = {
      id: "run-1",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Explain preventive maintenance",
      taskCapability: "general",
      modelProfile: "remote-general",
      modelReason: "persisted route",
      dataClassification: DataClassification.PUBLIC,
      sourceArtifactId: null,
      status: RunStatus.PENDING,
    };
    const selectedProfile = {
      id: "local-general",
      providerId: "local-runtime",
      location: "local",
      baseUrl: "http://localhost:11434/v1",
      modelId: "qwen3.5:4b",
      capabilities: ["general", "document"],
      priority: 1000,
      enabled: true,
      sovereign: true,
      maxOutputTokens: 2048,
    };
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...run, status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({});
    runToolCallMock.update.mockResolvedValue({});
    runMessageMock.create.mockResolvedValue({});
    evidenceMock.create.mockResolvedValue({ id: "evidence-1" });
    invokeModelMock.mockResolvedValue({ profile: selectedProfile, response: { text: "Use scheduled inspections.", provider: "local-runtime", modelId: "qwen3.5:4b", latencyMs: 10 } });

    await processRun("run-1");

    expect(agentRunMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "run-1", status: RunStatus.RUNNING }),
      data: expect.objectContaining({ modelProfile: "local-general", modelReason: expect.stringContaining("completed the model invocation") }),
    }));
  });

  it("persists retrieved citations and supplies only source evidence to the model and deliverable", async () => {
    const artifactId = "10000000-0000-4000-8000-000000000011";
    const sourceRef = `artifact:${artifactId}#page=4&lines=8-9`;
    const run = {
      id: "run-grounded",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Create an approval note for the valve inspection interval",
      taskCapability: "document",
      modelProfile: "local-general",
      modelReason: "persisted route",
      dataClassification: DataClassification.INTERNAL,
      sourceArtifactId: null,
      status: RunStatus.PENDING,
    };
    const selectedProfile = { id: "local-general", providerId: "local-runtime", location: "local", baseUrl: "http://localhost:11434/v1", modelId: "qwen3.5:4b", capabilities: ["general", "document"], priority: 1000, enabled: true, sovereign: true, maxOutputTokens: 2048 };
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...run, status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({});
    runToolCallMock.update.mockResolvedValue({});
    runMessageMock.create.mockResolvedValue({});
    evidenceMock.create
      .mockResolvedValueOnce({ id: "20000000-0000-4000-8000-000000000011" })
      .mockResolvedValueOnce({ id: "20000000-0000-4000-8000-000000000012" });
    knowledgeSearchMock.mockResolvedValue([{
      artifactId,
      title: "Inspection manual - Valves",
      text: "Valve V-101 must be inspected every 30 days.",
      sourceRef,
      score: 0.92,
    }]);
    invokeModelMock.mockResolvedValue({ profile: selectedProfile, response: { text: "Inspect V-101 every 30 days." } });
    approvalNoteMock.mockResolvedValue(Buffer.from("docx"));
    artifactMock.create.mockResolvedValue({ id: "50000000-0000-4000-8000-000000000011", sizeBytes: 4 });

    await processRun(run.id);

    expect(knowledgeSearchMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: run.workspaceId,
      classification: DataClassification.INTERNAL,
      query: run.task,
      signal: expect.any(AbortSignal),
    }));
    expect(evidenceMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      kind: "SOURCE",
      artifactId,
      sourceRef,
      facts: ["Valve V-101 must be inspected every 30 days."],
    }) });
    expect(invokeModelMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining(sourceRef),
    }));
    expect(approvalNoteMock).toHaveBeenCalledWith(run.task, [{
      id: "20000000-0000-4000-8000-000000000011",
      title: "Inspection manual - Valves",
      summary: "Valve V-101 must be inspected every 30 days.",
      facts: ["Valve V-101 must be inspected every 30 days."],
      sourceRef,
    }]);
  });

  it("sends a bounded original image without Docling and does not persist its bytes", async () => {
    const run = {
      id: "run-vision",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Inspect this image",
      taskCapability: "vision",
      modelProfile: "local-vision",
      modelReason: "persisted route",
      dataClassification: DataClassification.INTERNAL,
      sourceArtifactId: "10000000-0000-4000-8000-000000000001",
      status: RunStatus.PENDING,
    };
    const source = {
      id: "10000000-0000-4000-8000-000000000001",
      workspaceId: "workspace-1",
      filename: "drawing.png",
      mimeType: "image/png",
      detectedMimeType: "image/png",
      objectKey: "workspace-1/drawing.png",
      sizeBytes: 4n,
      extractionStatus: "FAILED",
      extractionError: "[EXTRACTION_UNAVAILABLE] Document extraction service is unavailable",
    };
    const selectedProfile = {
      id: "local-vision",
      providerId: "local-runtime",
      location: "local",
      baseUrl: "http://localhost:11434/v1",
      modelId: "qwen3.5:4b",
      capabilities: ["vision"],
      priority: 1000,
      enabled: true,
      sovereign: true,
      maxOutputTokens: 2048,
    };
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...run, status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    artifactMock.find.mockResolvedValue(source);
    extractArtifactMock.mockRejectedValue(new AppError(502, "Document extraction service is unavailable", "EXTRACTION_UNAVAILABLE"));
    getArtifactBoundedMock.mockResolvedValue(imageBytes);
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({});
    runToolCallMock.update.mockResolvedValue({});
    runMessageMock.create.mockResolvedValue({});
    evidenceMock.create.mockResolvedValue({ id: "evidence-1" });
    artifactMock.create.mockResolvedValue({ id: "50000000-0000-4000-8000-000000000001", sizeBytes: 1 });
    invokeModelMock.mockResolvedValue({ profile: selectedProfile, response: { text: "Valve V-101 appears open.", provider: "local-runtime", modelId: "qwen3.5:4b", latencyMs: 10 } });

    await processRun("run-vision");

    expect(getArtifactBoundedMock).toHaveBeenCalledWith(source.objectKey, 10 * 1024 * 1024, expect.any(AbortSignal));
    expect(invokeModelMock).toHaveBeenCalledWith(expect.objectContaining({
      classification: DataClassification.INTERNAL,
      prompt: expect.stringContaining("visual findings are not OCR-grounded"),
      images: [{ mimeType: "image/png", bytes: imageBytes }],
    }));
    expect(extractArtifactMock).not.toHaveBeenCalled();
    expect(evidenceMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ facts: [] }) });
    const persistedCalls = JSON.stringify({ messages: runMessageMock.create.mock.calls, toolCreates: runToolCallMock.create.mock.calls, toolUpdates: runToolCallMock.update.mock.calls });
    expect(persistedCalls).not.toContain(imageBytes.toString("base64"));
    expect(persistedCalls).not.toContain('"bytes"');
    expect(persistedCalls).not.toContain('"type":"Buffer"');
    expect(persistedCalls).toContain('"mode":"original-image"');
  });

  it("uses bounded rendered PDF pages without Docling", async () => {
    const run = {
      id: "run-pdf",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Inspect the diagram in this PDF",
      taskCapability: "vision",
      modelProfile: "local-vision",
      modelReason: "persisted route",
      dataClassification: DataClassification.CONFIDENTIAL,
      sourceArtifactId: "10000000-0000-4000-8000-000000000002",
      status: RunStatus.PENDING,
    };
    const source = { id: "10000000-0000-4000-8000-000000000002", workspaceId: "workspace-1", filename: "drawing.pdf", mimeType: "application/pdf", detectedMimeType: "application/pdf", objectKey: "workspace-1/drawing.pdf", sizeBytes: 100n, extractionStatus: "FAILED", extractionError: "[EXTRACTION_UNAVAILABLE] Document extraction service is unavailable" };
    const selectedProfile = { id: "local-vision", providerId: "local-runtime", location: "local", baseUrl: "http://localhost:11434/v1", modelId: "qwen3.5:4b", capabilities: ["vision"], priority: 1000, enabled: true, sovereign: true, maxOutputTokens: 2048 };
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...run, status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    artifactMock.find.mockResolvedValue(source);
    extractArtifactMock.mockRejectedValue(new AppError(502, "Document extraction service is unavailable", "EXTRACTION_UNAVAILABLE"));
    const pdfBytes = Buffer.from("%PDF-test");
    const pageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    getArtifactBoundedMock.mockResolvedValue(pdfBytes);
    renderPdfPagesMock.mockResolvedValue({
      pages: [{ pageNumber: 1, width: 100, height: 200, sizeBytes: pageBytes.byteLength, bytes: pageBytes }],
      sourcePageCount: 1,
      selectionPolicy: "all-within-limit",
      renderer: "test-renderer",
      rendererVersion: "1",
      dpi: 120,
      totalBytes: pageBytes.byteLength,
    });
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({});
    runToolCallMock.update.mockResolvedValue({});
    runMessageMock.create.mockResolvedValue({});
    evidenceMock.create.mockResolvedValue({ id: "evidence-1" });
    artifactMock.create.mockResolvedValue({ id: "50000000-0000-4000-8000-000000000002", sizeBytes: 1 });
    invokeModelMock.mockResolvedValue({ profile: selectedProfile, response: { text: "Text-only finding.", provider: "local-runtime", modelId: "qwen3.5:4b", latencyMs: 10 } });

    await processRun("run-pdf");

    expect(getArtifactBoundedMock).toHaveBeenCalledWith(source.objectKey, expect.any(Number), expect.any(AbortSignal));
    expect(renderPdfPagesMock).toHaveBeenCalledWith(pdfBytes, expect.any(AbortSignal));
    expect(invokeModelMock).toHaveBeenCalledWith(expect.objectContaining({ images: [{ mimeType: "image/png", bytes: pageBytes }], prompt: expect.stringContaining("Rendered PDF pages supplied in order: 1 of 1") }));
    expect(extractArtifactMock).not.toHaveBeenCalled();
    expect(evidenceMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ facts: [] }) });
    const persistedCalls = JSON.stringify(runMessageMock.create.mock.calls);
    expect(persistedCalls).toContain('"mode":"rendered-pdf-pages"');
    expect(persistedCalls).toContain('"pageNumber":1');
  });

  it("requires Docling extraction for a non-vision document source", async () => {
    const run = {
      id: "run-document",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Summarize this PDF",
      taskCapability: "document",
      modelProfile: "local-general",
      modelReason: "persisted route",
      dataClassification: DataClassification.INTERNAL,
      sourceArtifactId: "10000000-0000-4000-8000-000000000003",
      status: RunStatus.PENDING,
    };
    const source = { id: run.sourceArtifactId, workspaceId: run.workspaceId, filename: "report.pdf", mimeType: "application/pdf", detectedMimeType: "application/pdf", objectKey: "workspace-1/report.pdf", sizeBytes: 100n, extractionStatus: "FAILED" };
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...run, status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    artifactMock.find.mockResolvedValue(source);
    extractArtifactMock.mockRejectedValue(new AppError(502, "Document extraction service is unavailable", "EXTRACTION_UNAVAILABLE"));
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({});
    runToolCallMock.update.mockResolvedValue({});
    runMessageMock.create.mockResolvedValue({});

    await expect(processRun(run.id)).rejects.toMatchObject({ code: "EXTRACTION_UNAVAILABLE" });

    expect(extractArtifactMock).toHaveBeenCalledWith(source.id, expect.any(AbortSignal));
    expect(renderPdfPagesMock).not.toHaveBeenCalled();
    expect(invokeModelMock).not.toHaveBeenCalled();
    expect(runToolCallMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ output: expect.objectContaining({ errorCode: "EXTRACTION_UNAVAILABLE" }) }),
    }));
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

  it("persists validated generated code before requesting exact sandbox approval", async () => {
    const run = {
      id: "run-code",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Write Python code that prints one",
      taskCapability: "code",
      modelProfile: "local-code",
      modelReason: "persisted route",
      dataClassification: DataClassification.CONFIDENTIAL,
      sourceArtifactId: null,
      status: RunStatus.PENDING,
    };
    const selectedProfile = {
      id: "local-code",
      providerId: "local-runtime",
      location: "local",
      baseUrl: "http://localhost:11434/v1",
      modelId: "qwen2.5-coder:7b",
      capabilities: ["code"],
      priority: 1000,
      enabled: true,
      sovereign: true,
      maxOutputTokens: 2048,
    };
    const generated = { language: "python", code: "print(1)", explanation: "Prints one." };
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...run, status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({ id: "20000000-0000-4000-8000-000000000001" });
    runToolCallMock.update.mockResolvedValue({});
    runMessageMock.create.mockResolvedValue({});
    evidenceMock.create.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
    artifactMock.create.mockResolvedValue({ id: "30000000-0000-4000-8000-000000000001", sizeBytes: 8 });
    toolApprovalMock.create.mockResolvedValue({ id: "40000000-0000-4000-8000-000000000001" });
    invokeModelMock
      .mockResolvedValueOnce({ profile: selectedProfile, response: { text: "```python\nprint(1)\n```" } })
      .mockResolvedValueOnce({ profile: selectedProfile, response: { text: JSON.stringify(generated) } });

    await expect(processRun(run.id)).resolves.toBeUndefined();

    expect(invokeModelMock).toHaveBeenCalledTimes(2);
    expect(invokeModelMock.mock.calls[1][0].prompt).toContain("Repair it once");
    expect(artifactMock.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: "CODE_OUTPUT",
      classification: DataClassification.CONFIDENTIAL,
      bytes: Buffer.from(generated.code),
    }));
    expect(toolApprovalMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      toolName: "sandbox.execute",
      toolInput: { language: generated.language, code: generated.code },
    }) });
    expect(runCodeMock).not.toHaveBeenCalled();
    const codeArtifactCall = artifactMock.create.mock.invocationCallOrder[0];
    const approvalCall = toolApprovalMock.create.mock.invocationCallOrder[0];
    expect(codeArtifactCall).toBeLessThan(approvalCall);
  });

  it("resumes with the persisted approved code and fails a non-zero sandbox result", async () => {
    const generated = { language: "javascript", code: "process.exit(7)", explanation: "Exercises failure handling." };
    const run = {
      id: "run-code-resume",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Write JavaScript failure handling code",
      taskCapability: "code",
      modelProfile: "local-code",
      modelReason: "persisted route",
      dataClassification: DataClassification.INTERNAL,
      sourceArtifactId: null,
      status: RunStatus.PENDING,
      state: { version: 1, phase: "ACTION", turn: 3, phaseStarted: true },
      maxTurns: 4,
      maxToolCalls: 5,
      deadlineAt: new Date(Date.now() + 60_000),
    };
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...run, status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    runToolCallMock.findUnique
      .mockResolvedValueOnce({ status: RunToolCallStatus.COMPLETED, output: { ok: true, summary: "generated", data: { characters: generated.code.length, analysis: generated.explanation, generatedCode: generated, modelProfile: "local-code" } } })
      .mockResolvedValueOnce({ status: RunToolCallStatus.COMPLETED, output: { ok: true, summary: "persisted", data: { artifactId: "30000000-0000-4000-8000-000000000001" } } })
      .mockResolvedValueOnce({ id: "20000000-0000-4000-8000-000000000001", modelToolCallId: "sandbox-call", status: RunToolCallStatus.WAITING_APPROVAL, input: { language: generated.language, code: generated.code } });
    runToolCallMock.updateMany.mockResolvedValue({ count: 1 });
    runToolCallMock.update.mockResolvedValue({});
    toolApprovalMock.findUnique.mockResolvedValue({ status: ApprovalStatus.APPROVED });
    evidenceMock.create.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
    runMessageMock.create.mockResolvedValue({});
    runCodeMock.mockResolvedValue({ stdout: "", stderr: "failed", exitCode: 7 });

    await expect(processRun(run.id)).rejects.toMatchObject({ code: "SANDBOX_NON_ZERO_EXIT" });

    expect(invokeModelMock).not.toHaveBeenCalled();
    expect(artifactMock.create).not.toHaveBeenCalled();
    expect(runCodeMock).toHaveBeenCalledWith(generated.code, generated.language, expect.any(AbortSignal));
    expect(runToolCallMock.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: RunToolCallStatus.FAILED,
        output: expect.objectContaining({ ok: false, errorCode: "SANDBOX_NON_ZERO_EXIT" }),
      }),
    }));
  });

  it("selects PPTX from task wording and persists a classified cited artifact", async () => {
    const sourceId = "10000000-0000-4000-8000-000000000001";
    const sourceEvidenceId = "20000000-0000-4000-8000-000000000001";
    const run = {
      id: "run-pptx",
      workspaceId: "workspace-1",
      requestedBy: "user-1",
      task: "Create a PowerPoint presentation from this report",
      taskCapability: "document",
      modelProfile: "local-general",
      modelReason: "persisted route",
      dataClassification: DataClassification.CONFIDENTIAL,
      sourceArtifactId: sourceId,
      status: RunStatus.PENDING,
    };
    const source = { id: sourceId, workspaceId: "workspace-1", filename: "report.txt", mimeType: "text/plain", detectedMimeType: "text/plain", objectKey: "workspace-1/report.txt", sizeBytes: 20n };
    const selectedProfile = { id: "local-general", providerId: "local-runtime", location: "local", baseUrl: "http://localhost:11434/v1", modelId: "qwen3.5:4b", capabilities: ["general", "document"], priority: 1000, enabled: true, sovereign: true, maxOutputTokens: 2048 };
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...run, status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    artifactMock.find.mockResolvedValue(source);
    extractArtifactMock.mockResolvedValue({ text: "Valve V-101 requires inspection.", metadata: {} });
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({});
    runToolCallMock.update.mockResolvedValue({});
    runMessageMock.create.mockResolvedValue({});
    evidenceMock.create
      .mockResolvedValueOnce({ id: sourceEvidenceId })
      .mockResolvedValueOnce({ id: "30000000-0000-4000-8000-000000000001" });
    invokeModelMock.mockResolvedValue({ profile: selectedProfile, response: { text: "Inspect valve V-101." } });
    generatePptxMock.mockResolvedValue(Buffer.from("pptx"));
    artifactMock.create.mockResolvedValue({ id: "40000000-0000-4000-8000-000000000001", sizeBytes: 4 });

    await processRun(run.id);

    expect(generatePptxMock).toHaveBeenCalledWith(expect.objectContaining({
      citations: [expect.objectContaining({ source: `artifact:${sourceId}` })],
      sections: [expect.objectContaining({ findings: [expect.objectContaining({ citationIds: ["S1"] })] })],
    }));
    expect(generateXlsxMock).not.toHaveBeenCalled();
    expect(artifactMock.create).toHaveBeenCalledWith(expect.objectContaining({
      filename: "presentation-run-pptx.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      classification: DataClassification.CONFIDENTIAL,
      idempotencyKey: "run-run-pptx-pptx",
    }));
  });

  it("enforces the snapshotted tool-call limit before creating another call", async () => {
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.count.mockResolvedValue(5);

    await expect(executeRunTool("run-1", "artifact.read", {
      artifactId: "10000000-0000-4000-8000-000000000001",
      extractionVersion: "canonical-v1",
    }, vi.fn(), undefined, { workspaceId: "workspace-1", leaseId: "lease-1", maxToolCalls: 5 })).rejects.toMatchObject({ code: "RUN_TOOL_CALL_LIMIT_EXCEEDED" });

    expect(runToolCallMock.create).not.toHaveBeenCalled();
  });
});
