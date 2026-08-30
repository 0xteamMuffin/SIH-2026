import crypto from "node:crypto";
import {
  ArtifactExtractionStatus,
  EmbeddingInvocationStatus,
  EmbeddingPurpose,
  KnowledgeIndexStatus,
  KnowledgeJobStatus,
  KnowledgeJobType,
  KnowledgeSourceIndexStatus,
  KnowledgeSourceStatus,
  KnowledgeVisibility,
  Prisma,
} from "@prisma/client";
import { env } from "../../config/env.js";
import { embedTexts, type EmbeddingProfile, type EmbeddingVector } from "../../infrastructure/embeddings/embedding-provider.js";
import { selectEmbeddingProfile } from "../../infrastructure/embeddings/embedding-profile-resolver.js";
import { modelProfiles, type EmbeddingModelProfile } from "../../infrastructure/models/model-registry.js";
import { getQdrantDataPlane } from "../../infrastructure/vector-store/qdrant-data-plane.js";
import type { VectorPayload, VectorStoreDataPlane } from "../../infrastructure/vector-store/vector-store-data-plane.js";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { extractArtifact } from "../artifacts/artifact-extraction.service.js";
import { KNOWLEDGE_CHUNKER_VERSION, knowledgeIndexIdentity } from "./knowledge-index-provisioner.js";
import { chunkCanonicalText, type CitationTextChunk } from "./text-chunker.js";

export const KNOWLEDGE_TEXT_CHUNKER_VERSION = KNOWLEDGE_CHUNKER_VERSION;

const MAX_VECTOR_UPSERT_POINTS = 256;
const ORGANIZATION_SCOPE_KEY = "organization:default";

type KnowledgeTransaction = Pick<Prisma.TransactionClient,
  "knowledgeJob" | "knowledgeSourceIndex" | "embeddingInvocation"
>;

export interface KnowledgeIndexingDatabase extends KnowledgeTransaction {
  $transaction<T>(work: (transaction: KnowledgeTransaction) => Promise<T>): Promise<T>;
}

export interface IndexSourceJobDependencies {
  db: KnowledgeIndexingDatabase;
  extract: typeof extractArtifact;
  chunk: typeof chunkCanonicalText;
  resolveProfile: (classification: Parameters<typeof selectEmbeddingProfile>[0], profileId: string) => EmbeddingModelProfile;
  embed: (
    profile: EmbeddingProfile,
    classification: Parameters<typeof embedTexts>[1],
    inputs: readonly string[],
    signal?: AbortSignal,
  ) => Promise<EmbeddingVector[]>;
  vectorStore: VectorStoreDataPlane;
  now: () => Date;
  elapsedMilliseconds: () => number;
  randomUUID: () => string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  signal?: AbortSignal;
}

type ProcessorDependencies = Partial<IndexSourceJobDependencies>;

class PermanentIndexingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PermanentIndexingError";
  }
}

class KnowledgeLeaseLostError extends Error {
  constructor() {
    super("Knowledge indexing lease was lost");
    this.name = "KnowledgeLeaseLostError";
  }
}

function dependencies(overrides: ProcessorDependencies): IndexSourceJobDependencies {
  return {
    db: overrides.db ?? prisma,
    extract: overrides.extract ?? extractArtifact,
    chunk: overrides.chunk ?? chunkCanonicalText,
    resolveProfile: overrides.resolveProfile ?? ((classification, profileId) => {
      const configured = modelProfiles().find((profile) => profile.id === profileId);
      return selectEmbeddingProfile(classification, configured ? [configured] : []);
    }),
    embed: overrides.embed ?? embedTexts,
    vectorStore: overrides.vectorStore ?? getQdrantDataPlane(),
    now: overrides.now ?? (() => new Date()),
    elapsedMilliseconds: overrides.elapsedMilliseconds ?? (() => performance.now()),
    randomUUID: overrides.randomUUID ?? (() => crypto.randomUUID()),
    leaseDurationMs: overrides.leaseDurationMs ?? env.RUN_LEASE_DURATION_MS,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? env.RUN_HEARTBEAT_INTERVAL_MS,
    signal: overrides.signal,
  };
}

