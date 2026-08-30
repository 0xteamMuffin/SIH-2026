import crypto from "node:crypto";
import {
  ArtifactExtractionStatus,
  DataClassification,
  KnowledgeIndexStatus,
  KnowledgeJobStatus,
  KnowledgeJobType,
  KnowledgeSourceIndexStatus,
  KnowledgeSourceStatus,
  KnowledgeVisibility,
  KnowledgeVectorDistance,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingModelProfile } from "../src/infrastructure/models/model-registry.js";
import { AppError } from "../src/lib/errors.js";
import { knowledgeIndexIdentity } from "../src/modules/knowledge/knowledge-index-provisioner.js";
import {
  failKnowledgeJob,
  KNOWLEDGE_TEXT_CHUNKER_VERSION,
  processIndexSourceJob,
  type IndexSourceJobDependencies,
} from "../src/modules/knowledge/index-source-job.processor.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const artifactId = "20000000-0000-4000-8000-000000000001";
const sourceId = "30000000-0000-4000-8000-000000000001";
const indexId = "40000000-0000-4000-8000-000000000001";
const sourceIndexId = "50000000-0000-4000-8000-000000000001";
const jobId = "60000000-0000-4000-8000-000000000001";
const leaseId = "70000000-0000-4000-8000-000000000001";
const sourceText = "# Safety\n\nClose valve V-101 before maintenance.\n\n# Startup\n\nOpen valve V-102 slowly.";
const sourceChecksum = "a".repeat(64);
const extractionChecksum = crypto.createHash("sha256").update(sourceText).digest("hex");

const profile: EmbeddingModelProfile = {
  id: "text-embedding",
  providerId: "local-runtime",
  location: "local",
  baseUrl: "http://localhost:11434/v1",
  modelId: "embedding-v1",
  capabilities: ["embedding"],
  priority: 1,
  enabled: true,
  sovereign: true,
  maxOutputTokens: 1,
  revision: "embedding-v1.0.0",
  dimensions: 2,
  distance: "cosine",
  maxBatchInputs: 1,
  maxBatchCharacters: 10_000,
  maxInputCharacters: 2_400,
  inputModalities: ["TEXT"],
};

function queuedJob(overrides: Record<string, unknown> = {}) {
  const identity = knowledgeIndexIdentity(profile);
  const index = {
    id: indexId,
    fingerprint: identity.fingerprint,
    profileId: profile.id,
    providerId: profile.providerId,
    modelId: profile.modelId,
    dimensions: profile.dimensions,
    distance: KnowledgeVectorDistance.COSINE,
    revision: 3,
    status: KnowledgeIndexStatus.ACTIVE,
    chunkerVersion: KNOWLEDGE_TEXT_CHUNKER_VERSION,
    collectionName: identity.collectionName,
    vectorName: identity.vectorName,
  };
  const artifact = {
    id: artifactId,
    filename: "operations.md",
    classification: DataClassification.INTERNAL,
    extractionStatus: ArtifactExtractionStatus.COMPLETED,
    sha256: sourceChecksum,
  };
  return {
    id: jobId,
    workspaceId,
    indexId,
    sourceIndexId,
    type: KnowledgeJobType.INDEX_SOURCE,
    status: KnowledgeJobStatus.QUEUED,
    attempts: 0,
    maxAttempts: 3,
    availableAt: new Date(0),
    index,
    sourceIndex: {
      id: sourceIndexId,
      sourceId,
      indexId,
      sourceRevision: 2,
      indexRevision: 3,
      status: KnowledgeSourceIndexStatus.PENDING,
      index,
      source: {
        id: sourceId,
        workspaceId,
        revision: 2,
        status: KnowledgeSourceStatus.ACTIVE,
        visibility: KnowledgeVisibility.WORKSPACE_PRIVATE,
        artifact,
      },
    },
    ...overrides,
  };
}

