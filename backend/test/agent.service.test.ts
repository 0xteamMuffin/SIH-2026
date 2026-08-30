import { RunStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, agentRunMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  agentRunMock: {
    findFirst: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { agentRun: agentRunMock } }));
vi.mock("../src/lib/audit.js", () => ({ audit: auditMock }));

import { cancelRun, getRun } from "../src/modules/agent/agent.service.js";

describe("agent run access", () => {
  beforeEach(() => vi.clearAllMocks());

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
