import { ArtifactDeletionJobStatus, ArtifactLifecycleStatus, KnowledgeSourceStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processArtifactDeletionJob, reconcileArtifactDeletions } from "../src/modules/artifacts/artifact-deletion.processor.js";

const jobId = "40000000-0000-4000-8000-000000000001";
const artifactId = "10000000-0000-4000-8000-000000000001";
const sourceId = "50000000-0000-4000-8000-000000000001";

function fixture(status = ArtifactDeletionJobStatus.QUEUED) {
  const models = {
    artifactDeletionJob: {
      findUnique: vi.fn().mockResolvedValue({
        id: jobId,
        artifactId,
        requestedBy: "30000000-0000-4000-8000-000000000001",
        status,
        attempts: 0,
        maxAttempts: 4,
        availableAt: new Date("2026-08-30T11:00:00.000Z"),
        artifact: {
          id: artifactId,
          workspaceId: "20000000-0000-4000-8000-000000000001",
          lifecycleStatus: ArtifactLifecycleStatus.DELETING,
          objectKey: "workspace/source.pdf",
          extractedObjectKey: "workspace/extractions/source.md",
          extractionProvenanceObjectKey: "workspace/extractions/source.provenance.v1.json",
          knowledgeSource: {
            id: sourceId,
            status: KnowledgeSourceStatus.ARCHIVED,
            sourceIndexes: [{ index: { collectionName: "knowledge_a" } }, { index: { collectionName: "knowledge_b" } }],
          },
        },
      }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(),
    },
    artifact: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    knowledgeSource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    knowledgeSourceIndex: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    auditEvent: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    outboxEvent: { create: vi.fn().mockResolvedValue({ id: "event-1" }) },
  };
  const db = {
    ...models,
    $transaction: vi.fn((work) => work(models)),
  };
  return { db, models };
}

describe("artifact deletion processor", () => {
  const deleteObject = vi.fn();
  const vectorStore = { deleteByKnowledgeSourceId: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    deleteObject.mockResolvedValue(undefined);
    vectorStore.deleteByKnowledgeSourceId.mockResolvedValue(undefined);
  });

  it("removes vectors and both objects before retaining terminal metadata", async () => {
    const { db, models } = fixture();

    await processArtifactDeletionJob(jobId, { db: db as never, deleteObject, vectorStore: vectorStore as never, now: () => new Date("2026-08-30T12:00:00.000Z"), randomUUID: () => "60000000-0000-4000-8000-000000000001" });

    expect(vectorStore.deleteByKnowledgeSourceId).toHaveBeenCalledTimes(2);
    expect(vectorStore.deleteByKnowledgeSourceId).toHaveBeenCalledWith({ collectionName: "knowledge_a", knowledgeSourceId: sourceId });
    expect(deleteObject.mock.calls.map(([key]) => key)).toEqual(["workspace/extractions/source.md", "workspace/extractions/source.provenance.v1.json", "workspace/source.pdf"]);
    expect(models.artifact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lifecycleStatus: ArtifactLifecycleStatus.DELETED }) }));
    expect(models.artifactDeletionJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: ArtifactDeletionJobStatus.SUCCEEDED }) }));
    expect(models.auditEvent.create).toHaveBeenCalledOnce();
  });

  it("ignores duplicate delivery after terminal completion", async () => {
    const { db } = fixture(ArtifactDeletionJobStatus.SUCCEEDED);

    await processArtifactDeletionJob(jobId, { db: db as never, deleteObject, vectorStore: vectorStore as never });

    expect(deleteObject).not.toHaveBeenCalled();
    expect(vectorStore.deleteByKnowledgeSourceId).not.toHaveBeenCalled();
  });

  it("returns a failed physical cleanup to queued state for retry", async () => {
    const { db, models } = fixture();
    deleteObject.mockRejectedValueOnce(new Error("MinIO unavailable"));

    await expect(processArtifactDeletionJob(jobId, { db: db as never, deleteObject, vectorStore: vectorStore as never })).rejects.toThrow("MinIO unavailable");

    expect(models.artifactDeletionJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: ArtifactDeletionJobStatus.QUEUED, lastError: "MinIO unavailable" }) }));
    expect(models.artifact.updateMany).not.toHaveBeenCalled();
  });

  it("requeues stale claims with a new identifier-only outbox event", async () => {
    const { db, models } = fixture();
    models.artifactDeletionJob.findMany.mockResolvedValueOnce([{ id: jobId }]).mockResolvedValueOnce([]);

    await expect(reconcileArtifactDeletions({ db: db as never, now: () => new Date("2026-08-30T12:00:00.000Z") })).resolves.toEqual({ recovered: 1, repaired: 1 });

    expect(models.outboxEvent.create).toHaveBeenCalledWith({ data: { topic: "artifact.deletion.requested", aggregateId: jobId, payload: { deletionJobId: jobId } } });
  });
});
