import crypto from "node:crypto";
import {
  ArtifactExtractionStatus,
  ArtifactKind,
  DataClassification,
  KnowledgeIndexStatus,
  KnowledgeJobStatus,
  KnowledgeJobType,
  KnowledgeSourceIndexStatus,
  KnowledgeSourceStatus,
  KnowledgeVisibility,
  Prisma,
  UserRole,
} from "@prisma/client";
import { KNOWLEDGE_JOB_REQUESTED_TOPIC } from "../../infrastructure/queue/knowledge-job-message.js";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../middleware/auth.js";

const artifactSummarySelect = {
  id: true,
  workspaceId: true,
  createdBy: true,
  kind: true,
  classification: true,
  extractionStatus: true,
  filename: true,
  mimeType: true,
  detectedMimeType: true,
  sizeBytes: true,
  createdAt: true,
} satisfies Prisma.ArtifactSelect;

const sourceInclude = {
  artifact: { select: artifactSummarySelect },
  sourceIndexes: {
    include: { index: true },
    orderBy: { createdAt: "desc" as const },
  },
} satisfies Prisma.KnowledgeSourceInclude;

const queryInclude = {
  index: true,
  job: true,
} satisfies Prisma.KnowledgeQueryInclude;

export type KnowledgeCursor = { createdAt: Date; id: string };
export type KnowledgeQueryFilters = {
  artifactIds?: string[];
  classifications?: DataClassification[];
  scoreThreshold?: number;
};

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]));
}

function encodeCursor(source: { createdAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: source.createdAt.toISOString(), id: source.id })).toString("base64url");
}

async function activeIndex(transaction: Prisma.TransactionClient) {
  const index = await transaction.knowledgeIndex.findFirst({
    where: { status: KnowledgeIndexStatus.ACTIVE },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!index) throw new AppError(503, "No active knowledge index is available", "KNOWLEDGE_INDEX_UNAVAILABLE");
  return index;
}

function readableSourceWhere(sourceId: string, actor: Pick<AuthUser, "id" | "role">): Prisma.KnowledgeSourceWhereInput {
  if (actor.role === "ADMIN") return { id: sourceId };
  return {
    id: sourceId,
    OR: [
      { visibility: KnowledgeVisibility.ORGANIZATION_SHARED },
      { workspace: { members: { some: { userId: actor.id } } } },
    ],
  };
}

function mutableSourceWhere(sourceId: string, actor: Pick<AuthUser, "id" | "role">): Prisma.KnowledgeSourceWhereInput {
  return actor.role === "ADMIN"
    ? { id: sourceId }
    : { id: sourceId, workspace: { members: { some: { userId: actor.id, role: { in: [UserRole.ADMIN, UserRole.OPERATOR] } } } } };
}

function readableQueryWhere(queryId: string, actor: Pick<AuthUser, "id" | "role">): Prisma.KnowledgeQueryWhereInput {
  return actor.role === "ADMIN"
    ? { id: queryId }
    : { id: queryId, workspace: { members: { some: { userId: actor.id } } } };
}

function validateSourceArtifact(artifact: { kind: ArtifactKind; extractionStatus: ArtifactExtractionStatus }) {
  if (artifact.kind !== ArtifactKind.SOURCE) {
    throw new AppError(400, "Knowledge sources require a source artifact", "INVALID_ARTIFACT");
  }
  if (artifact.extractionStatus !== ArtifactExtractionStatus.COMPLETED) {
    throw new AppError(409, "Artifact extraction must be completed", "ARTIFACT_NOT_READY");
  }
}

export async function createKnowledgeSource(input: {
  workspaceId: string;
  artifactId: string;
  actor: Pick<AuthUser, "id" | "role">;
  visibility: KnowledgeVisibility;
}) {
  if (input.visibility === KnowledgeVisibility.ORGANIZATION_SHARED && input.actor.role !== "ADMIN") {
    throw new AppError(403, "Only administrators may create organization-shared knowledge", "FORBIDDEN");
  }

  try {
    const result = await prisma.$transaction(async (transaction) => {
      const artifact = await transaction.artifact.findFirst({
        where: { id: input.artifactId, workspaceId: input.workspaceId },
        select: artifactSummarySelect,
      });
      if (!artifact) throw new AppError(400, "Artifact is unavailable in this workspace", "INVALID_ARTIFACT");
      validateSourceArtifact(artifact);

      const existing = await transaction.knowledgeSource.findUnique({ where: { artifactId: input.artifactId }, select: { id: true } });
      if (existing) throw new AppError(409, "Artifact is already a knowledge source", "KNOWLEDGE_SOURCE_EXISTS");

      const index = await activeIndex(transaction);
      const sourceId = crypto.randomUUID();
      const sourceIndexId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      const source = await transaction.knowledgeSource.create({
        data: {
          id: sourceId,
          workspaceId: input.workspaceId,
          artifactId: input.artifactId,
          createdBy: input.actor.id,
          visibility: input.visibility,
        },
      });
      const sourceIndex = await transaction.knowledgeSourceIndex.create({
        data: {
          id: sourceIndexId,
          sourceId,
          indexId: index.id,
          sourceRevision: source.revision,
          indexRevision: index.revision,
        },
      });
      const job = await transaction.knowledgeJob.create({
        data: {
          id: jobId,
          workspaceId: input.workspaceId,
          indexId: index.id,
          sourceIndexId,
          type: KnowledgeJobType.INDEX_SOURCE,
          idempotencyKey: `knowledge-source:${sourceId}:revision:${source.revision}:index:${index.id}:${index.revision}`,
        },
      });
      await transaction.outboxEvent.create({
        data: { topic: KNOWLEDGE_JOB_REQUESTED_TOPIC, aggregateId: jobId, payload: { jobId } },
      });
      return { knowledgeSource: { ...source, artifact, sourceIndexes: [sourceIndex] }, job };
    });
    return jsonSafe(result) as { knowledgeSource: Record<string, unknown>; job: Record<string, unknown> };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "Artifact is already a knowledge source", "KNOWLEDGE_SOURCE_EXISTS");
    }
    throw error;
  }
}

