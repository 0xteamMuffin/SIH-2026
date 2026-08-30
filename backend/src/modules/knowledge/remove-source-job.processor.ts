import crypto from "node:crypto";
import {
  KnowledgeJobStatus,
  KnowledgeJobType,
  KnowledgeSourceIndexStatus,
  KnowledgeSourceStatus,
  type PrismaClient,
} from "@prisma/client";
import { env } from "../../config/env.js";
import { getQdrantDataPlane } from "../../infrastructure/vector-store/qdrant-data-plane.js";
import type { VectorStoreDataPlane } from "../../infrastructure/vector-store/vector-store-data-plane.js";
import { prisma } from "../../lib/prisma.js";

type RemovalDependencies = {
  db: PrismaClient;
  vectorStore: Pick<VectorStoreDataPlane, "deleteByKnowledgeSourceId">;
  now: () => Date;
  randomUUID: () => string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
};

type ProcessorDependencies = Partial<RemovalDependencies>;

function dependencies(overrides: ProcessorDependencies): RemovalDependencies {
  return {
    db: overrides.db ?? prisma,
    vectorStore: overrides.vectorStore ?? getQdrantDataPlane(),
    now: overrides.now ?? (() => new Date()),
    randomUUID: overrides.randomUUID ?? (() => crypto.randomUUID()),
    leaseDurationMs: overrides.leaseDurationMs ?? env.RUN_LEASE_DURATION_MS,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? env.RUN_HEARTBEAT_INTERVAL_MS,
  };
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Unexpected knowledge source removal failure").slice(0, 2_000);

async function claimJob(jobId: string, input: RemovalDependencies) {
  const claimedAt = input.now();
  const leaseId = input.randomUUID();
  return input.db.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.findUnique({
      where: { id: jobId },
      include: { index: true, sourceIndex: { include: { source: true } } },
    });
    if (!job || job.type !== KnowledgeJobType.REMOVE_SOURCE || job.status !== KnowledgeJobStatus.QUEUED || job.availableAt > claimedAt) return null;
    if (!job.sourceIndex || job.sourceIndexId !== job.sourceIndex.id || job.indexId !== job.sourceIndex.indexId) return null;
    if (job.sourceIndex.source.status === KnowledgeSourceStatus.DELETED || job.sourceIndex.status === KnowledgeSourceIndexStatus.REMOVED) {
      await transaction.knowledgeJob.updateMany({
        where: { id: job.id, status: KnowledgeJobStatus.QUEUED },
        data: { status: KnowledgeJobStatus.SUCCEEDED, completedAt: claimedAt, lastError: null },
      });
      return null;
    }
    if (job.sourceIndex.source.status !== KnowledgeSourceStatus.DELETING || job.sourceIndex.status !== KnowledgeSourceIndexStatus.REMOVING) return null;
    if (job.attempts >= job.maxAttempts) return { exhausted: true as const };

    const leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseDurationMs);
    const claimed = await transaction.knowledgeJob.updateMany({
      where: { id: job.id, type: KnowledgeJobType.REMOVE_SOURCE, status: KnowledgeJobStatus.QUEUED, attempts: job.attempts, availableAt: { lte: claimedAt } },
      data: {
        status: KnowledgeJobStatus.RUNNING,
        attempts: { increment: 1 },
        leaseId,
        heartbeatAt: claimedAt,
        leaseExpiresAt,
        lastError: null,
        startedAt: job.startedAt ?? claimedAt,
        completedAt: null,
      },
    });
    if (claimed.count === 0) return null;
    const sourceIndex = await transaction.knowledgeSourceIndex.updateMany({
      where: { id: job.sourceIndex.id, status: KnowledgeSourceIndexStatus.REMOVING },
      data: { leaseId, heartbeatAt: claimedAt, leaseExpiresAt, lastError: null },
    });
    if (sourceIndex.count === 0) throw new Error("Knowledge source removal lease was lost");
    return { exhausted: false as const, job, leaseId };
  });
}

