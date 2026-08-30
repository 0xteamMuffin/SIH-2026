import { ArtifactDeletionJobStatus, ArtifactExtractionStatus, ArtifactKind, ArtifactLifecycleStatus, KnowledgeSourceStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { agentRunMock, artifactDeletionJobMock, artifactMock, auditEventMock, deleteObjectMock, outboxEventMock, putArtifactMock, transactionMock } = vi.hoisted(() => ({
  agentRunMock: { count: vi.fn() },
  artifactDeletionJobMock: { create: vi.fn(), update: vi.fn() },
  artifactMock: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
  auditEventMock: { create: vi.fn() },
  deleteObjectMock: vi.fn(),
  outboxEventMock: { create: vi.fn() },
  putArtifactMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { artifact: artifactMock, $transaction: transactionMock } }));
vi.mock("../src/infrastructure/storage/artifact-store.js", () => ({ deleteObject: deleteObjectMock, getArtifact: vi.fn(), getArtifactBounded: vi.fn(), putArtifact: putArtifactMock }));

import { createArtifact, getArtifactMetadata, listArtifacts, requestArtifactDeletion } from "../src/modules/artifacts/artifacts.service.js";

const firstArtifact = {
  id: "10000000-0000-4000-8000-000000000002",
  workspaceId: "20000000-0000-4000-8000-000000000001",
  createdBy: "30000000-0000-4000-8000-000000000001",
  kind: ArtifactKind.SOURCE,
  classification: "INTERNAL",
  sha256: "abc",
  detectedMimeType: "application/pdf",
  extractionStatus: ArtifactExtractionStatus.COMPLETED,
  extractionMetadata: { pages: 2 },
  extractionError: null,
  extractionStartedAt: new Date("2026-08-30T11:59:00.000Z"),
  extractedAt: new Date("2026-08-30T12:00:00.000Z"),
  filename: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 9007199254740993n,
  lifecycleStatus: ArtifactLifecycleStatus.ACTIVE,
  retentionUntil: null,
  deletionJob: null,
  knowledgeSource: null,
  createdAt: new Date("2026-08-30T12:00:00.000Z"),
};

describe("artifact service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((work) => work({ artifact: artifactMock, agentRun: agentRunMock, artifactDeletionJob: artifactDeletionJobMock, outboxEvent: outboxEventMock, auditEvent: auditEventMock }));
    agentRunMock.count.mockResolvedValue(0);
    artifactMock.updateMany.mockResolvedValue({ count: 1 });
    putArtifactMock.mockResolvedValue(undefined);
    deleteObjectMock.mockResolvedValue(undefined);
  });

  it("lists a filtered workspace page and returns an exact BigInt string and stable cursor", async () => {
    const secondArtifact = { ...firstArtifact, id: "10000000-0000-4000-8000-000000000001", createdAt: new Date("2026-08-30T11:00:00.000Z") };
    artifactMock.findMany.mockResolvedValue([firstArtifact, secondArtifact]);

    const result = await listArtifacts({
      workspaceId: firstArtifact.workspaceId,
      limit: 1,
      kind: ArtifactKind.SOURCE,
      extractionStatus: ArtifactExtractionStatus.COMPLETED,
    });

    expect(artifactMock.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: firstArtifact.workspaceId, kind: ArtifactKind.SOURCE, extractionStatus: ArtifactExtractionStatus.COMPLETED }),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
    }));
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ id: firstArtifact.id, sizeBytes: "9007199254740993" });
    expect(JSON.parse(Buffer.from(result.nextCursor!, "base64url").toString("utf8"))).toEqual({ createdAt: firstArtifact.createdAt.toISOString(), id: firstArtifact.id });
  });

  it("applies a composite keyset cursor", async () => {
    artifactMock.findMany.mockResolvedValue([]);
    const cursor = { createdAt: new Date("2026-08-30T12:00:00.000Z"), id: firstArtifact.id };

    await listArtifacts({ workspaceId: firstArtifact.workspaceId, limit: 25, cursor });

    expect(artifactMock.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: firstArtifact.workspaceId,
        OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
      }),
    }));
  });

  it("scopes metadata reads to the actor's workspace membership", async () => {
    artifactMock.findFirst.mockResolvedValue(firstArtifact);

    const artifact = await getArtifactMetadata(firstArtifact.id, { id: "user-1", role: "OPERATOR" });

    expect(artifactMock.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: firstArtifact.id, workspace: { members: { some: { userId: "user-1" } } } },
    }));
    expect(artifact).toMatchObject({ id: firstArtifact.id, sizeBytes: "9007199254740993" });
  });

  it("allows administrators to read artifact metadata without membership", async () => {
    artifactMock.findFirst.mockResolvedValue(firstArtifact);

    await getArtifactMetadata(firstArtifact.id, { id: "admin-1", role: "ADMIN" });

    expect(artifactMock.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: firstArtifact.id } }));
  });

  it("transitions an unreferenced artifact and writes an identifier-only outbox event atomically", async () => {
    artifactMock.findFirst.mockResolvedValue(firstArtifact);
    artifactDeletionJobMock.create.mockImplementation(async ({ data }) => ({ ...data, status: "QUEUED" }));

    const result = await requestArtifactDeletion({ workspaceId: firstArtifact.workspaceId, artifactId: firstArtifact.id, requestedBy: "admin-1", now: new Date("2026-08-30T13:00:00.000Z") });

    expect(result.artifact.lifecycleStatus).toBe(ArtifactLifecycleStatus.DELETING);
    expect(result.artifact.sizeBytes).toBe("9007199254740993");
    const deletionJobId = artifactDeletionJobMock.create.mock.calls[0][0].data.id;
    expect(outboxEventMock.create).toHaveBeenCalledWith({ data: { topic: "artifact.deletion.requested", aggregateId: deletionJobId, payload: { deletionJobId } } });
    expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it("blocks deletion while retention is active", async () => {
    artifactMock.findFirst.mockResolvedValue({ ...firstArtifact, retentionUntil: new Date("2026-09-01T00:00:00.000Z") });

    await expect(requestArtifactDeletion({ workspaceId: firstArtifact.workspaceId, artifactId: firstArtifact.id, requestedBy: "admin-1", now: new Date("2026-08-30T13:00:00.000Z") })).rejects.toMatchObject({ code: "ARTIFACT_RETENTION_ACTIVE" });

    expect(artifactMock.updateMany).not.toHaveBeenCalled();
  });

  it("blocks deletion for nonterminal runs and active knowledge sources", async () => {
    artifactMock.findFirst.mockResolvedValue(firstArtifact);
    agentRunMock.count.mockResolvedValue(1);
    await expect(requestArtifactDeletion({ workspaceId: firstArtifact.workspaceId, artifactId: firstArtifact.id, requestedBy: "admin-1" })).rejects.toMatchObject({ code: "ARTIFACT_RUN_BLOCKED" });

    agentRunMock.count.mockResolvedValue(0);
    artifactMock.findFirst.mockResolvedValue({ ...firstArtifact, knowledgeSource: { status: KnowledgeSourceStatus.ACTIVE } });
    await expect(requestArtifactDeletion({ workspaceId: firstArtifact.workspaceId, artifactId: firstArtifact.id, requestedBy: "admin-1" })).rejects.toMatchObject({ code: "ARTIFACT_KNOWLEDGE_SOURCE_BLOCKED" });
  });

  it("returns the existing deletion job for a repeated request", async () => {
    const deletionJob = { id: "40000000-0000-4000-8000-000000000001", status: "QUEUED" };
    artifactMock.findFirst.mockResolvedValue({ ...firstArtifact, lifecycleStatus: ArtifactLifecycleStatus.DELETING, deletionJob });

    await expect(requestArtifactDeletion({ workspaceId: firstArtifact.workspaceId, artifactId: firstArtifact.id, requestedBy: "admin-1" })).resolves.toMatchObject({ deletionJob });
    expect(outboxEventMock.create).not.toHaveBeenCalled();
  });

  it("requeues a failed deletion job when deletion is requested again", async () => {
    const deletionJob = { id: "40000000-0000-4000-8000-000000000001", status: "FAILED" };
    artifactMock.findFirst.mockResolvedValue({ ...firstArtifact, lifecycleStatus: ArtifactLifecycleStatus.DELETING, deletionJob });
    artifactDeletionJobMock.update.mockResolvedValue({ ...deletionJob, status: "QUEUED" });

    await requestArtifactDeletion({ workspaceId: firstArtifact.workspaceId, artifactId: firstArtifact.id, requestedBy: "admin-1" });

    expect(artifactDeletionJobMock.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: ArtifactDeletionJobStatus.QUEUED, attempts: 0 }) }));
    expect(outboxEventMock.create).toHaveBeenCalledWith({ data: { topic: "artifact.deletion.requested", aggregateId: deletionJob.id, payload: { deletionJobId: deletionJob.id } } });
  });

  it("creates a new linear artifact version from an active predecessor", async () => {
    artifactMock.findFirst.mockResolvedValue({ id: firstArtifact.id, versionSetId: firstArtifact.id, version: 1, lifecycleStatus: ArtifactLifecycleStatus.ACTIVE, nextVersion: null });
    artifactMock.create.mockImplementation(async ({ data }) => data);

    const created = await createArtifact({ workspaceId: firstArtifact.workspaceId, userId: firstArtifact.createdBy, filename: "report-v2.pdf", mimeType: "application/pdf", detectedMimeType: "application/pdf", kind: "SOURCE", bytes: Buffer.from("v2"), previousArtifactId: firstArtifact.id });

    expect(artifactMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ versionSetId: firstArtifact.id, version: 2, previousVersionId: firstArtifact.id }) });
    expect(created.sizeBytes).toBe(2);
  });
});
