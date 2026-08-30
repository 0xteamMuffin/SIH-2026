import {
  ArtifactExtractionStatus,
  ArtifactKind,
  ArtifactLifecycleStatus,
  DataClassification,
  KnowledgeIndexStatus,
  KnowledgeJobStatus,
  KnowledgeSourceIndexStatus,
  KnowledgeSourceStatus,
  KnowledgeVisibility,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, transactionMock } = vi.hoisted(() => {
  const mocks = {
    artifact: { findFirst: vi.fn() },
    knowledgeIndex: { findFirst: vi.fn() },
    knowledgeSource: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    knowledgeSourceIndex: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    knowledgeJob: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    knowledgeQuery: { create: vi.fn(), findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    outboxEvent: { create: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return { mocks, transactionMock: vi.fn() };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { ...mocks, $transaction: transactionMock },
}));

import {
  createKnowledgeQuery,
  createKnowledgeSource,
  deleteKnowledgeSource,
  getKnowledgeQuery,
  getKnowledgeSource,
  listKnowledgeSources,
  reindexKnowledgeSource,
  requestKnowledgeIndexRebuild,
} from "../src/modules/knowledge/knowledge.service.js";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const artifactId = "10000000-0000-4000-8000-000000000001";
const sourceId = "40000000-0000-4000-8000-000000000001";
const indexId = "50000000-0000-4000-8000-000000000001";
const userId = "30000000-0000-4000-8000-000000000001";
const actor = { id: userId, role: "OPERATOR" as const };
const artifact = {
  id: artifactId,
  workspaceId,
  createdBy: userId,
  kind: ArtifactKind.SOURCE,
  classification: DataClassification.INTERNAL,
  extractionStatus: ArtifactExtractionStatus.COMPLETED,
  lifecycleStatus: ArtifactLifecycleStatus.ACTIVE,
  filename: "manual.pdf",
  mimeType: "application/pdf",
  detectedMimeType: "application/pdf",
  sizeBytes: 9007199254740993n,
  createdAt: new Date("2026-08-30T12:00:00.000Z"),
};
const index = {
  id: indexId,
  revision: 3,
  status: KnowledgeIndexStatus.ACTIVE,
  createdAt: new Date("2026-08-30T12:00:00.000Z"),
};

describe("knowledge service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((work) => work(mocks));
    mocks.artifact.findFirst.mockResolvedValue(artifact);
    mocks.knowledgeIndex.findFirst.mockResolvedValue(index);
    mocks.knowledgeSource.findUnique.mockResolvedValue(null);
    mocks.workspace.findUnique.mockResolvedValue({ id: workspaceId });
  });

  it("creates a source, index link, job, and exact outbox message atomically", async () => {
    mocks.knowledgeSource.create.mockImplementation(async ({ data }) => ({ ...data, revision: 1, status: KnowledgeSourceStatus.ACTIVE }));
    mocks.knowledgeSourceIndex.create.mockImplementation(async ({ data }) => ({ ...data, status: KnowledgeSourceIndexStatus.PENDING }));
    mocks.knowledgeJob.create.mockImplementation(async ({ data }) => ({ ...data, status: KnowledgeJobStatus.QUEUED }));
    mocks.outboxEvent.create.mockResolvedValue({ id: "event-1" });

    const result = await createKnowledgeSource({ workspaceId, artifactId, actor, visibility: KnowledgeVisibility.WORKSPACE_PRIVATE });

    expect(transactionMock).toHaveBeenCalledOnce();
    expect(mocks.artifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: artifactId, workspaceId } }));
    expect(mocks.knowledgeIndex.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { status: KnowledgeIndexStatus.ACTIVE } }));
    expect(mocks.knowledgeSourceIndex.create).toHaveBeenCalledWith({ data: expect.objectContaining({ indexId, sourceRevision: 1, indexRevision: 3 }) });
    expect(mocks.knowledgeJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "INDEX_SOURCE", indexId, sourceIndexId: expect.any(String) }) });
    const jobId = mocks.knowledgeJob.create.mock.calls[0][0].data.id;
    expect(mocks.outboxEvent.create).toHaveBeenCalledWith({ data: { topic: "knowledge.job.requested", aggregateId: jobId, payload: { jobId } } });
    expect(result.knowledgeSource.artifact).toMatchObject({ id: artifactId, sizeBytes: "9007199254740993" });
  });

  it("rejects an artifact until source extraction is complete", async () => {
    mocks.artifact.findFirst.mockResolvedValue({ ...artifact, extractionStatus: ArtifactExtractionStatus.PROCESSING });

    await expect(createKnowledgeSource({ workspaceId, artifactId, actor, visibility: KnowledgeVisibility.WORKSPACE_PRIVATE }))
      .rejects.toMatchObject({ status: 409, code: "ARTIFACT_NOT_READY" });

    expect(mocks.knowledgeSource.create).not.toHaveBeenCalled();
    expect(mocks.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("allows only administrators to create organization-shared sources", async () => {
    await expect(createKnowledgeSource({ workspaceId, artifactId, actor, visibility: KnowledgeVisibility.ORGANIZATION_SHARED }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("lists workspace-private and organization-shared sources with exact BigInt strings", async () => {
    const source = { id: sourceId, workspaceId, visibility: KnowledgeVisibility.WORKSPACE_PRIVATE, status: KnowledgeSourceStatus.ACTIVE, createdAt: artifact.createdAt, artifact, sourceIndexes: [] };
    mocks.knowledgeSource.findMany.mockResolvedValue([source, { ...source, id: "40000000-0000-4000-8000-000000000002" }]);

    const result = await listKnowledgeSources({ workspaceId, limit: 1 });

    expect(mocks.knowledgeSource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ workspaceId }, { visibility: KnowledgeVisibility.ORGANIZATION_SHARED }],
        status: { in: [KnowledgeSourceStatus.ACTIVE, KnowledgeSourceStatus.ARCHIVED] },
      }),
      take: 2,
    }));
    expect(result.knowledgeSources[0]).toMatchObject({ artifact: { sizeBytes: "9007199254740993" } });
    expect(result.nextCursor).not.toBeNull();
  });

  it("scopes source and query reads to current workspace membership", async () => {
    mocks.knowledgeSource.findFirst.mockResolvedValue(null);
    mocks.knowledgeQuery.findFirst.mockResolvedValue(null);

    await getKnowledgeSource(sourceId, actor);
    await getKnowledgeQuery("60000000-0000-4000-8000-000000000001", actor);

    expect(mocks.knowledgeSource.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: sourceId, status: { in: [KnowledgeSourceStatus.ACTIVE, KnowledgeSourceStatus.ARCHIVED] }, OR: expect.arrayContaining([{ visibility: KnowledgeVisibility.ORGANIZATION_SHARED }]) }),
    }));
    expect(mocks.knowledgeQuery.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "60000000-0000-4000-8000-000000000001", workspace: { members: { some: { userId } } } },
    }));
  });

  it("hides a source immediately and creates a durable removal job", async () => {
    const sourceIndexId = "70000000-0000-4000-8000-000000000001";
    mocks.knowledgeSource.findFirst.mockResolvedValue({
      id: sourceId,
      workspaceId,
      status: KnowledgeSourceStatus.ACTIVE,
      artifact,
      sourceIndexes: [{
        id: sourceIndexId,
        sourceId,
        indexId,
        status: KnowledgeSourceIndexStatus.READY,
        leaseExpiresAt: null,
        index,
        jobs: [],
      }],
    });
    mocks.knowledgeSource.update.mockResolvedValue({});
    mocks.knowledgeSourceIndex.update.mockResolvedValue({});
    mocks.knowledgeJob.updateMany.mockResolvedValue({ count: 0 });
    mocks.knowledgeJob.create.mockImplementation(async ({ data }) => ({ ...data, status: KnowledgeJobStatus.QUEUED }));

    const result = await deleteKnowledgeSource(sourceId, { id: userId, role: "ADMIN" }, new Date("2026-08-30T12:00:00.000Z"));

    expect(result.knowledgeSource.status).toBe(KnowledgeSourceStatus.DELETING);
    expect(mocks.knowledgeSource.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: KnowledgeSourceStatus.DELETING }) }));
    expect(mocks.knowledgeSourceIndex.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: KnowledgeSourceIndexStatus.REMOVING }) }));
    expect(mocks.knowledgeJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "REMOVE_SOURCE", sourceIndexId }) });
    const removalJobId = mocks.knowledgeJob.create.mock.calls[0][0].data.id;
    expect(mocks.outboxEvent.create).toHaveBeenCalledWith({ data: { topic: "knowledge.job.requested", aggregateId: removalJobId, payload: { jobId: removalJobId } } });
  });

  it("requires workspace ADMIN membership for source deletion", async () => {
    mocks.knowledgeSource.findFirst.mockResolvedValue(null);

    await expect(deleteKnowledgeSource(sourceId, actor)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    expect(mocks.knowledgeSource.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: sourceId, workspace: { members: { some: { userId, role: "ADMIN" } } } },
    }));
    expect(mocks.knowledgeJob.create).not.toHaveBeenCalled();
  });

  it("reuses an in-progress removal job on repeated deletion", async () => {
    const removalJob = {
      id: "80000000-0000-4000-8000-000000000001",
      status: KnowledgeJobStatus.QUEUED,
      type: "REMOVE_SOURCE",
    };
    mocks.knowledgeSource.findFirst.mockResolvedValue({
      id: sourceId,
      workspaceId,
      status: KnowledgeSourceStatus.DELETING,
      artifact,
      sourceIndexes: [{
        id: "70000000-0000-4000-8000-000000000001",
        sourceId,
        indexId,
        status: KnowledgeSourceIndexStatus.REMOVING,
        leaseExpiresAt: null,
        index,
        jobs: [removalJob],
      }],
    });
    mocks.knowledgeSourceIndex.update.mockResolvedValue({});
    mocks.knowledgeJob.updateMany.mockResolvedValue({ count: 0 });

    const result = await deleteKnowledgeSource(sourceId, { id: userId, role: "ADMIN" });

    expect(result.jobs).toEqual([removalJob]);
    expect(mocks.knowledgeJob.create).not.toHaveBeenCalled();
    expect(mocks.auditEvent.create).not.toHaveBeenCalled();
    expect(mocks.outboxEvent.create).toHaveBeenCalledWith({ data: { topic: "knowledge.job.requested", aggregateId: removalJob.id, payload: { jobId: removalJob.id } } });
  });

  it("reindexes a failed source link with a new revision and job", async () => {
    const source = { id: sourceId, workspaceId, revision: 1, status: KnowledgeSourceStatus.ACTIVE, artifact };
    const sourceIndex = { id: "70000000-0000-4000-8000-000000000001", sourceId, indexId, status: KnowledgeSourceIndexStatus.FAILED };
    mocks.knowledgeSource.findFirst.mockResolvedValue(source);
    mocks.knowledgeSourceIndex.findUnique.mockResolvedValue(sourceIndex);
    mocks.knowledgeJob.findFirst.mockResolvedValue(null);
    mocks.knowledgeSource.update.mockResolvedValue({ ...source, revision: 2 });
    mocks.knowledgeSourceIndex.update.mockResolvedValue({ ...sourceIndex, sourceRevision: 2, indexRevision: 3, status: KnowledgeSourceIndexStatus.PENDING });
    mocks.knowledgeJob.create.mockImplementation(async ({ data }) => ({ ...data, status: KnowledgeJobStatus.QUEUED }));

    await reindexKnowledgeSource(sourceId, actor);

    expect(mocks.knowledgeSource.update).toHaveBeenCalledWith({ where: { id: sourceId }, data: { revision: { increment: 1 } } });
    expect(mocks.knowledgeSourceIndex.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sourceRevision: 2, status: KnowledgeSourceIndexStatus.PENDING }) }));
    const jobId = mocks.knowledgeJob.create.mock.calls[0][0].data.id;
    expect(mocks.outboxEvent.create).toHaveBeenCalledWith({ data: { topic: "knowledge.job.requested", aggregateId: jobId, payload: { jobId } } });
  });

  it("does not queue a duplicate reindex while indexing is pending", async () => {
    mocks.knowledgeSource.findFirst.mockResolvedValue({ id: sourceId, workspaceId, status: KnowledgeSourceStatus.ACTIVE, artifact });
    mocks.knowledgeSourceIndex.findUnique.mockResolvedValue({ id: "source-index-1", status: KnowledgeSourceIndexStatus.PENDING });

    await expect(reindexKnowledgeSource(sourceId, actor)).rejects.toMatchObject({ status: 409, code: "KNOWLEDGE_INDEXING_IN_PROGRESS" });

    expect(mocks.knowledgeJob.create).not.toHaveBeenCalled();
  });

  it("creates an asynchronous query and exact job outbox payload atomically", async () => {
    mocks.knowledgeQuery.create.mockImplementation(async ({ data }) => ({ ...data, status: "QUEUED" }));
    mocks.knowledgeJob.create.mockImplementation(async ({ data }) => ({ ...data, status: KnowledgeJobStatus.QUEUED }));

    const result = await createKnowledgeQuery({
      workspaceId,
      userId,
      queryText: "Where is valve V-101?",
      topK: 5,
      filters: { artifactIds: [artifactId] },
      dataClassification: DataClassification.CONFIDENTIAL,
    });

    expect(transactionMock).toHaveBeenCalledOnce();
    expect(mocks.knowledgeQuery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ indexId, indexRevision: 3, topK: 5, dataClassification: DataClassification.CONFIDENTIAL }) });
    expect(mocks.knowledgeJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "EXECUTE_QUERY", queryId: expect.any(String) }) });
    const jobId = mocks.knowledgeJob.create.mock.calls[0][0].data.id;
    expect(mocks.outboxEvent.create).toHaveBeenCalledWith({ data: { topic: "knowledge.job.requested", aggregateId: jobId, payload: { jobId } } });
    expect(result.knowledgeQuery).toMatchObject({ queryText: "Where is valve V-101?", status: "QUEUED" });
  });

  it("allows only a global administrator to queue an active-index rebuild", async () => {
    mocks.knowledgeJob.create.mockImplementation(async ({ data }) => ({ ...data, status: KnowledgeJobStatus.QUEUED }));

    await expect(requestKnowledgeIndexRebuild(actor)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const result = await requestKnowledgeIndexRebuild({ id: userId, role: "ADMIN" });

    expect(result.index).toMatchObject({ id: indexId });
    expect(mocks.knowledgeJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ indexId, type: "REBUILD_INDEX" }) });
  });
});