function sanitizedError(error: unknown): string {
  if (error instanceof PermanentIndexingError) return `${error.code}: ${error.message}`.slice(0, 500);
  if (error instanceof AppError) return `${error.code}: ${error.message}`.slice(0, 500);
  if (error instanceof KnowledgeLeaseLostError) return "KNOWLEDGE_LEASE_LOST: Knowledge indexing lease was lost";
  return "KNOWLEDGE_INDEXING_FAILED: Unexpected indexing failure";
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function metadataString(metadata: Prisma.JsonValue, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function chunkSetChecksum(chunks: readonly CitationTextChunk[]): string {
  const hash = crypto.createHash("sha256");
  for (const chunk of chunks) {
    hash.update(`${chunk.index}:${chunk.charRange.start}:${chunk.charRange.end}:${chunk.contentHash}\n`, "utf8");
  }
  return hash.digest("hex");
}

function scopeKey(visibility: KnowledgeVisibility, workspaceId: string): string {
  return visibility === KnowledgeVisibility.ORGANIZATION_SHARED
    ? ORGANIZATION_SCOPE_KEY
    : `workspace:${workspaceId}`;
}

function profileMatchesIndex(profile: EmbeddingModelProfile, index: {
  fingerprint: string;
  profileId: string;
  providerId: string;
  modelId: string;
  dimensions: number;
  distance: string;
  chunkerVersion: string;
}): boolean {
  const identity = knowledgeIndexIdentity(profile, index.chunkerVersion);
  return identity.fingerprint === index.fingerprint
    && profile.id === index.profileId
    && profile.providerId === index.providerId
    && profile.modelId === index.modelId
    && profile.dimensions === index.dimensions
    && profile.distance.toUpperCase() === index.distance;
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PermanentIndexingError("KNOWLEDGE_INDEX_PROFILE_INVALID", `Embedding profile ${field} is invalid`);
  }
}

function splitBatches(chunks: readonly CitationTextChunk[], profile: EmbeddingModelProfile): CitationTextChunk[][] {
  validatePositiveInteger(profile.maxBatchInputs, "maxBatchInputs");
  validatePositiveInteger(profile.maxBatchCharacters, "maxBatchCharacters");
  validatePositiveInteger(profile.maxInputCharacters, "maxInputCharacters");

  const batches: CitationTextChunk[][] = [];
  let batch: CitationTextChunk[] = [];
  let characters = 0;
  const maxInputs = Math.min(profile.maxBatchInputs, MAX_VECTOR_UPSERT_POINTS);
  for (const chunk of chunks) {
    if (chunk.text.length > profile.maxInputCharacters || chunk.text.length > profile.maxBatchCharacters) {
      throw new PermanentIndexingError("KNOWLEDGE_INDEX_PROFILE_INVALID", "The index embedding profile cannot accept a deterministic chunk");
    }
    if (batch.length === maxInputs || characters + chunk.text.length > profile.maxBatchCharacters) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(chunk);
    characters += chunk.text.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function claimJob(jobId: string, input: IndexSourceJobDependencies) {
  const claimedAt = input.now();
  const leaseId = input.randomUUID();
  const leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseDurationMs);

  return input.db.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.findUnique({
      where: { id: jobId },
      include: {
        index: true,
        sourceIndex: { include: { index: true, source: { include: { artifact: true } } } },
      },
    });
    if (!job || job.status !== KnowledgeJobStatus.QUEUED || job.availableAt > claimedAt) return { kind: "unavailable" as const };
    if (job.type !== KnowledgeJobType.INDEX_SOURCE || !job.sourceIndexId || !job.sourceIndex) {
      return { kind: "invalid" as const, error: new PermanentIndexingError("KNOWLEDGE_JOB_INVALID", "Job is not a valid source indexing job") };
    }
    if (job.attempts >= job.maxAttempts) {
      return { kind: "invalid" as const, error: new PermanentIndexingError("KNOWLEDGE_JOB_ATTEMPTS_EXHAUSTED", "Knowledge indexing attempts are exhausted") };
    }
    if (job.indexId !== job.sourceIndex.indexId || job.index.id !== job.sourceIndex.index.id) {
      return { kind: "invalid" as const, error: new PermanentIndexingError("KNOWLEDGE_INDEX_REFERENCE_INVALID", "Job and source index references do not match") };
    }

    const jobClaim = await transaction.knowledgeJob.updateMany({
      where: {
        id: job.id,
        type: KnowledgeJobType.INDEX_SOURCE,
        status: KnowledgeJobStatus.QUEUED,
        sourceIndexId: job.sourceIndexId,
        attempts: job.attempts,
        availableAt: { lte: claimedAt },
      },
      data: {
        status: KnowledgeJobStatus.RUNNING,
        attempts: { increment: 1 },
        leaseId,
        heartbeatAt: claimedAt,
        leaseExpiresAt,
        lastError: null,
        startedAt: claimedAt,
        completedAt: null,
      },
    });
    if (jobClaim.count === 0) return { kind: "unavailable" as const };

    const sourceClaim = await transaction.knowledgeSourceIndex.updateMany({
      where: {
        id: job.sourceIndex.id,
        sourceId: job.sourceIndex.sourceId,
        indexId: job.sourceIndex.indexId,
        sourceRevision: job.sourceIndex.sourceRevision,
        indexRevision: job.sourceIndex.indexRevision,
        status: KnowledgeSourceIndexStatus.PENDING,
      },
      data: {
        status: KnowledgeSourceIndexStatus.INDEXING,
        leaseId,
        heartbeatAt: claimedAt,
        leaseExpiresAt,
        lastError: null,
        indexedAt: null,
      },
    });
    if (sourceClaim.count === 0) throw new KnowledgeLeaseLostError();

    return { kind: "claimed" as const, job, leaseId, attempt: job.attempts + 1 };
  });
}