function harness(job = queuedJob()) {
  const knowledgeJob = {
    findUnique: vi.fn().mockResolvedValue(job),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const knowledgeSourceIndex = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
  const embeddingInvocation = {
    create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: `invocation-${data.batch}` })),
    update: vi.fn().mockResolvedValue({}),
  };
  const db = {
    knowledgeJob,
    knowledgeSourceIndex,
    embeddingInvocation,
    $transaction: vi.fn().mockImplementation((work) => work({ knowledgeJob, knowledgeSourceIndex, embeddingInvocation })),
  };
  const extract = vi.fn().mockResolvedValue({
    text: sourceText,
    objectKey: "canonical.md",
    metadata: { sourceSha256: sourceChecksum, extractedSha256: extractionChecksum },
    sourceBlocks: [{
      id: "page-1-block-2",
      startChar: sourceText.indexOf("Close valve"),
      endChar: sourceText.indexOf("Close valve") + "Close valve V-101 before maintenance.".length,
      elementType: "paragraph",
      provenance: { source: "docling", page: 1, bbox: [10, 20, 200, 40], pageNumbers: [1], boundingBoxes: [{ pageNumber: 1, left: 10, top: 20, right: 200, bottom: 40 }] },
    }],
  });
  const embed = vi.fn().mockImplementation(async (_profile, _classification, texts: readonly string[]) => texts.map(() => [0.1, 0.2]));
  const vectorStore = {
    upsertPoints: vi.fn().mockResolvedValue(undefined),
    deleteByKnowledgeSourceId: vi.fn().mockResolvedValue(undefined),
    queryPoints: vi.fn(),
    countPoints: vi.fn(),
    scrollPoints: vi.fn(),
  };
  let elapsed = 0;
  const dependencies: Partial<IndexSourceJobDependencies> = {
    db: db as never,
    extract,
    resolveProfile: vi.fn().mockReturnValue(profile),
    embed,
    vectorStore,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
    elapsedMilliseconds: () => ++elapsed * 10,
    randomUUID: () => leaseId,
    leaseDurationMs: 60_000,
    heartbeatIntervalMs: 30_000,
  };
  return { db, knowledgeJob, knowledgeSourceIndex, embeddingInvocation, extract, embed, vectorStore, dependencies };
}