export async function listKnowledgeSources(input: {
  workspaceId: string;
  limit: number;
  cursor?: KnowledgeCursor;
  visibility?: KnowledgeVisibility;
  status?: KnowledgeSourceStatus;
}) {
  const visibilityScope: Prisma.KnowledgeSourceWhereInput = input.visibility
    ? { visibility: input.visibility, ...(input.visibility === KnowledgeVisibility.WORKSPACE_PRIVATE ? { workspaceId: input.workspaceId } : {}) }
    : { OR: [{ workspaceId: input.workspaceId }, { visibility: KnowledgeVisibility.ORGANIZATION_SHARED }] };
  const sources = await prisma.knowledgeSource.findMany({
    where: {
      ...visibilityScope,
      status: input.status ?? { not: KnowledgeSourceStatus.DELETED },
      ...(input.cursor ? {
        AND: [{
          OR: [
            { createdAt: { lt: input.cursor.createdAt } },
            { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
          ],
        }],
      } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    include: sourceInclude,
  });
  const page = sources.slice(0, input.limit);
  return {
    knowledgeSources: jsonSafe(page) as Record<string, unknown>[],
    nextCursor: sources.length > input.limit ? encodeCursor(page[page.length - 1]!) : null,
  };
}

export async function getKnowledgeSource(sourceId: string, actor: Pick<AuthUser, "id" | "role">) {
  const source = await prisma.knowledgeSource.findFirst({ where: readableSourceWhere(sourceId, actor), include: sourceInclude });
  return source ? jsonSafe(source) as Record<string, unknown> : null;
}

export async function reindexKnowledgeSource(sourceId: string, actor: Pick<AuthUser, "id" | "role">) {
  const result = await prisma.$transaction(async (transaction) => {
    const source = await transaction.knowledgeSource.findFirst({
      where: mutableSourceWhere(sourceId, actor),
      include: { artifact: { select: artifactSummarySelect } },
    });
    if (!source) throw new AppError(404, "Knowledge source not found", "NOT_FOUND");
    if (source.status !== KnowledgeSourceStatus.ACTIVE) {
      throw new AppError(409, "Knowledge source is not active", "KNOWLEDGE_SOURCE_NOT_ACTIVE");
    }
    validateSourceArtifact(source.artifact);

    const index = await activeIndex(transaction);
    const existingSourceIndex = await transaction.knowledgeSourceIndex.findUnique({
      where: { sourceId_indexId: { sourceId, indexId: index.id } },
    });
    if (existingSourceIndex && (existingSourceIndex.status === KnowledgeSourceIndexStatus.PENDING || existingSourceIndex.status === KnowledgeSourceIndexStatus.INDEXING)) {
      throw new AppError(409, "Knowledge source indexing is already in progress", "KNOWLEDGE_INDEXING_IN_PROGRESS");
    }
    if (existingSourceIndex) {
      const activeJob = await transaction.knowledgeJob.findFirst({
        where: { sourceIndexId: existingSourceIndex.id, status: { in: [KnowledgeJobStatus.QUEUED, KnowledgeJobStatus.RUNNING] } },
        select: { id: true },
      });
      if (activeJob) throw new AppError(409, "Knowledge source indexing is already in progress", "KNOWLEDGE_INDEXING_IN_PROGRESS");
    }

    const updatedSource = await transaction.knowledgeSource.update({
      where: { id: sourceId },
      data: { revision: { increment: 1 } },
    });
    const sourceIndex = existingSourceIndex
      ? await transaction.knowledgeSourceIndex.update({
        where: { id: existingSourceIndex.id },
        data: {
          sourceRevision: updatedSource.revision,
          indexRevision: index.revision,
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
      })
      : await transaction.knowledgeSourceIndex.create({
        data: {
          id: crypto.randomUUID(),
          sourceId,
          indexId: index.id,
          sourceRevision: updatedSource.revision,
          indexRevision: index.revision,
        },
      });
    const jobId = crypto.randomUUID();
    const job = await transaction.knowledgeJob.create({
      data: {
        id: jobId,
        workspaceId: source.workspaceId,
        indexId: index.id,
        sourceIndexId: sourceIndex.id,
        type: KnowledgeJobType.INDEX_SOURCE,
        idempotencyKey: `knowledge-source:${sourceId}:revision:${updatedSource.revision}:index:${index.id}:${index.revision}`,
      },
    });
    await transaction.outboxEvent.create({
      data: { topic: KNOWLEDGE_JOB_REQUESTED_TOPIC, aggregateId: jobId, payload: { jobId } },
    });
    return { knowledgeSource: { ...updatedSource, artifact: source.artifact, sourceIndexes: [sourceIndex] }, job };
  });
  return jsonSafe(result) as { knowledgeSource: Record<string, unknown>; job: Record<string, unknown> };
}

export async function createKnowledgeQuery(input: {
  workspaceId: string;
  userId: string;
  queryText: string;
  topK: number;
  filters: KnowledgeQueryFilters;
  dataClassification: DataClassification;
}) {
  const result = await prisma.$transaction(async (transaction) => {
    const workspace = await transaction.workspace.findUnique({ where: { id: input.workspaceId }, select: { id: true } });
    if (!workspace) throw new AppError(404, "Workspace not found", "NOT_FOUND");
    const index = await activeIndex(transaction);
    const queryId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const knowledgeQuery = await transaction.knowledgeQuery.create({
      data: {
        id: queryId,
        workspaceId: input.workspaceId,
        requestedBy: input.userId,
        indexId: index.id,
        indexRevision: index.revision,
        dataClassification: input.dataClassification,
        queryText: input.queryText,
        topK: input.topK,
        filters: input.filters as Prisma.InputJsonObject,
      },
    });
    const job = await transaction.knowledgeJob.create({
      data: {
        id: jobId,
        workspaceId: input.workspaceId,
        indexId: index.id,
        queryId,
        type: KnowledgeJobType.EXECUTE_QUERY,
        idempotencyKey: `knowledge-query:${queryId}`,
      },
    });
    await transaction.outboxEvent.create({
      data: { topic: KNOWLEDGE_JOB_REQUESTED_TOPIC, aggregateId: jobId, payload: { jobId } },
    });
    return { knowledgeQuery, job };
  });
  return jsonSafe(result) as { knowledgeQuery: Record<string, unknown>; job: Record<string, unknown> };
}

export async function getKnowledgeQuery(queryId: string, actor: Pick<AuthUser, "id" | "role">) {
  const query = await prisma.knowledgeQuery.findFirst({ where: readableQueryWhere(queryId, actor), include: queryInclude });
  return query ? jsonSafe(query) as Record<string, unknown> : null;
}