async function renewLease(
  db: KnowledgeIndexingDatabase,
  jobId: string,
  sourceIndexId: string,
  leaseId: string,
  now: Date,
  leaseDurationMs: number,
): Promise<void> {
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
  await db.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.updateMany({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: { heartbeatAt: now, leaseExpiresAt },
    });
    if (job.count === 0) throw new KnowledgeLeaseLostError();
    const sourceIndex = await transaction.knowledgeSourceIndex.updateMany({
      where: { id: sourceIndexId, status: KnowledgeSourceIndexStatus.INDEXING, leaseId },
      data: { heartbeatAt: now, leaseExpiresAt },
    });
    if (sourceIndex.count === 0) throw new KnowledgeLeaseLostError();
  });
}

function startHeartbeat(
  input: IndexSourceJobDependencies,
  jobId: string,
  sourceIndexId: string,
  leaseId: string,
  controller: AbortController,
): () => void {
  let updating = false;
  const timer = setInterval(() => {
    if (updating || controller.signal.aborted) return;
    updating = true;
    void renewLease(input.db, jobId, sourceIndexId, leaseId, input.now(), input.leaseDurationMs)
      .catch((error) => controller.abort(error))
      .finally(() => { updating = false; });
  }, input.heartbeatIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof Error && error.name === "AbortError")
    || (error instanceof AppError && error.code === "EMBEDDING_REQUEST_CANCELLED");
}

async function embedBatch(input: {
  dependencies: IndexSourceJobDependencies;
  profile: EmbeddingModelProfile;
  jobId: string;
  indexId: string;
  sourceIndexId: string;
  batch: number;
  attempt: number;
  chunks: readonly CitationTextChunk[];
  classification: Parameters<typeof embedTexts>[1];
  signal: AbortSignal;
}): Promise<EmbeddingVector[]> {
  const invocation = await input.dependencies.db.embeddingInvocation.create({
    data: {
      jobId: input.jobId,
      indexId: input.indexId,
      sourceIndexId: input.sourceIndexId,
      purpose: EmbeddingPurpose.INDEX,
      providerId: input.profile.providerId,
      profileId: input.profile.id,
      modelId: input.profile.modelId,
      batch: input.batch,
      attempt: input.attempt,
      status: EmbeddingInvocationStatus.RUNNING,
      inputCount: input.chunks.length,
      inputCharacters: input.chunks.reduce((total, chunk) => total + chunk.text.length, 0),
      dimensions: input.profile.dimensions,
    },
  });
  const startedAt = input.dependencies.elapsedMilliseconds();
  try {
    const vectors = await input.dependencies.embed(input.profile, input.classification, input.chunks.map((chunk) => chunk.text), input.signal);
    if (vectors.length !== input.chunks.length || vectors.some((vector) => vector.length !== input.profile.dimensions)) {
      throw new AppError(502, "Embedding provider returned incompatible vectors", "EMBEDDING_RESPONSE_INVALID");
    }
    await input.dependencies.db.embeddingInvocation.update({
      where: { id: invocation.id },
      data: {
        status: EmbeddingInvocationStatus.SUCCEEDED,
        latencyMs: Math.max(0, Math.round(input.dependencies.elapsedMilliseconds() - startedAt)),
        completedAt: input.dependencies.now(),
      },
    });
    return vectors;
  } catch (error) {
    await input.dependencies.db.embeddingInvocation.update({
      where: { id: invocation.id },
      data: {
        status: isCancellation(error, input.signal) ? EmbeddingInvocationStatus.CANCELLED : EmbeddingInvocationStatus.FAILED,
        latencyMs: Math.max(0, Math.round(input.dependencies.elapsedMilliseconds() - startedAt)),
        sanitizedError: sanitizedError(error),
        completedAt: input.dependencies.now(),
      },
    });
    throw error;
  }
}

