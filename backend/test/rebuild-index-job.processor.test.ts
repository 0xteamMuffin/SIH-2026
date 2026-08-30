import { KnowledgeIndexStatus, KnowledgeJobStatus, KnowledgeJobType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { processRebuildIndexJob } from "../src/modules/knowledge/rebuild-index-job.processor.js";

describe("knowledge index rebuild processor", () => {
  it("fans out durable indexing jobs for active sources and completes", async () => {
    const coordinatorId = "10000000-0000-4000-8000-000000000001";
    const indexId = "20000000-0000-4000-8000-000000000001";
    const sourceId = "30000000-0000-4000-8000-000000000001";
    const workspaceId = "40000000-0000-4000-8000-000000000001";
    const ids = [
      "50000000-0000-4000-8000-000000000001",
      "60000000-0000-4000-8000-000000000001",
      "70000000-0000-4000-8000-000000000001",
    ];
    const coordinator = {
      id: coordinatorId,
      indexId,
      index: { id: indexId, revision: 2, status: KnowledgeIndexStatus.ACTIVE },
      type: KnowledgeJobType.REBUILD_INDEX,
      status: KnowledgeJobStatus.QUEUED,
      attempts: 0,
      maxAttempts: 3,
      availableAt: new Date(0),
      startedAt: null,
    };
    const knowledgeJob = {
      findUnique: vi.fn().mockImplementation(({ where }) => where.id ? coordinator : null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...data, status: KnowledgeJobStatus.QUEUED })),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const knowledgeSource = {
      findMany: vi.fn().mockResolvedValueOnce([{ id: sourceId }]).mockResolvedValueOnce([]),
      findFirst: vi.fn().mockResolvedValue({ id: sourceId, workspaceId, revision: 4 }),
    };
    const knowledgeSourceIndex = {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => data),
      update: vi.fn(),
    };
    const outboxEvent = { create: vi.fn().mockResolvedValue({}) };
    const transaction = { knowledgeJob, knowledgeSource, knowledgeSourceIndex, outboxEvent };
    const db = { ...transaction, $transaction: vi.fn().mockImplementation((work) => work(transaction)) };
    let nextId = 0;

    await processRebuildIndexJob(coordinatorId, {
      db: db as never,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      randomUUID: () => ids[nextId++]!,
      leaseDurationMs: 60_000,
    });

    expect(knowledgeSourceIndex.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sourceId, indexId, sourceRevision: 4, indexRevision: 2 }) });
    expect(knowledgeJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: KnowledgeJobType.INDEX_SOURCE, workspaceId, indexId }) });
    const childJobId = knowledgeJob.create.mock.calls[0][0].data.id;
    expect(outboxEvent.create).toHaveBeenCalledWith({ data: { topic: "knowledge.job.requested", aggregateId: childJobId, payload: { jobId: childJobId } } });
    expect(knowledgeJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: KnowledgeJobStatus.SUCCEEDED }) }));
  });
});
