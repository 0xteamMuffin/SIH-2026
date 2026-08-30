import { KnowledgeJobStatus, KnowledgeJobType, KnowledgeSourceIndexStatus, KnowledgeSourceStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { processRemoveSourceJob } from "../src/modules/knowledge/remove-source-job.processor.js";

const jobId = "10000000-0000-4000-8000-000000000001";
const sourceIndexId = "20000000-0000-4000-8000-000000000001";
const sourceId = "30000000-0000-4000-8000-000000000001";
const leaseId = "40000000-0000-4000-8000-000000000001";

function harness(status = KnowledgeJobStatus.QUEUED) {
  const job = {
    id: jobId,
    type: KnowledgeJobType.REMOVE_SOURCE,
    status,
    attempts: 0,
    maxAttempts: 3,
    availableAt: new Date(0),
    startedAt: null,
    indexId: "50000000-0000-4000-8000-000000000001",
    index: { collectionName: "knowledge_current" },
    sourceIndexId,
    sourceIndex: {
      id: sourceIndexId,
      sourceId,
      indexId: "50000000-0000-4000-8000-000000000001",
      status: KnowledgeSourceIndexStatus.REMOVING,
      source: { id: sourceId, status: KnowledgeSourceStatus.DELETING },
    },
  };
  const knowledgeJob = { findUnique: vi.fn().mockResolvedValue(job), updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
  const knowledgeSourceIndex = { updateMany: vi.fn().mockResolvedValue({ count: 1 }), count: vi.fn().mockResolvedValue(0) };
  const knowledgeSource = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
  const transaction = { knowledgeJob, knowledgeSourceIndex, knowledgeSource };
  const db = { ...transaction, $transaction: vi.fn().mockImplementation((work) => work(transaction)) };
  const vectorStore = { deleteByKnowledgeSourceId: vi.fn().mockResolvedValue(undefined) };
  return { db, knowledgeJob, knowledgeSourceIndex, knowledgeSource, vectorStore };
}

describe("knowledge source removal processor", () => {
  it("deletes Qdrant points and reaches terminal source lifecycle state", async () => {
    const test = harness();

    await processRemoveSourceJob(jobId, {
      db: test.db as never,
      vectorStore: test.vectorStore,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      randomUUID: () => leaseId,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 30_000,
    });

    expect(test.vectorStore.deleteByKnowledgeSourceId).toHaveBeenCalledWith({ collectionName: "knowledge_current", knowledgeSourceId: sourceId });
    expect(test.knowledgeSourceIndex.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: sourceIndexId, status: KnowledgeSourceIndexStatus.REMOVING, leaseId },
      data: expect.objectContaining({ status: KnowledgeSourceIndexStatus.REMOVED, chunkCount: 0 }),
    }));
    expect(test.knowledgeJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: KnowledgeJobStatus.SUCCEEDED }) }));
    expect(test.knowledgeSource.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: KnowledgeSourceStatus.DELETED }) }));
  });

  it("ignores a duplicate delivery after the job is terminal", async () => {
    const test = harness(KnowledgeJobStatus.SUCCEEDED);

    await processRemoveSourceJob(jobId, { db: test.db as never, vectorStore: test.vectorStore });

    expect(test.vectorStore.deleteByKnowledgeSourceId).not.toHaveBeenCalled();
    expect(test.knowledgeJob.updateMany).not.toHaveBeenCalled();
  });
});