async function resetClaim(input: IndexSourceJobDependencies, jobId: string, sourceIndexId: string, leaseId: string, error: unknown): Promise<void> {
  const reason = sanitizedError(error);
  await input.db.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.updateMany({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: {
        status: KnowledgeJobStatus.QUEUED,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        lastError: reason,
        startedAt: null,
        completedAt: null,
      },
    });
    if (job.count === 0) throw new KnowledgeLeaseLostError();
    const sourceIndex = await transaction.knowledgeSourceIndex.updateMany({
      where: { id: sourceIndexId, status: KnowledgeSourceIndexStatus.INDEXING, leaseId },
      data: {
        status: KnowledgeSourceIndexStatus.PENDING,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        lastError: reason,
      },
    });
    if (sourceIndex.count === 0) throw new KnowledgeLeaseLostError();
  });
}

async function failClaim(input: IndexSourceJobDependencies, jobId: string, sourceIndexId: string, leaseId: string, error: unknown): Promise<void> {
  const failedAt = input.now();
  const reason = sanitizedError(error);
  await input.db.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.updateMany({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: {
        status: KnowledgeJobStatus.FAILED,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        lastError: reason,
        completedAt: failedAt,
      },
    });
    if (job.count === 0) throw new KnowledgeLeaseLostError();
    const sourceIndex = await transaction.knowledgeSourceIndex.updateMany({
      where: { id: sourceIndexId, status: KnowledgeSourceIndexStatus.INDEXING, leaseId },
      data: {
        status: KnowledgeSourceIndexStatus.FAILED,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        lastError: reason,
      },
    });
    if (sourceIndex.count === 0) throw new KnowledgeLeaseLostError();
  });
}

async function completeClaim(input: {
  dependencies: IndexSourceJobDependencies;
  jobId: string;
  sourceIndexId: string;
  leaseId: string;
  sourceRevision: number;
  indexRevision: number;
  chunkCount: number;
  sourceChecksum: string;
  chunkSetChecksum: string;
}): Promise<void> {
  const completedAt = input.dependencies.now();
  await input.dependencies.db.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.updateMany({
      where: { id: input.jobId, status: KnowledgeJobStatus.RUNNING, leaseId: input.leaseId },
      data: {
        status: KnowledgeJobStatus.SUCCEEDED,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        lastError: null,
        completedAt,
      },
    });
    if (job.count === 0) throw new KnowledgeLeaseLostError();
    const sourceIndex = await transaction.knowledgeSourceIndex.updateMany({
      where: {
        id: input.sourceIndexId,
        status: KnowledgeSourceIndexStatus.INDEXING,
        leaseId: input.leaseId,
        sourceRevision: input.sourceRevision,
        indexRevision: input.indexRevision,
        source: { status: KnowledgeSourceStatus.ACTIVE, revision: input.sourceRevision },
        index: { status: KnowledgeIndexStatus.ACTIVE, revision: input.indexRevision },
      },
      data: {
        status: KnowledgeSourceIndexStatus.READY,
        chunkCount: input.chunkCount,
        sourceChecksum: input.sourceChecksum,
        chunkSetChecksum: input.chunkSetChecksum,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        lastError: null,
        indexedAt: completedAt,
      },
    });
    if (sourceIndex.count === 0) throw new KnowledgeLeaseLostError();
  });
}

