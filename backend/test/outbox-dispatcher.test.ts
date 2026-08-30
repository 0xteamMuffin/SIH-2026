import type { OutboxEvent } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { dispatchOutboxBatch } from "../src/infrastructure/queue/outbox-dispatcher.js";

const event = (overrides: Partial<OutboxEvent> = {}): OutboxEvent => ({
  id: "4f755e1b-3cc5-47ed-8305-cdf9875ac399",
  topic: "agent.run.requested",
  aggregateId: "a8aa8f67-39f9-4491-813b-20e81f4bda13",
  payload: { runId: "a8aa8f67-39f9-4491-813b-20e81f4bda13" },
  attempts: 0,
  availableAt: new Date("2026-08-30T12:00:00Z"),
  publishedAt: null,
  lastError: null,
  createdAt: new Date("2026-08-30T12:00:00Z"),
  ...overrides,
});

describe("outbox dispatcher", () => {
  it("marks an event only after confirmed publication", async () => {
    const row = event();
    const store = { outboxEvent: { findMany: vi.fn().mockResolvedValue([row]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    const publish = vi.fn().mockResolvedValue(undefined);

    await expect(dispatchOutboxBatch(store as never, publish, new Date("2026-08-30T12:00:01Z"))).resolves.toEqual({ selected: 1, published: 1 });

    expect(publish).toHaveBeenCalledWith(row);
    expect(store.outboxEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: row.id, publishedAt: null },
      data: expect.objectContaining({ publishedAt: expect.any(Date), lastError: null }),
    }));
    expect(store.outboxEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ topic: { in: expect.arrayContaining(["agent.run.requested", "agent.run.resumed", "knowledge.job.requested", "artifact.deletion.requested"]) } }),
    }));
  });

  it("selects knowledge job outbox events without changing their payload", async () => {
    const row = event({
      topic: "knowledge.job.requested",
      aggregateId: "f06544e7-6922-4e7c-a025-3f98e934e56f",
      payload: { jobId: "f06544e7-6922-4e7c-a025-3f98e934e56f" },
    });
    const store = { outboxEvent: { findMany: vi.fn().mockResolvedValue([row]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    const publish = vi.fn().mockResolvedValue(undefined);

    await dispatchOutboxBatch(store as never, publish, new Date("2026-08-30T12:00:01Z"));

    expect(publish).toHaveBeenCalledWith(row);
  });

  it("retains failed events and schedules exponential backoff", async () => {
    const now = new Date("2026-08-30T12:00:01Z");
    const row = event({ attempts: 2 });
    const store = { outboxEvent: { findMany: vi.fn().mockResolvedValue([row]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };

    await expect(dispatchOutboxBatch(store as never, vi.fn().mockRejectedValue(new Error("broker unavailable")), now)).resolves.toEqual({ selected: 1, published: 0 });

    expect(store.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, publishedAt: null },
      data: { attempts: 3, availableAt: new Date(now.getTime() + 8_000), lastError: "broker unavailable" },
    });
  });
});
