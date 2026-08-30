import crypto from "node:crypto";
import { ArtifactDeletionJobStatus, ArtifactLifecycleStatus, KnowledgeSourceIndexStatus, KnowledgeSourceStatus, Prisma, type PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { ARTIFACT_DELETION_REQUESTED_TOPIC } from "../../infrastructure/queue/artifact-deletion-message.js";
import { deleteObject } from "../../infrastructure/storage/artifact-store.js";
import { getQdrantDataPlane } from "../../infrastructure/vector-store/qdrant-data-plane.js";
import type { VectorStoreDataPlane } from "../../infrastructure/vector-store/vector-store-data-plane.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

type ArtifactDeletionDependencies = {
  db: PrismaClient;
  deleteObject: (objectKey: string) => Promise<void>;
  vectorStore: VectorStoreDataPlane;
  now: () => Date;
  randomUUID: () => string;
  leaseDurationMs: number;
};

type ProcessorDependencies = Partial<ArtifactDeletionDependencies>;

function dependencies(overrides: ProcessorDependencies): ArtifactDeletionDependencies {
  return {
    db: overrides.db ?? prisma,
    deleteObject: overrides.deleteObject ?? deleteObject,
    vectorStore: overrides.vectorStore ?? getQdrantDataPlane(),
    now: overrides.now ?? (() => new Date()),
    randomUUID: overrides.randomUUID ?? (() => crypto.randomUUID()),
    leaseDurationMs: overrides.leaseDurationMs ?? env.RUN_LEASE_DURATION_MS,
  };
}

function sanitizedError(error: unknown): string {
  return (error instanceof Error ? error.message : "Unexpected artifact deletion failure").slice(0, 2_000);
}

async function claimDeletionJob(jobId: string, input: ArtifactDeletionDependencies) {
  const claimedAt = input.now();
  const leaseId = input.randomUUID();
  return input.db.$transaction(async (transaction) => {
    const job = await transaction.artifactDeletionJob.findUnique({
      where: { id: jobId },
      include: {
        artifact: {
          include: {
            knowledgeSource: { include: { sourceIndexes: { include: { index: { select: { collectionName: true } } } } } },
          },
        },
      },
    });
    if (!job || job.status !== ArtifactDeletionJobStatus.QUEUED || job.availableAt > claimedAt) return null;
    if (job.attempts >= job.maxAttempts) {
      await transaction.artifactDeletionJob.update({
        where: { id: job.id },
        data: { status: ArtifactDeletionJobStatus.FAILED, lastError: "Artifact deletion attempts are exhausted", completedAt: claimedAt },
      });
      return null;
    }
    if (job.artifact.lifecycleStatus !== ArtifactLifecycleStatus.DELETING) return null;
    const claimed = await transaction.artifactDeletionJob.updateMany({
      where: { id: job.id, status: ArtifactDeletionJobStatus.QUEUED, attempts: job.attempts, availableAt: { lte: claimedAt } },
      data: {
        status: ArtifactDeletionJobStatus.RUNNING,
        attempts: { increment: 1 },
        leaseId,
        leaseExpiresAt: new Date(claimedAt.getTime() + input.leaseDurationMs),
        lastError: null,
        startedAt: claimedAt,
        completedAt: null,
      },
    });
    return claimed.count === 1 ? { job, leaseId } : null;
  });
}

async function resetClaim(jobId: string, leaseId: string, error: unknown, input: ArtifactDeletionDependencies): Promise<void> {
  await input.db.artifactDeletionJob.updateMany({
    where: { id: jobId, status: ArtifactDeletionJobStatus.RUNNING, leaseId },
    data: {
      status: ArtifactDeletionJobStatus.QUEUED,
      leaseId: null,
      leaseExpiresAt: null,
      lastError: sanitizedError(error),
      startedAt: null,
    },
  });
}

export async function processArtifactDeletionJob(jobId: string, overrides: ProcessorDependencies = {}): Promise<void> {
  const input = dependencies(overrides);
  const claim = await claimDeletionJob(jobId, input);
  if (!claim) return;
  const { job, leaseId } = claim;
  const { artifact } = job;

  try {
    if (artifact.knowledgeSource?.status === KnowledgeSourceStatus.ACTIVE) {
      throw new Error("Active knowledge source blocks artifact deletion");
    }
    if (artifact.knowledgeSource) {
      const collections = new Set(artifact.knowledgeSource.sourceIndexes.map((sourceIndex) => sourceIndex.index.collectionName));
      for (const collectionName of collections) {
        await input.vectorStore.deleteByKnowledgeSourceId({ collectionName, knowledgeSourceId: artifact.knowledgeSource.id });
      }
    }
    if (artifact.extractedObjectKey) await input.deleteObject(artifact.extractedObjectKey);
    if (artifact.extractionProvenanceObjectKey) await input.deleteObject(artifact.extractionProvenanceObjectKey);
    await input.deleteObject(artifact.objectKey);

    const completedAt = input.now();
    await input.db.$transaction(async (transaction) => {
      if (artifact.knowledgeSource) {
        await transaction.knowledgeSourceIndex.updateMany({
          where: { sourceId: artifact.knowledgeSource.id },
          data: { status: KnowledgeSourceIndexStatus.REMOVED, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, lastError: null },
        });
        await transaction.knowledgeSource.updateMany({
          where: { id: artifact.knowledgeSource.id, status: { not: KnowledgeSourceStatus.ACTIVE } },
          data: { status: KnowledgeSourceStatus.DELETED, deletedAt: completedAt },
        });
      }
      const artifactUpdated = await transaction.artifact.updateMany({
        where: { id: artifact.id, lifecycleStatus: ArtifactLifecycleStatus.DELETING },
        data: { lifecycleStatus: ArtifactLifecycleStatus.DELETED, deletedAt: completedAt },
      });
      const jobUpdated = await transaction.artifactDeletionJob.updateMany({
        where: { id: job.id, status: ArtifactDeletionJobStatus.RUNNING, leaseId },
        data: { status: ArtifactDeletionJobStatus.SUCCEEDED, leaseId: null, leaseExpiresAt: null, lastError: null, completedAt },
      });
      if (artifactUpdated.count !== 1 || jobUpdated.count !== 1) throw new Error("Artifact deletion lease was lost");
      await transaction.auditEvent.create({
        data: { actorId: job.requestedBy, workspaceId: artifact.workspaceId, eventType: "ARTIFACT_DELETED", metadata: { artifactId: artifact.id, deletionJobId: job.id } },
      });
    });
  } catch (error) {
    await resetClaim(job.id, leaseId, error, input);
    throw error;
  }
}

export async function failArtifactDeletionJob(jobId: string, error: unknown, overrides: ProcessorDependencies = {}): Promise<void> {
  const input = dependencies(overrides);
  await input.db.artifactDeletionJob.updateMany({
    where: { id: jobId, status: { in: [ArtifactDeletionJobStatus.QUEUED, ArtifactDeletionJobStatus.RUNNING] } },
    data: {
      status: ArtifactDeletionJobStatus.FAILED,
      leaseId: null,
      leaseExpiresAt: null,
      lastError: sanitizedError(error),
      completedAt: input.now(),
    },
  });
}

export async function reconcileArtifactDeletions(overrides: ProcessorDependencies = {}): Promise<{ recovered: number; repaired: number }> {
  const input = {
    db: overrides.db ?? prisma,
    now: overrides.now ?? (() => new Date()),
  };
  const now = input.now();
  const staleBefore = new Date(now.getTime() - (overrides.leaseDurationMs ?? env.RUN_LEASE_DURATION_MS));
  const staleJobs = await input.db.artifactDeletionJob.findMany({
    where: { status: ArtifactDeletionJobStatus.RUNNING, leaseExpiresAt: { lte: now }, artifact: { lifecycleStatus: ArtifactLifecycleStatus.DELETING } },
    select: { id: true },
  });
  let recovered = 0;
  for (const job of staleJobs) {
    await input.db.$transaction(async (transaction) => {
      const reset = await transaction.artifactDeletionJob.updateMany({
        where: { id: job.id, status: ArtifactDeletionJobStatus.RUNNING, leaseExpiresAt: { lte: now } },
        data: { status: ArtifactDeletionJobStatus.QUEUED, availableAt: now, leaseId: null, leaseExpiresAt: null, startedAt: null, lastError: "Recovered expired artifact deletion lease" },
      });
      if (reset.count === 0) return;
      await transaction.outboxEvent.create({
        data: { topic: ARTIFACT_DELETION_REQUESTED_TOPIC, aggregateId: job.id, payload: { deletionJobId: job.id } },
      });
      recovered += 1;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  const strandedJobs = await input.db.artifactDeletionJob.findMany({
    where: { status: ArtifactDeletionJobStatus.QUEUED, availableAt: { lte: now }, updatedAt: { lte: staleBefore }, artifact: { lifecycleStatus: ArtifactLifecycleStatus.DELETING } },
    select: { id: true, updatedAt: true },
  });
  for (const job of strandedJobs) {
    await input.db.$transaction(async (transaction) => {
      const refreshed = await transaction.artifactDeletionJob.updateMany({
        where: { id: job.id, status: ArtifactDeletionJobStatus.QUEUED, updatedAt: job.updatedAt },
        data: { availableAt: now, lastError: "Reconciled stranded artifact deletion job" },
      });
      if (refreshed.count === 0) return;
      await transaction.outboxEvent.create({
        data: { topic: ARTIFACT_DELETION_REQUESTED_TOPIC, aggregateId: job.id, payload: { deletionJobId: job.id } },
      });
      recovered += 1;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  const repairedResult = await input.db.artifact.updateMany({
    where: { lifecycleStatus: ArtifactLifecycleStatus.DELETING, deletionJob: { status: ArtifactDeletionJobStatus.SUCCEEDED } },
    data: { lifecycleStatus: ArtifactLifecycleStatus.DELETED, deletedAt: now },
  });
  return { recovered, repaired: repairedResult.count };
}

const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, milliseconds);
  signal.addEventListener("abort", done, { once: true });
});

export async function runArtifactDeletionReconciliation(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await reconcileArtifactDeletions();
    } catch (error) {
      logger.error({ error }, "Artifact deletion reconciliation failed");
    }
    if (!signal.aborted) await wait(env.RUN_RECOVERY_POLL_INTERVAL_MS, signal);
  }
}
