import { RunStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { recoverStaleRuns } from "../src/infrastructure/queue/run-recovery.js";

describe("stale agent run recovery", () => {
  it("atomically returns an expired run to pending and creates a recovery event", async () => {
    const runId = "a8aa8f67-39f9-4491-813b-20e81f4bda13";
    const agentRun = {
      findMany: vi.fn().mockResolvedValue([{ id: runId }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const outboxEvent = { create: vi.fn().mockResolvedValue({ id: "event-1" }) };
    const store = {
      agentRun,
      $transaction: vi.fn((work) => work({ agentRun, outboxEvent })),
    };
    const now = new Date("2026-08-30T12:00:00Z");

    await expect(recoverStaleRuns(store as never, now)).resolves.toEqual({ selected: 1, recovered: 1 });

    expect(agentRun.updateMany).toHaveBeenCalledWith({
      where: { id: runId, status: RunStatus.RUNNING, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      data: { status: RunStatus.PENDING, startedAt: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null },
    });
    expect(outboxEvent.create).toHaveBeenCalledWith({ data: { topic: "agent.run.recovered", aggregateId: runId, payload: { runId } } });
  });

  it("does not enqueue recovery when another transition wins", async () => {
    const runId = "a8aa8f67-39f9-4491-813b-20e81f4bda13";
    const agentRun = { findMany: vi.fn().mockResolvedValue([{ id: runId }]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) };
    const outboxEvent = { create: vi.fn() };
    const store = { agentRun, $transaction: vi.fn((work) => work({ agentRun, outboxEvent })) };

    await expect(recoverStaleRuns(store as never)).resolves.toEqual({ selected: 1, recovered: 0 });
    expect(outboxEvent.create).not.toHaveBeenCalled();
  });
});
