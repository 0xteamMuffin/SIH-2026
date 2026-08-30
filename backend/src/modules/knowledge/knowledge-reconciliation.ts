import crypto from "node:crypto";
import {
  KnowledgeIndexStatus,
  KnowledgeJobStatus,
  KnowledgeJobType,
  KnowledgeQueryStatus,
  KnowledgeSourceIndexStatus,
  KnowledgeSourceStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { env } from "../../config/env.js";
import { KNOWLEDGE_JOB_REQUESTED_TOPIC } from "../../infrastructure/queue/knowledge-job-message.js";
import { getQdrantDataPlane } from "../../infrastructure/vector-store/qdrant-data-plane.js";
import type { VectorPointId, VectorStoreDataPlane } from "../../infrastructure/vector-store/vector-store-data-plane.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

const RECONCILIATION_BATCH_SIZE = 100;
const SCROLL_PAGE_SIZE = 250;

type ReconciliationDependencies = {
  db: PrismaClient;
  vectorStore: Pick<VectorStoreDataPlane, "countPoints" | "scrollPoints" | "deleteByKnowledgeSourceId">;
  now: () => Date;
  randomUUID: () => string;
  staleAfterMs: number;
};

type ReconciliationStats = {
  recoveredJobs: number;
  repairedSourceIndexes: number;
  orphanSourcesRemoved: number;
};

let readyCursor: string | undefined;
let readyCursorIndexId: string | undefined;
let orphanCursor: VectorPointId | undefined;
let orphanCursorCollection: string | undefined;

function resolvedDependencies(overrides: Partial<ReconciliationDependencies>): ReconciliationDependencies {
  return {
    db: overrides.db ?? prisma,
    vectorStore: overrides.vectorStore ?? getQdrantDataPlane(),
    now: overrides.now ?? (() => new Date()),
    randomUUID: overrides.randomUUID ?? (() => crypto.randomUUID()),
    staleAfterMs: overrides.staleAfterMs ?? env.RUN_LEASE_DURATION_MS,
  };
}

async function publishJob(transaction: Prisma.TransactionClient, jobId: string): Promise<void> {
  await transaction.outboxEvent.create({
    data: { topic: KNOWLEDGE_JOB_REQUESTED_TOPIC, aggregateId: jobId, payload: { jobId } },
  });
}

async function recoverStaleJobs(input: ReconciliationDependencies, now: Date): Promise<number> {
  const staleJobs = await input.db.knowledgeJob.findMany({
    where: {
      status: KnowledgeJobStatus.RUNNING,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    select: {
      id: true,
      type: true,
      attempts: true,
      maxAttempts: true,
      leaseId: true,
      sourceIndexId: true,
      queryId: true,
      sourceIndex: { select: { source: { select: { status: true } } } },
    },
    take: RECONCILIATION_BATCH_SIZE,
  });
  let recovered = 0;
  for (const job of staleJobs) {
    await input.db.$transaction(async (transaction) => {
      const deletingSource = job.sourceIndex?.source.status === KnowledgeSourceStatus.DELETING;
      const exhausted = job.attempts >= job.maxAttempts;
      const status = deletingSource && job.type === KnowledgeJobType.INDEX_SOURCE
        ? KnowledgeJobStatus.CANCELLED
        : exhausted ? KnowledgeJobStatus.FAILED : KnowledgeJobStatus.QUEUED;
      const updated = await transaction.knowledgeJob.updateMany({
        where: {
          id: job.id,
          status: KnowledgeJobStatus.RUNNING,
          leaseId: job.leaseId,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: {
          status,
          availableAt: now,
          leaseId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          startedAt: status === KnowledgeJobStatus.QUEUED ? null : undefined,
          completedAt: status === KnowledgeJobStatus.QUEUED ? null : now,
          lastError: deletingSource ? "Knowledge source deletion superseded stale indexing" : exhausted
            ? "Knowledge job attempts were exhausted during stale-claim recovery"
            : "Recovered expired knowledge job lease",
        },
      });
      if (updated.count === 0) return;

      if (job.sourceIndexId && job.type === KnowledgeJobType.INDEX_SOURCE) {
        await transaction.knowledgeSourceIndex.updateMany({
          where: { id: job.sourceIndexId, status: KnowledgeSourceIndexStatus.INDEXING, leaseId: job.leaseId },
          data: {
            status: deletingSource ? KnowledgeSourceIndexStatus.REMOVING
              : exhausted ? KnowledgeSourceIndexStatus.FAILED : KnowledgeSourceIndexStatus.PENDING,
            leaseId: null,
            heartbeatAt: null,
            leaseExpiresAt: null,
            lastError: deletingSource ? null : "Recovered expired knowledge indexing lease",
          },
        });
      } else if (job.sourceIndexId && job.type === KnowledgeJobType.REMOVE_SOURCE) {
        await transaction.knowledgeSourceIndex.updateMany({
          where: { id: job.sourceIndexId, status: KnowledgeSourceIndexStatus.REMOVING, leaseId: job.leaseId },
          data: {
            status: exhausted ? KnowledgeSourceIndexStatus.FAILED : KnowledgeSourceIndexStatus.REMOVING,
            leaseId: null,
            heartbeatAt: null,
            leaseExpiresAt: null,
            lastError: exhausted ? "Knowledge source removal attempts were exhausted" : "Recovered expired knowledge source removal lease",
          },
        });
      } else if (job.queryId && job.type === KnowledgeJobType.EXECUTE_QUERY) {
        await transaction.knowledgeQuery.updateMany({
          where: { id: job.queryId, status: KnowledgeQueryStatus.RUNNING },
          data: {
            status: exhausted ? KnowledgeQueryStatus.FAILED : KnowledgeQueryStatus.QUEUED,
            startedAt: exhausted ? undefined : null,
            completedAt: exhausted ? now : null,
            lastError: exhausted ? "Knowledge query attempts were exhausted" : "Recovered expired knowledge query lease",
          },
        });
      }
      if (status === KnowledgeJobStatus.QUEUED) await publishJob(transaction, job.id);
      recovered += 1;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  return recovered;
}

async function republishStrandedJobs(input: ReconciliationDependencies, now: Date): Promise<number> {
  const staleBefore = new Date(now.getTime() - input.staleAfterMs);
  const jobs = await input.db.knowledgeJob.findMany({
    where: { status: KnowledgeJobStatus.QUEUED, availableAt: { lte: now }, updatedAt: { lte: staleBefore } },
    select: { id: true, updatedAt: true },
    take: RECONCILIATION_BATCH_SIZE,
  });
  let recovered = 0;
  for (const job of jobs) {
    await input.db.$transaction(async (transaction) => {
      const refreshed = await transaction.knowledgeJob.updateMany({
        where: { id: job.id, status: KnowledgeJobStatus.QUEUED, updatedAt: job.updatedAt },
        data: { availableAt: now, lastError: "Reconciled stranded knowledge job" },
      });
      if (refreshed.count === 0) return;
      await publishJob(transaction, job.id);
      recovered += 1;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  return recovered;
}

async function ensureRemovalJob(input: ReconciliationDependencies, sourceIndexId: string, now: Date): Promise<boolean> {
  return input.db.$transaction(async (transaction) => {
    const sourceIndex = await transaction.knowledgeSourceIndex.findUnique({
      where: { id: sourceIndexId },
      include: { source: true },
    });
    if (!sourceIndex || sourceIndex.source.status !== KnowledgeSourceStatus.DELETING || sourceIndex.status === KnowledgeSourceIndexStatus.REMOVED) return false;
    const activeIndexJob = await transaction.knowledgeJob.findFirst({
      where: { sourceIndexId, type: KnowledgeJobType.INDEX_SOURCE, status: KnowledgeJobStatus.RUNNING },
      select: { leaseExpiresAt: true },
    });
    if (activeIndexJob?.leaseExpiresAt && activeIndexJob.leaseExpiresAt > now) return false;
    await transaction.knowledgeJob.updateMany({
      where: { sourceIndexId, type: KnowledgeJobType.INDEX_SOURCE, status: { in: [KnowledgeJobStatus.QUEUED, KnowledgeJobStatus.RUNNING] } },
      data: { status: KnowledgeJobStatus.CANCELLED, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt: now, lastError: "Knowledge source deletion superseded indexing" },
    });
    await transaction.knowledgeSourceIndex.update({
      where: { id: sourceIndexId },
      data: { status: KnowledgeSourceIndexStatus.REMOVING, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, lastError: null },
    });
    let removal = await transaction.knowledgeJob.findFirst({
      where: { sourceIndexId, type: KnowledgeJobType.REMOVE_SOURCE },
      orderBy: { createdAt: "desc" },
    });
    if (!removal) {
      const jobId = input.randomUUID();
      removal = await transaction.knowledgeJob.create({
        data: {
          id: jobId,
          workspaceId: sourceIndex.source.workspaceId,
          indexId: sourceIndex.indexId,
          sourceIndexId,
          type: KnowledgeJobType.REMOVE_SOURCE,
          idempotencyKey: `knowledge-source:${sourceIndex.sourceId}:remove:index:${sourceIndex.indexId}`,
        },
      });
    } else if (removal.status === KnowledgeJobStatus.FAILED || removal.status === KnowledgeJobStatus.CANCELLED || removal.status === KnowledgeJobStatus.SUCCEEDED) {
      removal = await transaction.knowledgeJob.update({
        where: { id: removal.id },
        data: { status: KnowledgeJobStatus.QUEUED, attempts: 0, availableAt: now, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, lastError: null, startedAt: null, completedAt: null },
      });
    }
    if (removal.status === KnowledgeJobStatus.QUEUED) await publishJob(transaction, removal.id);
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function repairDeletingSources(input: ReconciliationDependencies, now: Date): Promise<number> {
  const sources = await input.db.knowledgeSource.findMany({
    where: { status: KnowledgeSourceStatus.DELETING },
    select: { id: true, sourceIndexes: { select: { id: true, status: true } } },
    take: RECONCILIATION_BATCH_SIZE,
  });
  let repaired = 0;
  for (const source of sources) {
    if (source.sourceIndexes.length === 0 || source.sourceIndexes.every((entry) => entry.status === KnowledgeSourceIndexStatus.REMOVED)) {
      const completed = await input.db.knowledgeSource.updateMany({
        where: { id: source.id, status: KnowledgeSourceStatus.DELETING },
        data: { status: KnowledgeSourceStatus.DELETED, deletedAt: now },
      });
      repaired += completed.count;
      continue;
    }
    for (const sourceIndex of source.sourceIndexes) {
      if (sourceIndex.status !== KnowledgeSourceIndexStatus.REMOVED && await ensureRemovalJob(input, sourceIndex.id, now)) repaired += 1;
    }
  }
  return repaired;
}

async function queueIndexRepair(input: ReconciliationDependencies, sourceIndexId: string, now: Date): Promise<boolean> {
  return input.db.$transaction(async (transaction) => {
    const sourceIndex = await transaction.knowledgeSourceIndex.findUnique({
      where: { id: sourceIndexId },
      include: { source: true, index: true },
    });
    if (!sourceIndex || sourceIndex.source.status !== KnowledgeSourceStatus.ACTIVE || sourceIndex.index.status !== KnowledgeIndexStatus.ACTIVE) return false;
    const activeJob = await transaction.knowledgeJob.findFirst({
      where: { sourceIndexId, type: KnowledgeJobType.INDEX_SOURCE, status: { in: [KnowledgeJobStatus.QUEUED, KnowledgeJobStatus.RUNNING] } },
      select: { id: true },
    });
    if (activeJob) return false;
    const changed = await transaction.knowledgeSourceIndex.updateMany({
      where: { id: sourceIndex.id, status: sourceIndex.status, updatedAt: sourceIndex.updatedAt },
      data: {
        sourceRevision: sourceIndex.source.revision,
        indexRevision: sourceIndex.index.revision,
        status: KnowledgeSourceIndexStatus.PENDING,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        lastError: "Scheduled by knowledge index reconciliation",
        indexedAt: null,
      },
    });
    if (changed.count === 0) return false;
    const jobId = input.randomUUID();
    await transaction.knowledgeJob.create({
      data: {
        id: jobId,
        workspaceId: sourceIndex.source.workspaceId,
        indexId: sourceIndex.indexId,
        sourceIndexId: sourceIndex.id,
        type: KnowledgeJobType.INDEX_SOURCE,
        idempotencyKey: `knowledge-reconcile:${sourceIndex.id}:${jobId}`,
      },
    });
    await publishJob(transaction, jobId);
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function createMissingSourceIndexes(input: ReconciliationDependencies, indexId: string, indexRevision: number): Promise<number> {
  const sources = await input.db.knowledgeSource.findMany({
    where: { status: KnowledgeSourceStatus.ACTIVE, sourceIndexes: { none: { indexId } } },
    select: { id: true, workspaceId: true, revision: true },
    take: RECONCILIATION_BATCH_SIZE,
  });
  let repaired = 0;
  for (const source of sources) {
    try {
      await input.db.$transaction(async (transaction) => {
        const sourceIndexId = input.randomUUID();
        await transaction.knowledgeSourceIndex.create({
          data: { id: sourceIndexId, sourceId: source.id, indexId, sourceRevision: source.revision, indexRevision },
        });
        const jobId = input.randomUUID();
        await transaction.knowledgeJob.create({
          data: {
            id: jobId,
            workspaceId: source.workspaceId,
            indexId,
            sourceIndexId,
            type: KnowledgeJobType.INDEX_SOURCE,
            idempotencyKey: `knowledge-reconcile:${sourceIndexId}:${jobId}`,
          },
        });
        await publishJob(transaction, jobId);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      repaired += 1;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
  }
  return repaired;
}

async function payloadsMatch(input: ReconciliationDependencies, sourceIndex: {
  sourceId: string;
  sourceRevision: number;
  indexRevision: number;
  chunkCount: number;
  index: { collectionName: string };
}): Promise<boolean> {
  const count = await input.vectorStore.countPoints({ collectionName: sourceIndex.index.collectionName, knowledgeSourceId: sourceIndex.sourceId, exact: true });
  if (count !== sourceIndex.chunkCount) return false;
  let cursor: VectorPointId | undefined;
  let seen = 0;
  do {
    const page = await input.vectorStore.scrollPoints({
      collectionName: sourceIndex.index.collectionName,
      knowledgeSourceId: sourceIndex.sourceId,
      ...(cursor === undefined ? {} : { cursor }),
      limit: SCROLL_PAGE_SIZE,
    });
    for (const point of page.points) {
      seen += 1;
      if (point.payload.knowledge_source_id !== sourceIndex.sourceId
        || point.payload.source_revision !== sourceIndex.sourceRevision
        || point.payload.index_revision !== sourceIndex.indexRevision
        || point.payload.active !== true) return false;
    }
    if (page.nextCursor === undefined || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  } while (seen <= sourceIndex.chunkCount);
  return seen === sourceIndex.chunkCount;
}

async function repairSourceIndexes(input: ReconciliationDependencies, indexId: string, now: Date): Promise<number> {
  const recoverable = await input.db.knowledgeSourceIndex.findMany({
    where: {
      indexId,
      source: { status: KnowledgeSourceStatus.ACTIVE },
      OR: [
        { status: { in: [KnowledgeSourceIndexStatus.PENDING, KnowledgeSourceIndexStatus.STALE] } },
        { status: KnowledgeSourceIndexStatus.INDEXING, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ],
    },
    select: { id: true },
    take: RECONCILIATION_BATCH_SIZE,
  });
  let repaired = 0;
  for (const sourceIndex of recoverable) {
    if (await queueIndexRepair(input, sourceIndex.id, now)) repaired += 1;
  }

  if (readyCursorIndexId !== indexId) {
    readyCursor = undefined;
    readyCursorIndexId = indexId;
  }
  const ready = await input.db.knowledgeSourceIndex.findMany({
    where: { indexId, status: KnowledgeSourceIndexStatus.READY, source: { status: KnowledgeSourceStatus.ACTIVE } },
    include: { index: { select: { collectionName: true } }, source: { select: { revision: true } } },
    orderBy: { id: "asc" },
    ...(readyCursor ? { cursor: { id: readyCursor }, skip: 1 } : {}),
    take: RECONCILIATION_BATCH_SIZE,
  });
  if (ready.length > 0) readyCursor = ready[ready.length - 1]!.id;
  if (ready.length < RECONCILIATION_BATCH_SIZE) readyCursor = undefined;
  for (const sourceIndex of ready) {
    const metadataMatches = sourceIndex.sourceRevision === sourceIndex.source.revision;
    if (!metadataMatches || !(await payloadsMatch(input, sourceIndex))) {
      if (await queueIndexRepair(input, sourceIndex.id, now)) repaired += 1;
    }
  }
  return repaired;
}

async function removeOrphanPoints(input: ReconciliationDependencies, collectionName: string): Promise<number> {
  if (orphanCursorCollection !== collectionName) {
    orphanCursor = undefined;
    orphanCursorCollection = collectionName;
  }
  const page = await input.vectorStore.scrollPoints({
    collectionName,
    ...(orphanCursor === undefined ? {} : { cursor: orphanCursor }),
    limit: SCROLL_PAGE_SIZE,
  });
  orphanCursor = page.nextCursor;
  const sourceIds = [...new Set(page.points.map((point) => point.payload.knowledge_source_id)
    .filter((value): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)))];
  if (sourceIds.length === 0) return 0;
  const sources = await input.db.knowledgeSource.findMany({ where: { id: { in: sourceIds } }, select: { id: true, status: true } });
  const sourceById = new Map(sources.map((source) => [source.id, source.status]));
  const orphanIds = sourceIds.filter((sourceId) => {
    const status = sourceById.get(sourceId);
    return status === undefined || status === KnowledgeSourceStatus.DELETED || status === KnowledgeSourceStatus.ARCHIVED;
  });
  for (const sourceId of orphanIds) {
    await input.vectorStore.deleteByKnowledgeSourceId({ collectionName, knowledgeSourceId: sourceId });
  }
  return orphanIds.length;
}

export async function reconcileKnowledgeLifecycle(overrides: Partial<ReconciliationDependencies> = {}): Promise<ReconciliationStats> {
  const input = resolvedDependencies(overrides);
  const now = input.now();
  const recoveredJobs = await recoverStaleJobs(input, now) + await republishStrandedJobs(input, now);
  let repairedSourceIndexes = await repairDeletingSources(input, now);
  const index = await input.db.knowledgeIndex.findFirst({
    where: { status: KnowledgeIndexStatus.ACTIVE },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!index) return { recoveredJobs, repairedSourceIndexes, orphanSourcesRemoved: 0 };
  repairedSourceIndexes += await createMissingSourceIndexes(input, index.id, index.revision);
  repairedSourceIndexes += await repairSourceIndexes(input, index.id, now);
  const orphanSourcesRemoved = await removeOrphanPoints(input, index.collectionName);
  return { recoveredJobs, repairedSourceIndexes, orphanSourcesRemoved };
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

export async function runKnowledgeReconciliation(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await reconcileKnowledgeLifecycle();
      if (result.recoveredJobs > 0 || result.repairedSourceIndexes > 0 || result.orphanSourcesRemoved > 0) {
        logger.warn(result, "Reconciled knowledge lifecycle");
      }
    } catch (error) {
      logger.error({ error }, "Knowledge reconciliation failed");
    }
    if (!signal.aborted) await wait(env.KNOWLEDGE_RECONCILIATION_INTERVAL_MS, signal);
  }
}
