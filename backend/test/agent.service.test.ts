import { ApprovalStatus, DataClassification, RunStatus, RunToolCallStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { artifactMock, auditMock, agentRunMock, evidenceMock, extractArtifactMock, getArtifactBoundedMock, invokeModelMock, outboxEventMock, runMessageMock, runToolCallMock, toolApprovalMock, transactionMock } = vi.hoisted(() => ({
  artifactMock: { create: vi.fn(), find: vi.fn() },
  auditMock: vi.fn(),
  agentRunMock: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  evidenceMock: { create: vi.fn(), findFirst: vi.fn() },
  extractArtifactMock: vi.fn(),
  getArtifactBoundedMock: vi.fn(),
  invokeModelMock: vi.fn(),
  outboxEventMock: { create: vi.fn() },
  runMessageMock: { create: vi.fn() },
  runToolCallMock: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  toolApprovalMock: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  transactionMock: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { agentRun: agentRunMock, evidence: evidenceMock, outboxEvent: outboxEventMock, runMessage: runMessageMock, runToolCall: runToolCallMock, toolApproval: toolApprovalMock, $transaction: transactionMock } }));
vi.mock("../src/lib/audit.js", () => ({ audit: auditMock }));
vi.mock("../src/infrastructure/models/model-orchestrator.js", () => ({ invokeModelWithFallbacks: invokeModelMock }));
vi.mock("../src/modules/artifacts/artifacts.service.js", () => ({ createArtifact: artifactMock.create, findArtifact: artifactMock.find, getArtifactBounded: getArtifactBoundedMock }));
vi.mock("../src/modules/artifacts/artifact-extraction.service.js", () => ({ extractArtifact: extractArtifactMock }));

import { cancelRun, createRun, executeRunTool, failRun, getRun, processRun } from "../src/modules/agent/agent.service.js";

describe("agent run access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((input) => Array.isArray(input)
      ? Promise.all(input)
      : input({ agentRun: agentRunMock, outboxEvent: outboxEventMock, runToolCall: runToolCallMock, toolApproval: toolApprovalMock }));
    runToolCallMock.count.mockResolvedValue(0);
    evidenceMock.findFirst.mockResolvedValue(null);
  });

  it("creates a run and queue outbox event atomically", async () => {
    const run = { id: "run-1", workspaceId: "workspace-1", status: RunStatus.PENDING };
    agentRunMock.create.mockResolvedValue(run);
    outboxEventMock.create.mockResolvedValue({ id: "event-1" });

    await expect(createRun({ workspaceId: "workspace-1", userId: "user-1", task: "Summarize the public report", dataClassification: DataClassification.PUBLIC })).resolves.toEqual(run);

    expect(transactionMock).toHaveBeenCalledOnce();
    expect(agentRunMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sourceArtifactId: undefined }) });
    expect(outboxEventMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ topic: "agent.run.requested", aggregateId: expect.any(String), payload: { runId: expect.any(String) } }) });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", eventType: "AGENT_RUN_CREATED" }));
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

  it("sends a bounded original image with extraction text without persisting its bytes", async () => {
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
    extractArtifactMock.mockResolvedValue({ text: "OCR: valve V-101 is open", metadata: { sourceMimeType: "image/png" } });
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
      prompt: expect.stringContaining("OCR: valve V-101 is open"),
      image: { mimeType: "image/png", bytes: imageBytes },
    }));
    const persistedCalls = JSON.stringify({ messages: runMessageMock.create.mock.calls, toolCreates: runToolCallMock.create.mock.calls, toolUpdates: runToolCallMock.update.mock.calls });
    expect(persistedCalls).not.toContain(imageBytes.toString("base64"));
    expect(persistedCalls).not.toContain('"bytes"');
    expect(persistedCalls).not.toContain('"type":"Buffer"');
    expect(persistedCalls).toContain('"mode":"original-image"');
  });

  it("uses extraction text for PDFs and records that rendered pages are unavailable", async () => {
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
    const source = { id: "10000000-0000-4000-8000-000000000002", workspaceId: "workspace-1", filename: "drawing.pdf", mimeType: "application/pdf", detectedMimeType: "application/pdf", objectKey: "workspace-1/drawing.pdf", sizeBytes: 100n };
    const selectedProfile = { id: "local-vision", providerId: "local-runtime", location: "local", baseUrl: "http://localhost:11434/v1", modelId: "qwen3.5:4b", capabilities: ["vision"], priority: 1000, enabled: true, sovereign: true, maxOutputTokens: 2048 };
    agentRunMock.findUnique.mockResolvedValue(run);
    agentRunMock.findUniqueOrThrow.mockResolvedValue({ ...run, status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    artifactMock.find.mockResolvedValue(source);
    extractArtifactMock.mockResolvedValue({ text: "Extracted PDF text", metadata: { sourceMimeType: "application/pdf" } });
    runToolCallMock.findUnique.mockResolvedValue(null);
    runToolCallMock.create.mockResolvedValue({});
    runToolCallMock.update.mockResolvedValue({});
    runMessageMock.create.mockResolvedValue({});
    evidenceMock.create.mockResolvedValue({ id: "evidence-1" });
    artifactMock.create.mockResolvedValue({ id: "50000000-0000-4000-8000-000000000002", sizeBytes: 1 });
    invokeModelMock.mockResolvedValue({ profile: selectedProfile, response: { text: "Text-only finding.", provider: "local-runtime", modelId: "qwen3.5:4b", latencyMs: 10 } });

    await processRun("run-pdf");

    expect(getArtifactBoundedMock).not.toHaveBeenCalled();
    expect(invokeModelMock).toHaveBeenCalledWith(expect.objectContaining({ image: undefined, prompt: expect.stringContaining("PDF page rendering is not implemented") }));
    const persistedCalls = JSON.stringify(runMessageMock.create.mock.calls);
    expect(persistedCalls).toContain('"mode":"extraction-text-only"');
    expect(persistedCalls).toContain('"renderedPages":[]');
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
    const waitingCall = { id: "tool-call-1", modelToolCallId: "model-call-1", status: RunToolCallStatus.WAITING_APPROVAL };
    runToolCallMock.findUnique.mockResolvedValue(waitingCall);
    runToolCallMock.updateMany.mockResolvedValue({ count: 1 });
    runToolCallMock.update.mockResolvedValue({});
    toolApprovalMock.findUnique.mockResolvedValue({ id: "approval-1", status: ApprovalStatus.APPROVED });
    const approvedWork = vi.fn().mockResolvedValue({ ok: true, summary: "executed", stdout: "2", stderr: "", exitCode: 0 });

    await expect(executeRunTool("run-1", "sandbox.execute", { language: "javascript", code: "1 + 1" }, approvedWork)).resolves.toMatchObject({ ok: true });
    expect(approvedWork).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    runToolCallMock.findUnique.mockResolvedValue(waitingCall);
    runToolCallMock.updateMany.mockResolvedValue({ count: 1 });
    toolApprovalMock.findUnique.mockResolvedValue({ id: "approval-1", status: ApprovalStatus.REJECTED });
    const rejectedWork = vi.fn();

    await expect(executeRunTool("run-1", "sandbox.execute", { language: "javascript", code: "1 + 1" }, rejectedWork)).resolves.toMatchObject({ ok: false, errorCode: "TOOL_APPROVAL_REJECTED" });
    expect(rejectedWork).not.toHaveBeenCalled();
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