export async function failKnowledgeJob(jobId: string, error: unknown, overrides: ProcessorDependencies = {}): Promise<void> {
  const input = dependencies(overrides);
  const failedAt = input.now();
  const reason = sanitizedError(error);
  await input.db.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.findUnique({
      where: { id: jobId },
      select: { id: true, type: true, status: true, sourceIndexId: true, leaseId: true, leaseExpiresAt: true },
    });
    if (!job || (job.status !== KnowledgeJobStatus.QUEUED && job.status !== KnowledgeJobStatus.RUNNING)) return;
    if (job.status === KnowledgeJobStatus.RUNNING && job.leaseExpiresAt && job.leaseExpiresAt > failedAt) return;

    const failed = await transaction.knowledgeJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        ...(job.status === KnowledgeJobStatus.RUNNING ? { leaseId: job.leaseId } : {}),
      },
      data: {
        status: KnowledgeJobStatus.FAILED,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        lastError: reason,
        completedAt: failedAt,
      },
    });
    if (failed.count === 0) return;
    if (job.type === KnowledgeJobType.INDEX_SOURCE && job.sourceIndexId) {
      await transaction.knowledgeSourceIndex.updateMany({
        where: {
          id: job.sourceIndexId,
          OR: [
            { status: KnowledgeSourceIndexStatus.PENDING },
            { status: KnowledgeSourceIndexStatus.INDEXING, leaseId: job.leaseId },
          ],
        },
        data: {
          status: KnowledgeSourceIndexStatus.FAILED,
          leaseId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          lastError: reason,
        },
      });
    }
  });
}