describe("source indexing job processor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims, embeds sequential batches with telemetry, writes citation payloads, and completes with fencing", async () => {
    const test = harness();
    let activeEmbeddingCalls = 0;
    let maximumConcurrentEmbeddings = 0;
    test.embed.mockImplementation(async (_profile, _classification, texts: readonly string[]) => {
      activeEmbeddingCalls += 1;
      maximumConcurrentEmbeddings = Math.max(maximumConcurrentEmbeddings, activeEmbeddingCalls);
      await Promise.resolve();
      activeEmbeddingCalls -= 1;
      return texts.map(() => [0.1, 0.2]);
    });

    await processIndexSourceJob(jobId, test.dependencies);

    expect(test.knowledgeJob.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: jobId, status: KnowledgeJobStatus.QUEUED, attempts: 0 }),
      data: expect.objectContaining({ status: KnowledgeJobStatus.RUNNING, attempts: { increment: 1 }, leaseId }),
    }));
    expect(test.knowledgeSourceIndex.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: sourceIndexId, status: KnowledgeSourceIndexStatus.PENDING }),
      data: expect.objectContaining({ status: KnowledgeSourceIndexStatus.INDEXING, leaseId }),
    }));
    expect(test.embed).toHaveBeenCalledTimes(2);
    expect(maximumConcurrentEmbeddings).toBe(1);
    expect(test.embeddingInvocation.create).toHaveBeenCalledTimes(2);
    expect(test.embeddingInvocation.create.mock.calls.map(([call]) => call.data)).toEqual([
      expect.objectContaining({ batch: 0, attempt: 1, inputCount: 1, inputCharacters: expect.any(Number), dimensions: 2 }),
      expect.objectContaining({ batch: 1, attempt: 1, inputCount: 1, inputCharacters: expect.any(Number), dimensions: 2 }),
    ]);
    expect(test.embeddingInvocation.update).toHaveBeenCalledTimes(2);
    expect(test.vectorStore.deleteByKnowledgeSourceId).toHaveBeenCalledWith({ collectionName: knowledgeIndexIdentity(profile).collectionName, knowledgeSourceId: sourceId });
    expect(test.vectorStore.upsertPoints).toHaveBeenCalledTimes(2);
    const firstWrite = test.vectorStore.upsertPoints.mock.calls[0][0];
    expect(firstWrite.scope).toEqual({ workspaceId, scopeKey: `workspace:${workspaceId}` });
    expect(firstWrite.points[0]).toMatchObject({
      knowledgeSourceId: sourceId,
      artifactId,
      classification: DataClassification.INTERNAL,
      payload: {
        text: expect.any(String),
        filename: "operations.md",
        source_revision: 2,
        index_revision: 3,
        source_checksum: sourceChecksum,
        extraction_checksum: extractionChecksum,
        chunk_set_checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
        chunk_checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
        active: true,
        char_range: { start: expect.any(Number), end: expect.any(Number) },
        line_range: { start: expect.any(Number), end: expect.any(Number) },
        citation: { char_start: expect.any(Number), char_end: expect.any(Number), line_start: expect.any(Number), line_end: expect.any(Number) },
        source_blocks: [expect.objectContaining({ id: "page-1-block-2", provenance: expect.objectContaining({ page: 1, bbox: [10, 20, 200, 40], pageNumbers: [1] }) })],
      },
    });
    expect(test.knowledgeSourceIndex.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: KnowledgeSourceIndexStatus.INDEXING, leaseId, source: { status: KnowledgeSourceStatus.ACTIVE, revision: 2 } }),
      data: expect.objectContaining({ status: KnowledgeSourceIndexStatus.READY, chunkCount: 2, sourceChecksum, chunkSetChecksum: expect.any(String) }),
    }));
    expect(test.knowledgeJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: expect.objectContaining({ status: KnowledgeJobStatus.SUCCEEDED, leaseId: null }),
    }));
  });

  it("resets both claimed records and throws a retryable embedding failure without writing vectors", async () => {
    const test = harness();
    const providerError = new AppError(503, "Embedding provider is unavailable", "EMBEDDING_PROVIDER_UNAVAILABLE");
    test.embed.mockRejectedValue(providerError);

    await expect(processIndexSourceJob(jobId, test.dependencies)).rejects.toBe(providerError);

    expect(test.embeddingInvocation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED", sanitizedError: "EMBEDDING_PROVIDER_UNAVAILABLE: Embedding provider is unavailable" }),
    }));
    expect(test.vectorStore.deleteByKnowledgeSourceId).not.toHaveBeenCalled();
    expect(test.vectorStore.upsertPoints).not.toHaveBeenCalled();
    expect(test.knowledgeJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: expect.objectContaining({ status: KnowledgeJobStatus.QUEUED, leaseId: null }),
    }));
    expect(test.knowledgeSourceIndex.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: sourceIndexId, status: KnowledgeSourceIndexStatus.INDEXING, leaseId },
      data: expect.objectContaining({ status: KnowledgeSourceIndexStatus.PENDING, leaseId: null }),
    }));
  });

  it("permanently fails a mismatched persisted index profile before extraction", async () => {
    const job = queuedJob();
    job.sourceIndex.index.dimensions = 3;
    job.index.dimensions = 3;
    const test = harness(job);

    await processIndexSourceJob(jobId, test.dependencies);

    expect(test.extract).not.toHaveBeenCalled();
    expect(test.embed).not.toHaveBeenCalled();
    expect(test.knowledgeJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: expect.objectContaining({ status: KnowledgeJobStatus.FAILED, lastError: expect.stringContaining("KNOWLEDGE_INDEX_PROFILE_MISMATCH") }),
    }));
    expect(test.knowledgeSourceIndex.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: sourceIndexId, status: KnowledgeSourceIndexStatus.INDEXING, leaseId },
      data: expect.objectContaining({ status: KnowledgeSourceIndexStatus.FAILED }),
    }));
  });

  it("does nothing when another worker already claimed the job", async () => {
    const test = harness(queuedJob({ status: KnowledgeJobStatus.RUNNING }));

    await processIndexSourceJob(jobId, test.dependencies);

    expect(test.knowledgeJob.updateMany).not.toHaveBeenCalled();
    expect(test.extract).not.toHaveBeenCalled();
  });

  it("fails an exhausted queued job and its pending source index", async () => {
    const test = harness(queuedJob({ attempts: 3, maxAttempts: 3 }));

    await processIndexSourceJob(jobId, test.dependencies);

    expect(test.knowledgeJob.updateMany).toHaveBeenCalledOnce();
    expect(test.knowledgeJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: jobId, status: KnowledgeJobStatus.QUEUED }),
      data: expect.objectContaining({ status: KnowledgeJobStatus.FAILED, lastError: expect.stringContaining("KNOWLEDGE_JOB_ATTEMPTS_EXHAUSTED") }),
    }));
    expect(test.knowledgeSourceIndex.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: sourceIndexId, OR: expect.any(Array) }),
      data: expect.objectContaining({ status: KnowledgeSourceIndexStatus.FAILED }),
    }));
  });

  it("does not let the terminal helper take an unexpired running lease", async () => {
    const job = queuedJob({
      status: KnowledgeJobStatus.RUNNING,
      leaseId,
      leaseExpiresAt: new Date("2026-08-30T12:01:00.000Z"),
    });
    const test = harness(job);

    await failKnowledgeJob(jobId, new Error("worker failure"), test.dependencies);

    expect(test.knowledgeJob.updateMany).not.toHaveBeenCalled();
    expect(test.knowledgeSourceIndex.updateMany).not.toHaveBeenCalled();
  });
});
