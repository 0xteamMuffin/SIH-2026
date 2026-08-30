import crypto from "node:crypto";
import {
  DataClassification,
  EmbeddingInvocationStatus,
  EmbeddingPurpose,
  KnowledgeIndexStatus,
  KnowledgeJobStatus,
  KnowledgeJobType,
  KnowledgeQueryStatus,
  KnowledgeSourceIndexStatus,
  KnowledgeSourceStatus,
  KnowledgeVisibility,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";
import { embedTexts, type EmbeddingVector } from "../../infrastructure/embeddings/embedding-provider.js";
import { selectEmbeddingProfile } from "../../infrastructure/embeddings/embedding-profile-resolver.js";
import type { EmbeddingModelProfile } from "../../infrastructure/models/model-registry.js";
import { rerankIfConfigured, type OptionalReranker } from "../../infrastructure/models/reranking-provider.js";
import { getQdrantDataPlane } from "../../infrastructure/vector-store/qdrant-data-plane.js";
import type { VectorPayload, VectorQueryMatch, VectorStoreDataPlane } from "../../infrastructure/vector-store/vector-store-data-plane.js";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { knowledgeIndexIdentity } from "./knowledge-index-provisioner.js";

const MAX_QUERY_RESULTS = 100;
const MAX_CITATION_TEXT = 4_000;
const MAX_HEADING_DEPTH = 16;
const MAX_HEADING_LENGTH = 500;
const DEFAULT_LEASE_DURATION_MS = 300_000;
const PERMANENT_ERROR_CODES = new Set([
  "EMBEDDING_INPUT_INVALID",
  "EMBEDDING_INPUT_TOO_LARGE",
  "EMBEDDING_PROFILE_INVALID",
  "EMBEDDING_PROVIDER_NOT_CONFIGURED",
  "EXTERNAL_INFERENCE_BLOCKED",
  "KNOWLEDGE_INDEX_PROFILE_MISMATCH",
  "KNOWLEDGE_INDEX_PROFILE_UNAVAILABLE",
  "KNOWLEDGE_INDEX_REVISION_INACTIVE",
  "KNOWLEDGE_QUERY_FILTERS_INVALID",
  "KNOWLEDGE_QUERY_STATE_CHANGED",
  "KNOWLEDGE_QUERY_STATE_INVALID",
  "REMOTE_INFERENCE_DISABLED",
  "RERANKING_INPUT_INVALID",
  "RERANKING_PROVIDER_NOT_CONFIGURED",
]);

const uuidSchema = z.string().uuid();
const filtersSchema = z.object({
  artifactIds: z.array(uuidSchema).min(1).max(100).optional(),
  classifications: z.array(z.nativeEnum(DataClassification)).min(1).max(4).optional(),
  scoreThreshold: z.number().finite().optional(),
}).strict();

type KnowledgeStore = Pick<PrismaClient,
  "$transaction" | "embeddingInvocation" | "knowledgeIndex" | "knowledgeJob" | "knowledgeQuery" | "knowledgeSourceIndex"
>;

export type KnowledgeCitation = {
  pointId: string | number;
  score: number;
  knowledgeSourceId: string;
  artifactId: string;
  artifactFilename: string;
  text: string;
  headingPath: string[];
  page?: number;
  slide?: number;
  sheet?: string;
  bbox?: [number, number, number, number];
  charRange?: { start: number; end: number };
  lineRange?: { start: number; end: number };
  sourceRef: string;
};

export type KnowledgeQueryResult = {
  indexId: string;
  indexRevision: number;
  citations: KnowledgeCitation[];
};

type AuthoritativeSourceIndex = {
  sourceRevision: number;
  indexRevision: number;
  status: KnowledgeSourceIndexStatus;
  source: {
    id: string;
    workspaceId: string;
    visibility: KnowledgeVisibility;
    status: KnowledgeSourceStatus;
    revision: number;
    artifact: { id: string; filename: string; classification: DataClassification };
  };
};

export type KnowledgeQueryProcessorDependencies = {
  store: KnowledgeStore;
  vectorStore: Pick<VectorStoreDataPlane, "queryPoints">;
  resolveEmbeddingProfile: (classification: DataClassification) => EmbeddingModelProfile;
  embed: (profile: EmbeddingModelProfile, classification: DataClassification, inputs: readonly string[], signal?: AbortSignal) => Promise<EmbeddingVector[]>;
  rerank: OptionalReranker;
  now: () => Date;
  monotonicNow: () => number;
  leaseDurationMs: number;
};

function resolvedDependencies(dependencies: Partial<KnowledgeQueryProcessorDependencies>): KnowledgeQueryProcessorDependencies {
  return {
    store: dependencies.store ?? prisma,
    vectorStore: dependencies.vectorStore ?? getQdrantDataPlane(),
    resolveEmbeddingProfile: dependencies.resolveEmbeddingProfile ?? selectEmbeddingProfile,
    embed: dependencies.embed ?? embedTexts,
    rerank: dependencies.rerank ?? rerankIfConfigured,
    now: dependencies.now ?? (() => new Date()),
    monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
    leaseDurationMs: dependencies.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
  };
}

function safeError(error: unknown): string {
  if (error instanceof AppError) return `[${error.code}] ${error.message}`.slice(0, 2_000);
  if (error instanceof z.ZodError) return "[KNOWLEDGE_QUERY_INVALID] Stored knowledge query filters are invalid";
  return "[KNOWLEDGE_QUERY_FAILED] Knowledge query processing failed";
}

function invocationError(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`.slice(0, 500);
  return "EMBEDDING_INVOCATION_FAILED: Unexpected embedding invocation failure";
}

function isPermanentError(error: unknown): boolean {
  return error instanceof z.ZodError
    || (error instanceof AppError && PERMANENT_ERROR_CODES.has(error.code));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function range(value: unknown, oneBased: boolean): { start: number; end: number } | undefined {
  const candidate = record(value);
  if (!candidate || !Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end)) return undefined;
  const start = candidate.start as number;
  const end = candidate.end as number;
  if (start < (oneBased ? 1 : 0) || end < start) return undefined;
  return { start, end };
}

function bbox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
  return [value[0], value[1], value[2], value[3]];
}

function locationRecord(payload: VectorPayload): Record<string, unknown> {
  const direct = payload as Record<string, unknown>;
  const provenance = record(direct.provenance);
  const sourceBlocks = Array.isArray(direct.source_blocks) ? direct.source_blocks : direct.sourceBlocks;
  const firstBlock = Array.isArray(sourceBlocks) ? record(sourceBlocks[0]) : undefined;
  const blockProvenance = record(firstBlock?.provenance);
  return { ...blockProvenance, ...provenance, ...direct };
}

function citationSourceRef(artifactId: string, citation: Pick<KnowledgeCitation, "page" | "slide" | "sheet" | "charRange" | "lineRange">): string {
  const location: string[] = [];
  if (citation.page !== undefined) location.push(`page=${citation.page}`);
  if (citation.slide !== undefined) location.push(`slide=${citation.slide}`);
  if (citation.sheet !== undefined) location.push(`sheet=${encodeURIComponent(citation.sheet)}`);
  if (citation.charRange) location.push(`chars=${citation.charRange.start}-${citation.charRange.end}`);
  if (citation.lineRange) location.push(`lines=${citation.lineRange.start}-${citation.lineRange.end}`);
  return `artifact:${artifactId}${location.length > 0 ? `#${location.join("&")}` : ""}`;
}

function pointKey(point: VectorQueryMatch): string {
  return `${typeof point.id}:${String(point.id)}`;
}

function payloadIdentity(match: VectorQueryMatch) {
  const sourceId = match.payload.knowledge_source_id;
  const artifactId = match.payload.artifact_id;
  const sourceRevision = match.payload.source_revision;
  const indexRevision = match.payload.index_revision;
  if (!uuidSchema.safeParse(sourceId).success || !uuidSchema.safeParse(artifactId).success) return undefined;
  if (!Number.isSafeInteger(sourceRevision) || !Number.isSafeInteger(indexRevision)) return undefined;
  return { sourceId: sourceId as string, artifactId: artifactId as string, sourceRevision: sourceRevision as number, indexRevision: indexRevision as number };
}

async function claimJob(store: KnowledgeStore, jobId: string, leaseId: string, now: Date, leaseDurationMs: number) {
  const candidate = await store.knowledgeJob.findUnique({
    where: { id: jobId },
    select: { id: true, queryId: true, type: true, status: true, attempts: true, maxAttempts: true, availableAt: true, leaseExpiresAt: true, startedAt: true },
  });
  if (!candidate || candidate.type !== KnowledgeJobType.EXECUTE_QUERY || candidate.attempts >= candidate.maxAttempts) return undefined;

  const queued = candidate.status === KnowledgeJobStatus.QUEUED && candidate.availableAt <= now;
  const expired = candidate.status === KnowledgeJobStatus.RUNNING && (!candidate.leaseExpiresAt || candidate.leaseExpiresAt <= now);
  if (!queued && !expired) return undefined;

  const claimed = await store.knowledgeJob.updateMany({
    where: {
      id: jobId,
      type: KnowledgeJobType.EXECUTE_QUERY,
      attempts: candidate.attempts,
      ...(queued
        ? { status: KnowledgeJobStatus.QUEUED, availableAt: { lte: now } }
        : { status: KnowledgeJobStatus.RUNNING, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }),
    },
    data: {
      status: KnowledgeJobStatus.RUNNING,
      attempts: { increment: 1 },
      leaseId,
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
      startedAt: candidate.startedAt ?? now,
      completedAt: null,
      lastError: null,
    },
  });
  return claimed.count === 1
    ? { queryId: candidate.queryId ?? undefined, attempt: candidate.attempts + 1, maxAttempts: candidate.maxAttempts }
    : undefined;
}

function startHeartbeat(dependencies: KnowledgeQueryProcessorDependencies, jobId: string, leaseId: string, controller: AbortController): () => void {
  const intervalMs = Math.max(1_000, Math.floor(dependencies.leaseDurationMs / 3));
  let updating = false;
  const timer = setInterval(() => {
    if (updating || controller.signal.aborted) return;
    updating = true;
    const now = dependencies.now();
    void dependencies.store.knowledgeJob.updateMany({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + dependencies.leaseDurationMs) },
    }).then((renewed) => {
      if (renewed.count === 0) controller.abort(new Error("Knowledge query job lease was lost"));
    }).catch(() => {
      // A transient heartbeat error does not surrender the lease; the guarded terminal write remains authoritative.
    }).finally(() => {
      updating = false;
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function finishFailed(store: KnowledgeStore, jobId: string, queryId: string, leaseId: string, error: unknown, completedAt: Date): Promise<void> {
  const lastError = safeError(error);
  await store.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.updateMany({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: { status: KnowledgeJobStatus.FAILED, lastError, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt },
    });
    if (job.count === 0) return;
    await transaction.knowledgeQuery.updateMany({
      where: { id: queryId, status: { in: [KnowledgeQueryStatus.QUEUED, KnowledgeQueryStatus.RUNNING] } },
      data: { status: KnowledgeQueryStatus.FAILED, result: Prisma.DbNull, lastError, completedAt },
    });
  });
}

async function resetForRetry(store: KnowledgeStore, jobId: string, queryId: string | undefined, leaseId: string, error: unknown, availableAt: Date): Promise<void> {
  const lastError = safeError(error);
  await store.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.updateMany({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: {
        status: KnowledgeJobStatus.QUEUED,
        availableAt,
        lastError,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        startedAt: null,
        completedAt: null,
      },
    });
    if (job.count === 0 || !queryId) return;
    await transaction.knowledgeQuery.updateMany({
      where: { id: queryId, status: KnowledgeQueryStatus.RUNNING },
      data: { status: KnowledgeQueryStatus.QUEUED, result: Prisma.DbNull, lastError, startedAt: null, completedAt: null },
    });
  });
}

export async function failKnowledgeQueryJob(
  jobId: string,
  error: unknown,
  dependencies: Pick<Partial<KnowledgeQueryProcessorDependencies>, "store" | "now"> = {},
): Promise<void> {
  const store = dependencies.store ?? prisma;
  const failedAt = dependencies.now?.() ?? new Date();
  const lastError = safeError(error);
  await store.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.findUnique({
      where: { id: jobId },
      select: { id: true, queryId: true, type: true, status: true, leaseId: true, leaseExpiresAt: true },
    });
    if (!job || job.type !== KnowledgeJobType.EXECUTE_QUERY || !job.queryId) return;
    if (job.status !== KnowledgeJobStatus.QUEUED && job.status !== KnowledgeJobStatus.RUNNING) return;
    if (job.status === KnowledgeJobStatus.RUNNING && job.leaseExpiresAt && job.leaseExpiresAt > failedAt) return;

    const failed = await transaction.knowledgeJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        ...(job.status === KnowledgeJobStatus.RUNNING
          ? { leaseId: job.leaseId, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: failedAt } }] }
          : {}),
      },
      data: {
        status: KnowledgeJobStatus.FAILED,
        lastError,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        completedAt: failedAt,
      },
    });
    if (failed.count === 0) return;
    await transaction.knowledgeQuery.updateMany({
      where: { id: job.queryId, status: { in: [KnowledgeQueryStatus.QUEUED, KnowledgeQueryStatus.RUNNING] } },
      data: { status: KnowledgeQueryStatus.FAILED, result: Prisma.DbNull, lastError, completedAt: failedAt },
    });
  });
}

async function finishSucceeded(store: KnowledgeStore, jobId: string, queryId: string, leaseId: string, result: KnowledgeQueryResult, completedAt: Date): Promise<void> {
  await store.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.updateMany({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: { status: KnowledgeJobStatus.SUCCEEDED, lastError: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt },
    });
    if (job.count === 0) throw new AppError(409, "Knowledge query job lease was lost", "KNOWLEDGE_QUERY_LEASE_LOST");
    const query = await transaction.knowledgeQuery.updateMany({
      where: { id: queryId, status: KnowledgeQueryStatus.RUNNING },
      data: { status: KnowledgeQueryStatus.SUCCEEDED, result: result as unknown as Prisma.InputJsonValue, lastError: null, completedAt },
    });
    if (query.count === 0) throw new AppError(409, "Knowledge query state changed while processing", "KNOWLEDGE_QUERY_STATE_CHANGED");
  });
}

function assertCompatibleProfile(index: {
  fingerprint: string;
  profileId: string;
  providerId: string;
  modelId: string;
  dimensions: number;
  distance: string;
  chunkerVersion: string;
}, profile: EmbeddingModelProfile): void {
  const identity = knowledgeIndexIdentity(profile, index.chunkerVersion);
  if (identity.fingerprint !== index.fingerprint
    || profile.id !== index.profileId
    || profile.providerId !== index.providerId
    || profile.modelId !== index.modelId
    || profile.dimensions !== index.dimensions
    || profile.distance.toUpperCase() !== index.distance) {
    throw new AppError(409, "The active knowledge index embedding profile is unavailable", "KNOWLEDGE_INDEX_PROFILE_MISMATCH");
  }
}

async function embedQuery(
  dependencies: KnowledgeQueryProcessorDependencies,
  job: { id: string; attempts: number; indexId: string; queryId: string | null },
  query: { id: string; queryText: string; dataClassification: DataClassification },
  profile: EmbeddingModelProfile,
  signal: AbortSignal,
): Promise<number[]> {
  const invocation = await dependencies.store.embeddingInvocation.create({
    data: {
      jobId: job.id,
      indexId: job.indexId,
      queryId: query.id,
      purpose: EmbeddingPurpose.QUERY,
      providerId: profile.providerId,
      profileId: profile.id,
      modelId: profile.modelId,
      batch: 0,
      attempt: job.attempts,
      status: EmbeddingInvocationStatus.RUNNING,
      inputCount: 1,
      inputCharacters: query.queryText.length,
      dimensions: profile.dimensions,
    },
  });
  const startedAt = dependencies.monotonicNow();
  try {
    const vectors = await dependencies.embed(profile, query.dataClassification, [query.queryText], signal);
    if (vectors.length !== 1 || vectors[0].length !== profile.dimensions || vectors[0].some((value) => !Number.isFinite(value))) {
      throw new AppError(502, "Embedding provider returned an invalid query vector", "EMBEDDING_RESPONSE_INVALID");
    }
    await dependencies.store.embeddingInvocation.update({
      where: { id: invocation.id },
      data: { status: EmbeddingInvocationStatus.SUCCEEDED, latencyMs: Math.max(0, Math.round(dependencies.monotonicNow() - startedAt)), completedAt: dependencies.now() },
    });
    return vectors[0];
  } catch (error) {
    await dependencies.store.embeddingInvocation.update({
      where: { id: invocation.id },
      data: {
        status: signal.aborted ? EmbeddingInvocationStatus.CANCELLED : EmbeddingInvocationStatus.FAILED,
        latencyMs: Math.max(0, Math.round(dependencies.monotonicNow() - startedAt)),
        sanitizedError: invocationError(error),
        completedAt: dependencies.now(),
      },
    });
    throw error;
  }
}

function assembleCitations(
  matches: VectorQueryMatch[],
  sourceIndexes: AuthoritativeSourceIndex[],
  workspaceId: string,
  indexRevision: number,
  topK: number,
): KnowledgeCitation[] {
  const authoritative = new Map(sourceIndexes.map((sourceIndex) => [sourceIndex.source.id, sourceIndex]));
  const seen = new Set<string>();
  const citations: KnowledgeCitation[] = [];

  for (const match of [...matches].sort((left, right) => right.score - left.score || pointKey(left).localeCompare(pointKey(right)))) {
    if (!Number.isFinite(match.score) || seen.has(pointKey(match))) continue;
    seen.add(pointKey(match));
    const identity = payloadIdentity(match);
    if (!identity || identity.indexRevision !== indexRevision) continue;
    const sourceIndex = authoritative.get(identity.sourceId);
    if (!sourceIndex || sourceIndex.status !== KnowledgeSourceIndexStatus.READY) continue;
    const source = sourceIndex.source;
    const artifact = source.artifact;
    if (source.status !== KnowledgeSourceStatus.ACTIVE || source.revision !== sourceIndex.sourceRevision) continue;
    if (identity.sourceRevision !== sourceIndex.sourceRevision || identity.indexRevision !== sourceIndex.indexRevision) continue;
    if (identity.artifactId !== artifact.id || match.payload.classification !== artifact.classification) continue;
    const expectedScope = source.visibility === KnowledgeVisibility.ORGANIZATION_SHARED ? "organization:default" : `workspace:${workspaceId}`;
    if (match.payload.scope_key !== expectedScope || match.payload.workspace_id !== source.workspaceId) continue;

    const text = typeof match.payload.text === "string" ? match.payload.text.trim().slice(0, MAX_CITATION_TEXT) : "";
    if (!text) continue;
    const payloadHeadingPath = Array.isArray(match.payload.heading_path) ? match.payload.heading_path : match.payload.headingPath;
    const headingPath = Array.isArray(payloadHeadingPath)
      ? payloadHeadingPath.filter((heading): heading is string => typeof heading === "string" && heading.length > 0)
        .slice(0, MAX_HEADING_DEPTH).map((heading) => heading.slice(0, MAX_HEADING_LENGTH))
      : [];
    const location = locationRecord(match.payload);
    const page = positiveInteger(location.page);
    const slide = positiveInteger(location.slide);
    const sheet = typeof location.sheet === "string" && location.sheet.length > 0 ? location.sheet.slice(0, 255) : undefined;
    const citationBbox = bbox(location.bbox);
    const charRange = range(match.payload.char_range ?? match.payload.charRange, false);
    const lineRange = range(match.payload.line_range ?? match.payload.lineRange, true);
    const citation: KnowledgeCitation = {
      pointId: match.id,
      score: match.score,
      knowledgeSourceId: source.id,
      artifactId: artifact.id,
      artifactFilename: artifact.filename,
      text,
      headingPath,
      ...(page === undefined ? {} : { page }),
      ...(slide === undefined ? {} : { slide }),
      ...(sheet === undefined ? {} : { sheet }),
      ...(citationBbox === undefined ? {} : { bbox: citationBbox }),
      ...(charRange === undefined ? {} : { charRange }),
      ...(lineRange === undefined ? {} : { lineRange }),
      sourceRef: "",
    };
    citation.sourceRef = citationSourceRef(artifact.id, citation);
    citations.push(citation);
    if (citations.length === topK) break;
  }
  return citations;
}

function rerankingClassification(queryClassification: DataClassification, sourceIndexes: AuthoritativeSourceIndex[]): DataClassification {
  if (sourceIndexes.some((sourceIndex) => sourceIndex.source.artifact.classification === DataClassification.CONFIDENTIAL)) return DataClassification.CONFIDENTIAL;
  if (sourceIndexes.some((sourceIndex) => sourceIndex.source.artifact.classification === DataClassification.INTERNAL)) return DataClassification.INTERNAL;
  return queryClassification;
}

export async function processKnowledgeQueryJob(jobId: string, dependencies: Partial<KnowledgeQueryProcessorDependencies> = {}): Promise<void> {
  const resolved = resolvedDependencies(dependencies);
  const leaseId = crypto.randomUUID();
  const claim = await claimJob(resolved.store, jobId, leaseId, resolved.now(), resolved.leaseDurationMs);
  if (!claim) return;

  const leaseController = new AbortController();
  const stopHeartbeat = startHeartbeat(resolved, jobId, leaseId, leaseController);
  let queryId = claim.queryId;
  try {
    const job = await resolved.store.knowledgeJob.findUnique({ where: { id: jobId }, include: { index: true, query: true } });
    if (!job?.query) throw new AppError(500, "Knowledge query job has no query", "KNOWLEDGE_QUERY_STATE_INVALID");
    queryId = job.query.id;
    const query = job.query;
    if (job.indexId !== query.indexId || job.index.status !== KnowledgeIndexStatus.ACTIVE || job.index.revision !== query.indexRevision) {
      throw new AppError(409, "Knowledge query index revision is no longer active", "KNOWLEDGE_INDEX_REVISION_INACTIVE");
    }

    const started = await resolved.store.knowledgeQuery.updateMany({
      where: { id: query.id, status: { in: [KnowledgeQueryStatus.QUEUED, KnowledgeQueryStatus.RUNNING] } },
      data: { status: KnowledgeQueryStatus.RUNNING, startedAt: query.startedAt ?? resolved.now(), completedAt: null, lastError: null },
    });
    if (started.count === 0) throw new AppError(409, "Knowledge query is no longer runnable", "KNOWLEDGE_QUERY_STATE_CHANGED");

    const parsedFilters = filtersSchema.safeParse(query.filters);
    if (!parsedFilters.success) {
      throw new AppError(422, "Stored knowledge query filters are invalid", "KNOWLEDGE_QUERY_FILTERS_INVALID");
    }
    const filters = parsedFilters.data;
    let profile: EmbeddingModelProfile;
    try {
      profile = resolved.resolveEmbeddingProfile(query.dataClassification);
    } catch {
      throw new AppError(503, "The knowledge index embedding profile is unavailable", "KNOWLEDGE_INDEX_PROFILE_UNAVAILABLE");
    }
    assertCompatibleProfile(job.index, profile);
    leaseController.signal.throwIfAborted();
    const vector = await embedQuery(resolved, job, query, profile, leaseController.signal);
    leaseController.signal.throwIfAborted();

    const topK = Math.min(MAX_QUERY_RESULTS, Math.max(1, query.topK));
    const matches = await resolved.vectorStore.queryPoints({
      collectionName: job.index.collectionName,
      vectorName: job.index.vectorName,
      vector,
      permittedScopeKeys: [`workspace:${query.workspaceId}`, "organization:default"],
      ...(filters.artifactIds ? { artifactIds: [...new Set(filters.artifactIds)].sort() } : {}),
      ...(filters.classifications ? { classifications: [...new Set(filters.classifications)].sort() } : {}),
      ...(filters.scoreThreshold === undefined ? {} : { scoreThreshold: filters.scoreThreshold }),
      limit: Math.min(MAX_QUERY_RESULTS, Math.max(topK, topK * 4)),
    });
    leaseController.signal.throwIfAborted();

    const stillActive = await resolved.store.knowledgeIndex.findFirst({
      where: { id: job.indexId, status: KnowledgeIndexStatus.ACTIVE, revision: query.indexRevision },
      select: { id: true },
    });
    if (!stillActive) throw new AppError(409, "Knowledge query index revision is no longer active", "KNOWLEDGE_INDEX_REVISION_INACTIVE");

    const identities = matches.map(payloadIdentity).filter((identity): identity is NonNullable<typeof identity> => identity !== undefined);
    const sourceIds = [...new Set(identities.map((identity) => identity.sourceId))];
    const sourceIndexes = sourceIds.length === 0 ? [] : await resolved.store.knowledgeSourceIndex.findMany({
      where: {
        indexId: job.indexId,
        indexRevision: query.indexRevision,
        status: KnowledgeSourceIndexStatus.READY,
        sourceId: { in: sourceIds },
        source: {
          status: KnowledgeSourceStatus.ACTIVE,
          OR: [
            { workspaceId: query.workspaceId, visibility: KnowledgeVisibility.WORKSPACE_PRIVATE },
            { visibility: KnowledgeVisibility.ORGANIZATION_SHARED },
          ],
          ...(filters.artifactIds ? { artifactId: { in: filters.artifactIds } } : {}),
          artifact: {
            ...(filters.classifications ? { classification: { in: filters.classifications } } : {}),
          },
        },
      },
      select: {
        sourceRevision: true,
        indexRevision: true,
        status: true,
        source: {
          select: {
            id: true,
            workspaceId: true,
            visibility: true,
            status: true,
            revision: true,
            artifact: { select: { id: true, filename: true, classification: true } },
          },
        },
      },
    });
    const citations = assembleCitations(matches, sourceIndexes, query.workspaceId, query.indexRevision, MAX_QUERY_RESULTS);
    const ranked = await resolved.rerank({
      classification: rerankingClassification(query.dataClassification, sourceIndexes),
      query: query.queryText,
      items: citations,
      text: (citation) => citation.text,
      signal: leaseController.signal,
    });
    leaseController.signal.throwIfAborted();
    const result: KnowledgeQueryResult = {
      indexId: job.indexId,
      indexRevision: query.indexRevision,
      citations: ranked.slice(0, topK),
    };
    await finishSucceeded(resolved.store, job.id, query.id, leaseId, result, resolved.now());
  } catch (error) {
    if (isPermanentError(error) || claim.attempt >= claim.maxAttempts) {
      if (queryId) await finishFailed(resolved.store, jobId, queryId, leaseId, error, resolved.now());
      else {
        await resolved.store.knowledgeJob.updateMany({
          where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
          data: { status: KnowledgeJobStatus.FAILED, lastError: safeError(error), leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt: resolved.now() },
        });
      }
      return;
    }

    // RabbitMQ's retry queue owns the delay; availableAt stays immediately eligible to avoid stacking backoffs.
    await resetForRetry(resolved.store, jobId, queryId, leaseId, error, resolved.now());
    throw error;
  } finally {
    stopHeartbeat();
  }
}