export async function processIndexSourceJob(jobId: string, overrides: ProcessorDependencies = {}): Promise<void> {
  const input = dependencies(overrides);
  const claim = await claimJob(jobId, input);
  if (claim.kind === "unavailable") return;
  if (claim.kind === "invalid") {
    await failKnowledgeJob(jobId, claim.error, input);
    return;
  }

  const { job, leaseId, attempt } = claim;
  const sourceIndex = job.sourceIndex!;
  const source = sourceIndex.source;
  const artifact = source.artifact;
  const index = sourceIndex.index;
  const leaseController = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, leaseController.signal]) : leaseController.signal;
  const stopHeartbeat = startHeartbeat(input, job.id, sourceIndex.id, leaseId, leaseController);

  try {
    if (source.status !== KnowledgeSourceStatus.ACTIVE) {
      throw new PermanentIndexingError("KNOWLEDGE_SOURCE_NOT_ACTIVE", "Knowledge source is not active");
    }
    if (source.revision !== sourceIndex.sourceRevision || index.revision !== sourceIndex.indexRevision) {
      throw new PermanentIndexingError("KNOWLEDGE_REVISION_MISMATCH", "Source or index revision changed before indexing");
    }
    if (index.status !== KnowledgeIndexStatus.ACTIVE || job.indexId !== index.id) {
      throw new PermanentIndexingError("KNOWLEDGE_INDEX_NOT_ACTIVE", "Knowledge index is not active");
    }
    if (index.chunkerVersion !== KNOWLEDGE_TEXT_CHUNKER_VERSION) {
      throw new PermanentIndexingError("KNOWLEDGE_CHUNKER_VERSION_MISMATCH", "Knowledge index uses an unsupported chunker version");
    }
    if (artifact.extractionStatus !== ArtifactExtractionStatus.COMPLETED || !artifact.sha256) {
      throw new PermanentIndexingError("KNOWLEDGE_EXTRACTION_INVALID", "Knowledge source has no completed canonical extraction");
    }

    let profile: EmbeddingModelProfile;
    try {
      profile = input.resolveProfile(artifact.classification, index.profileId);
    } catch {
      throw new PermanentIndexingError("KNOWLEDGE_INDEX_PROFILE_UNAVAILABLE", "The index embedding profile is unavailable under the current policy");
    }
    if (!profileMatchesIndex(profile, index)) {
      throw new PermanentIndexingError("KNOWLEDGE_INDEX_PROFILE_MISMATCH", "The configured embedding profile does not match the knowledge index");
    }

    signal.throwIfAborted();
    const extraction = await input.extract(artifact.id, signal);
    const extractionChecksum = sha256(extraction.text);
    const metadataSourceChecksum = metadataString(extraction.metadata, "sourceSha256");
    const metadataExtractionChecksum = metadataString(extraction.metadata, "extractedSha256");
    if ((metadataSourceChecksum && metadataSourceChecksum !== artifact.sha256)
      || (metadataExtractionChecksum && metadataExtractionChecksum !== extractionChecksum)) {
      throw new PermanentIndexingError("KNOWLEDGE_EXTRACTION_CHECKSUM_MISMATCH", "Canonical extraction checksums do not match the source artifact");
    }

    const chunks = input.chunk({ text: extraction.text, sourceId: source.id, sourceBlocks: extraction.sourceBlocks });
    if (chunks.length === 0) {
      throw new PermanentIndexingError("KNOWLEDGE_SOURCE_EMPTY", "Canonical extraction contains no indexable text");
    }
    const setChecksum = chunkSetChecksum(chunks);
    const batches = splitBatches(chunks, profile);
    const embeddedBatches: Array<{ chunks: CitationTextChunk[]; vectors: EmbeddingVector[] }> = [];

    for (const [batch, batchChunks] of batches.entries()) {
      signal.throwIfAborted();
      const vectors = await embedBatch({
        dependencies: input,
        profile,
        jobId: job.id,
        indexId: index.id,
        sourceIndexId: sourceIndex.id,
        batch,
        attempt,
        chunks: batchChunks,
        classification: artifact.classification,
        signal,
      });
      embeddedBatches.push({ chunks: batchChunks, vectors });
    }

    signal.throwIfAborted();
    await input.vectorStore.deleteByKnowledgeSourceId({ collectionName: index.collectionName, knowledgeSourceId: source.id });
    const pointScopeKey = scopeKey(source.visibility, source.workspaceId);
    for (const embedded of embeddedBatches) {
      signal.throwIfAborted();
      await input.vectorStore.upsertPoints({
        collectionName: index.collectionName,
        vectorName: index.vectorName,
        scope: { workspaceId: source.workspaceId, scopeKey: pointScopeKey },
        points: embedded.chunks.map((chunk, chunkIndex) => ({
          id: chunk.pointId,
          vector: embedded.vectors[chunkIndex],
          knowledgeSourceId: source.id,
          artifactId: artifact.id,
          classification: artifact.classification,
          payload: {
            text: chunk.text,
            filename: artifact.filename,
            source_revision: sourceIndex.sourceRevision,
            index_revision: sourceIndex.indexRevision,
            source_checksum: artifact.sha256!,
            extraction_checksum: extractionChecksum,
            chunk_set_checksum: setChecksum,
            chunk_checksum: chunk.contentHash,
            chunk_index: chunk.index,
            active: true,
            char_range: { start: chunk.charRange.start, end: chunk.charRange.end },
            line_range: { start: chunk.lineRange.start, end: chunk.lineRange.end },
            citation: {
              char_start: chunk.charRange.start,
              char_end: chunk.charRange.end,
              line_start: chunk.lineRange.start,
              line_end: chunk.lineRange.end,
            },
            heading_path: [...chunk.headingPath],
            element_types: [...chunk.elementTypes],
            source_blocks: chunk.sourceBlocks as unknown as VectorPayload["source_blocks"],
          },
        })),
      });
    }

    signal.throwIfAborted();
    await completeClaim({
      dependencies: input,
      jobId: job.id,
      sourceIndexId: sourceIndex.id,
      leaseId,
      sourceRevision: sourceIndex.sourceRevision,
      indexRevision: sourceIndex.indexRevision,
      chunkCount: chunks.length,
      sourceChecksum: artifact.sha256,
      chunkSetChecksum: setChecksum,
    });
  } catch (error) {
    if (error instanceof PermanentIndexingError) {
      await failClaim(input, job.id, sourceIndex.id, leaseId, error);
      return;
    }
    await resetClaim(input, job.id, sourceIndex.id, leaseId, error);
    throw error;
  } finally {
    stopHeartbeat();
  }
}
