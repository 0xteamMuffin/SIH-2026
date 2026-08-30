import { DataClassification, RunStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, agentRunMock, outboxEventMock, transactionMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  agentRunMock: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  outboxEventMock: { create: vi.fn() },
  transactionMock: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { agentRun: agentRunMock, outboxEvent: outboxEventMock, $transaction: transactionMock } }));
vi.mock("../src/lib/audit.js", () => ({ audit: auditMock }));

import { cancelRun, createRun, getRun, processRun } from "../src/modules/agent/agent.service.js";

describe("agent run access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a run and queue outbox event atomically", async () => {
    const run = { id: "run-1", workspaceId: "workspace-1", status: RunStatus.PENDING };
    agentRunMock.create.mockResolvedValue(run);
    outboxEventMock.create.mockResolvedValue({ id: "event-1" });
    transactionMock.mockResolvedValue([run, { id: "event-1" }]);

    await expect(createRun({ workspaceId: "workspace-1", userId: "user-1", task: "Summarize the public report", dataClassification: DataClassification.PUBLIC })).resolves.toEqual(run);

    expect(transactionMock).toHaveBeenCalledOnce();
    expect(agentRunMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sourceArtifactId: undefined }) });
    expect(outboxEventMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ topic: "agent.run.requested", aggregateId: expect.any(String), payload: { runId: expect.any(String) } }) });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", eventType: "AGENT_RUN_CREATED" }));
  });

  it("treats a duplicate delivery for a terminal run as a no-op", async () => {
    agentRunMock.findUnique.mockResolvedValue({ id: "run-1", status: RunStatus.COMPLETED });

    await expect(processRun("run-1")).resolves.toBeUndefined();

    expect(agentRunMock.updateMany).not.toHaveBeenCalled();
  });

  it("scopes operator reads to workspace membership", async () => {
    agentRunMock.findFirst.mockResolvedValue({ id: "run-1" });

    await getRun("run-1", { id: "user-1", role: "OPERATOR" });

    expect(agentRunMock.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1", workspace: { members: { some: { userId: "user-1" } } } },
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
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ actorId: "user-1", eventType: "AGENT_RUN_CANCELLED" }));
  });

  it("rejects cancellation after another transition wins", async () => {
    agentRunMock.findFirst.mockResolvedValue({ id: "run-1", status: RunStatus.RUNNING });
    agentRunMock.updateMany.mockResolvedValue({ count: 0 });

    await expect(cancelRun("run-1", { id: "user-1", role: "OPERATOR" })).rejects.toMatchObject({ status: 409, code: "RUN_NOT_ACTIVE" });
    expect(auditMock).not.toHaveBeenCalled();
  });
});
