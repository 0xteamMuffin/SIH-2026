import { DataClassification, RunStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, agentRunMock, evidenceMock, invokeModelMock, outboxEventMock, runMessageMock, runToolCallMock, transactionMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  agentRunMock: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  evidenceMock: { create: vi.fn() },
  invokeModelMock: vi.fn(),
  outboxEventMock: { create: vi.fn() },
  runMessageMock: { create: vi.fn() },
  runToolCallMock: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  transactionMock: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { agentRun: agentRunMock, evidence: evidenceMock, outboxEvent: outboxEventMock, runMessage: runMessageMock, runToolCall: runToolCallMock, $transaction: transactionMock } }));
vi.mock("../src/lib/audit.js", () => ({ audit: auditMock }));
vi.mock("../src/infrastructure/models/model-orchestrator.js", () => ({ invokeModelWithFallbacks: invokeModelMock }));

import { cancelRun, createRun, executeRunTool, failRun, getRun, processRun } from "../src/modules/agent/agent.service.js";

describe("agent run access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((input) => Array.isArray(input)
      ? Promise.all(input)
      : input({ agentRun: agentRunMock, outboxEvent: outboxEventMock }));
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
      where: { id: "run-1", status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } },
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
});
