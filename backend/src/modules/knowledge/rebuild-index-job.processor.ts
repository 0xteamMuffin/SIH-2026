import crypto from "node:crypto";
import { KnowledgeIndexStatus, KnowledgeJobStatus, KnowledgeJobType, KnowledgeSourceIndexStatus, KnowledgeSourceStatus, Prisma, type PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { KNOWLEDGE_JOB_REQUESTED_TOPIC } from "../../infrastructure/queue/knowledge-job-message.js";
import { prisma } from "../../lib/prisma.js";

type RebuildDependencies = {
  db: PrismaClient;
  now: () => Date;
  randomUUID: () => string;
  leaseDurationMs: number;
};

export async function processRebuildIndexJob(jobId: string, overrides: Partial<RebuildDependencies> = {}): Promise<void> {
  const input: RebuildDependencies = {
    db: overrides.db ?? prisma,
    now: overrides.now ?? (() => new Date()),
    randomUUID: overrides.randomUUID ?? (() => crypto.randomUUID()),
    leaseDurationMs: overrides.leaseDurationMs ?? env.RUN_LEASE_DURATION_MS,
  };
  const now = input.now();
  const leaseId = input.randomUUID();
  const candidate = await input.db.knowledgeJob.findUnique({ where: { id: jobId }, include: { index: true } });
  if (!candidate || candidate.type !== KnowledgeJobType.REBUILD_INDEX || candidate.status !== KnowledgeJobStatus.QUEUED || candidate.availableAt > now) return;
  if (candidate.attempts >= candidate.maxAttempts || candidate.index.status !== KnowledgeIndexStatus.ACTIVE) {
    await input.db.knowledgeJob.updateMany({
      where: { id: candidate.id, status: KnowledgeJobStatus.QUEUED },
      data: { status: KnowledgeJobStatus.FAILED, completedAt: now, lastError: "The requested knowledge index is not active or rebuild attempts are exhausted" },
    });
    return;
  }
  const claimed = await input.db.knowledgeJob.updateMany({
    where: { id: candidate.id, status: KnowledgeJobStatus.QUEUED, attempts: candidate.attempts, availableAt: { lte: now } },
    data: {
      status: KnowledgeJobStatus.RUNNING,
      attempts: { increment: 1 },
      leaseId,
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs),
      startedAt: candidate.startedAt ?? now,
      completedAt: null,
      lastError: null,
    },
  });
  if (claimed.count === 0) return;

  try {
    let cursor: string | undefined;
    do {
      const sources = await input.db.knowledgeSource.findMany({
        where: { status: KnowledgeSourceStatus.ACTIVE },
        select: { id: true },
        orderBy: { id: "asc" },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: 100,
      });
      for (const source of sources) {
        await input.db.$transaction(async (transaction) => {
          const current = await transaction.knowledgeSource.findFirst({
            where: { id: source.id, status: KnowledgeSourceStatus.ACTIVE },
            select: { id: true, workspaceId: true, revision: true },
          });
          if (!current) return;
          let sourceIndex = await transaction.knowledgeSourceIndex.findUnique({
            where: { sourceId_indexId: { sourceId: current.id, indexId: candidate.indexId } },
          });
          const idempotencyKey = `knowledge-rebuild:${candidate.id}:source:${current.id}`;
          const existingChild = await transaction.knowledgeJob.findUnique({ where: { idempotencyKey } });
          if (existingChild) {
            if (sourceIndex && (existingChild.status === KnowledgeJobStatus.FAILED || existingChild.status === KnowledgeJobStatus.CANCELLED)) {
              sourceIndex = await transaction.knowledgeSourceIndex.update({
                where: { id: sourceIndex.id },
                data: { status: KnowledgeSourceIndexStatus.PENDING, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, lastError: null, indexedAt: null },
              });
              await transaction.knowledgeJob.update({
                where: { id: existingChild.id },
                data: { status: KnowledgeJobStatus.QUEUED, attempts: 0, availableAt: input.now(), leaseId: null, heartbeatAt: null, leaseExpiresAt: null, lastError: null, startedAt: null, completedAt: null },
              });
              await transaction.outboxEvent.create({
                data: { topic: KNOWLEDGE_JOB_REQUESTED_TOPIC, aggregateId: existingChild.id, payload: { jobId: existingChild.id } },
              });
            }
            return;
          }
          const activeJob = sourceIndex ? await transaction.knowledgeJob.findFirst({
            where: { sourceIndexId: sourceIndex.id, type: KnowledgeJobType.INDEX_SOURCE, status: { in: [KnowledgeJobStatus.QUEUED, KnowledgeJobStatus.RUNNING] } },
            select: { id: true },
          }) : null;
          if (activeJob) return;
          if (!sourceIndex) {
            sourceIndex = await transaction.knowledgeSourceIndex.create({
              data: {
                id: input.randomUUID(),
                sourceId: current.id,
                indexId: candidate.indexId,
                sourceRevision: current.revision,
                indexRevision: candidate.index.revision,
              },
            });
          } else {
            sourceIndex = await transaction.knowledgeSourceIndex.update({
              where: { id: sourceIndex.id },
              data: {
                sourceRevision: current.revision,
                indexRevision: candidate.index.revision,
                status: KnowledgeSourceIndexStatus.PENDING,
                chunkCount: 0,
                sourceChecksum: null,
                chunkSetChecksum: null,
                leaseId: null,
                heartbeatAt: null,
                leaseExpiresAt: null,
                lastError: null,
                indexedAt: null,
              },
            });
          }
          const childJobId = input.randomUUID();
          await transaction.knowledgeJob.create({
            data: {
              id: childJobId,
              workspaceId: current.workspaceId,
              indexId: candidate.indexId,
              sourceIndexId: sourceIndex.id,
              type: KnowledgeJobType.INDEX_SOURCE,
              idempotencyKey,
            },
          });
          await transaction.outboxEvent.create({
            data: { topic: KNOWLEDGE_JOB_REQUESTED_TOPIC, aggregateId: childJobId, payload: { jobId: childJobId } },
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      }
      const heartbeatAt = input.now();
      const renewed = await input.db.knowledgeJob.updateMany({
        where: { id: candidate.id, status: KnowledgeJobStatus.RUNNING, leaseId },
        data: { heartbeatAt, leaseExpiresAt: new Date(heartbeatAt.getTime() + input.leaseDurationMs) },
      });
      if (renewed.count === 0) throw new Error("Knowledge index rebuild lease was lost");
      cursor = sources.length === 100 ? sources[sources.length - 1]!.id : undefined;
    } while (cursor);

    const completed = await input.db.knowledgeJob.updateMany({
      where: { id: candidate.id, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: { status: KnowledgeJobStatus.SUCCEEDED, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt: input.now(), lastError: null },
    });
    if (completed.count === 0) throw new Error("Knowledge index rebuild lease was lost");
  } catch (error) {
    await input.db.knowledgeJob.updateMany({
      where: { id: candidate.id, status: KnowledgeJobStatus.RUNNING, leaseId },
      data: {
        status: KnowledgeJobStatus.QUEUED,
        leaseId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        startedAt: null,
        lastError: error instanceof Error ? error.message.slice(0, 2_000) : "Knowledge index rebuild failed",
      },
    });
    throw error;
  }
}
