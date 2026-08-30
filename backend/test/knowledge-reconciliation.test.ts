import { KnowledgeJobStatus, KnowledgeJobType, KnowledgeSourceIndexStatus, KnowledgeSourceStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { reconcileKnowledgeLifecycle } from "../src/modules/knowledge/knowledge-reconciliation.js";

describe("knowledge reconciliation", () => {
  it("recovers an expired indexing claim and emits a fresh outbox event", async () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const job = {
      id: "10000000-0000-4000-8000-000000000001",
      type: KnowledgeJobType.INDEX_SOURCE,
      attempts: 1,
      maxAttempts: 3,
      leaseId: "20000000-0000-4000-8000-000000000001",
      sourceIndexId: "30000000-0000-4000-8000-000000000001",
      queryId: null,
      sourceIndex: { source: { status: KnowledgeSourceStatus.ACTIVE } },
    };
    const knowledgeJob = {
      findMany: vi.fn().mockResolvedValueOnce([job]).mockResolvedValueOnce([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const knowledgeSourceIndex = {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    };
    const knowledgeSource = { findMany: vi.fn().mockResolvedValue([]) };
    const knowledgeIndex = { findFirst: vi.fn().mockResolvedValue({ id: "40000000-0000-4000-8000-000000000001", revision: 1, collectionName: "knowledge_current" }) };
    const outboxEvent = { create: vi.fn().mockResolvedValue({}) };
    const transaction = { knowledgeJob, knowledgeSourceIndex, knowledgeSource, knowledgeIndex, outboxEvent };
    const db = { ...transaction, $transaction: vi.fn().mockImplementation((work) => work(transaction)) };
    const vectorStore = {
      countPoints: vi.fn(),
      scrollPoints: vi.fn().mockResolvedValue({ points: [] }),
      deleteByKnowledgeSourceId: vi.fn(),
    };

    const result = await reconcileKnowledgeLifecycle({ db: db as never, vectorStore, now: () => now, staleAfterMs: 30_000 });

    expect(result.recoveredJobs).toBe(1);
    expect(knowledgeJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: job.id, status: KnowledgeJobStatus.RUNNING, leaseId: job.leaseId }),
      data: expect.objectContaining({ status: KnowledgeJobStatus.QUEUED, leaseId: null }),
    }));
    expect(knowledgeSourceIndex.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: job.sourceIndexId, status: KnowledgeSourceIndexStatus.INDEXING, leaseId: job.leaseId },
      data: expect.objectContaining({ status: KnowledgeSourceIndexStatus.PENDING }),
    }));
    expect(outboxEvent.create).toHaveBeenCalledWith({ data: { topic: "knowledge.job.requested", aggregateId: job.id, payload: { jobId: job.id } } });
  });

  it("removes only points whose source is provably absent", async () => {
    const orphanId = "50000000-0000-4000-8000-000000000001";
    const activeId = "60000000-0000-4000-8000-000000000001";
    const knowledgeJob = { findMany: vi.fn().mockResolvedValue([]) };
    const knowledgeSourceIndex = { findMany: vi.fn().mockResolvedValue([]) };
    const knowledgeSource = {
      findMany: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: activeId, status: KnowledgeSourceStatus.ACTIVE }]),
    };
    const knowledgeIndex = { findFirst: vi.fn().mockResolvedValue({ id: "40000000-0000-4000-8000-000000000001", revision: 1, collectionName: "knowledge_current" }) };
    const db = { knowledgeJob, knowledgeSourceIndex, knowledgeSource, knowledgeIndex, $transaction: vi.fn() };
    const vectorStore = {
      countPoints: vi.fn(),
      scrollPoints: vi.fn().mockResolvedValue({
        points: [{ id: 1, payload: { knowledge_source_id: orphanId } }, { id: 2, payload: { knowledge_source_id: activeId } }],
      }),
      deleteByKnowledgeSourceId: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reconcileKnowledgeLifecycle({ db: db as never, vectorStore });

    expect(result.orphanSourcesRemoved).toBe(1);
    expect(vectorStore.deleteByKnowledgeSourceId).toHaveBeenCalledOnce();
    expect(vectorStore.deleteByKnowledgeSourceId).toHaveBeenCalledWith({ collectionName: "knowledge_current", knowledgeSourceId: orphanId });
  });
});