function startHeartbeat(input: RemovalDependencies, jobId: string, sourceIndexId: string, leaseId: string): () => void {
  let updating = false;
  const timer = setInterval(() => {
    if (updating) return;
    updating = true;
    const now = input.now();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
    void input.db.$transaction(async (transaction) => {
      const job = await transaction.knowledgeJob.updateMany({
        where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
        data: { heartbeatAt: now, leaseExpiresAt },
      });
      if (job.count === 0) throw new Error("Knowledge source removal lease was lost");
      await transaction.knowledgeSourceIndex.updateMany({
        where: { id: sourceIndexId, status: KnowledgeSourceIndexStatus.REMOVING, leaseId },
        data: { heartbeatAt: now, leaseExpiresAt },
      });
    }).catch(() => undefined).finally(() => { updating = false; });
  }, input.heartbeatIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function resetClaim(jobId: string, sourceIndexId: string, leaseId: string, error: unknown, input: RemovalDependencies): Promise<void> {
  const lastError = errorMessage(error);
  await input.db.$transaction(async (transaction) => {
    const reset = await transaction.knowledgeJob.updateMany({
      where: { id: jobId, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: { status: KnowledgeJobStatus.QUEUED, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, lastError, startedAt: null },
    });
    if (reset.count === 0) return;
    await transaction.knowledgeSourceIndex.updateMany({
      where: { id: sourceIndexId, status: KnowledgeSourceIndexStatus.REMOVING, leaseId },
      data: { leaseId: null, heartbeatAt: null, leaseExpiresAt: null, lastError },
    });
  });
}

export async function processRemoveSourceJob(jobId: string, overrides: ProcessorDependencies = {}): Promise<void> {
  const input = dependencies(overrides);
  const claim = await claimJob(jobId, input);
  if (!claim) return;
  if (claim.exhausted) {
    await failRemoveSourceJob(jobId, new Error("Knowledge source removal attempts are exhausted"), input);
    return;
  }
  const sourceIndex = claim.job.sourceIndex!;
  const stopHeartbeat = startHeartbeat(input, claim.job.id, sourceIndex.id, claim.leaseId);
  try {
    await input.vectorStore.deleteByKnowledgeSourceId({
      collectionName: claim.job.index.collectionName,
      knowledgeSourceId: sourceIndex.sourceId,
    });
    const completedAt = input.now();
    await input.db.$transaction(async (transaction) => {
      const removed = await transaction.knowledgeSourceIndex.updateMany({
        where: { id: sourceIndex.id, status: KnowledgeSourceIndexStatus.REMOVING, leaseId: claim.leaseId },
        data: {
          status: KnowledgeSourceIndexStatus.REMOVED,
          chunkCount: 0,
          leaseId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
      if (removed.count === 0) throw new Error("Knowledge source removal lease was lost");
      const completed = await transaction.knowledgeJob.updateMany({
        where: { id: claim.job.id, status: KnowledgeJobStatus.RUNNING, leaseId: claim.leaseId },
        data: { status: KnowledgeJobStatus.SUCCEEDED, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, lastError: null, completedAt },
      });
      if (completed.count === 0) throw new Error("Knowledge source removal lease was lost");
      const remaining = await transaction.knowledgeSourceIndex.count({
        where: { sourceId: sourceIndex.sourceId, status: { not: KnowledgeSourceIndexStatus.REMOVED } },
      });
      if (remaining === 0) {
        await transaction.knowledgeSource.updateMany({
          where: { id: sourceIndex.sourceId, status: KnowledgeSourceStatus.DELETING },
          data: { status: KnowledgeSourceStatus.DELETED, deletedAt: completedAt },
        });
      }
    });
  } catch (error) {
    await resetClaim(claim.job.id, sourceIndex.id, claim.leaseId, error, input);
    throw error;
  } finally {
    stopHeartbeat();
  }
}

export async function failRemoveSourceJob(jobId: string, error: unknown, overrides: ProcessorDependencies = {}): Promise<void> {
  const input = dependencies(overrides);
  const failedAt = input.now();
  await input.db.$transaction(async (transaction) => {
    const job = await transaction.knowledgeJob.findUnique({
      where: { id: jobId },
      select: { id: true, type: true, status: true, sourceIndexId: true, leaseId: true, leaseExpiresAt: true },
    });
    if (!job || job.type !== KnowledgeJobType.REMOVE_SOURCE || !job.sourceIndexId) return;
    if (job.status !== KnowledgeJobStatus.QUEUED && job.status !== KnowledgeJobStatus.RUNNING) return;
    if (job.status === KnowledgeJobStatus.RUNNING && job.leaseExpiresAt && job.leaseExpiresAt > failedAt) return;
    const failed = await transaction.knowledgeJob.updateMany({
      where: { id: job.id, status: job.status, ...(job.status === KnowledgeJobStatus.RUNNING ? { leaseId: job.leaseId } : {}) },
      data: {
        status: KnowledgeJobStatus.FAILED,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        lastError: errorMessage(error),
        completedAt: failedAt,
      },
    });
    if (failed.count === 0) return;
    await transaction.knowledgeSourceIndex.updateMany({
      where: { id: job.sourceIndexId, status: KnowledgeSourceIndexStatus.REMOVING },
      data: { status: KnowledgeSourceIndexStatus.FAILED, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, lastError: errorMessage(error) },
    });
  });
}
