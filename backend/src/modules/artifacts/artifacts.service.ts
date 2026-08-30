import crypto from "node:crypto";
import { ArtifactDeletionJobStatus, ArtifactExtractionStatus, ArtifactKind, ArtifactLifecycleStatus, DataClassification, KnowledgeJobStatus, KnowledgeSourceStatus, Prisma, RunStatus } from "@prisma/client";
import type { AuthUser } from "../../middleware/auth.js";
import { prisma } from "../../lib/prisma.js";
import { deleteObject, putArtifact, getArtifact, getArtifactBounded } from "../../infrastructure/storage/artifact-store.js";
import { AppError } from "../../lib/errors.js";
import { ARTIFACT_DELETION_REQUESTED_TOPIC } from "../../infrastructure/queue/artifact-deletion-message.js";

const artifactMetadataSelect = {
  id: true,
  workspaceId: true,
  createdBy: true,
  kind: true,
  classification: true,
  sha256: true,
  detectedMimeType: true,
  extractionStatus: true,
  extractionMetadata: true,
  extractionError: true,
  extractionStartedAt: true,
  extractedAt: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  versionSetId: true,
  version: true,
  previousVersionId: true,
  lifecycleStatus: true,
  retentionUntil: true,
  deletionRequestedAt: true,
  deletedAt: true,
  createdAt: true,
} satisfies Prisma.ArtifactSelect;

type ArtifactMetadataRow = Prisma.ArtifactGetPayload<{ select: typeof artifactMetadataSelect }>;
export type ArtifactCursor = { createdAt: Date; id: string };

function serializeArtifact<T extends { sizeBytes: bigint }>(artifact: T) {
  return { ...artifact, sizeBytes: artifact.sizeBytes.toString() };
}

function encodeCursor(artifact: Pick<ArtifactMetadataRow, "createdAt" | "id">) {
  return Buffer.from(JSON.stringify({ createdAt: artifact.createdAt.toISOString(), id: artifact.id })).toString("base64url");
}

export async function createArtifact(input: { workspaceId: string; userId: string; filename: string; mimeType: string; kind: ArtifactKind; classification?: DataClassification; detectedMimeType?: string; bytes: Buffer; idempotencyKey?: string; previousArtifactId?: string; retentionUntil?: Date }) {
  const key = input.idempotencyKey?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? crypto.randomUUID();
  const objectKey = `${input.workspaceId}/${key}-${input.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  if (input.idempotencyKey) {
    const existing = await prisma.artifact.findUnique({ where: { objectKey } });
    if (existing) return { ...existing, sizeBytes: Number(existing.sizeBytes) };
  }
  const artifactId = crypto.randomUUID();
  const previous = input.previousArtifactId
    ? await prisma.artifact.findFirst({
      where: { id: input.previousArtifactId, workspaceId: input.workspaceId, kind: input.kind },
      select: { id: true, versionSetId: true, version: true, lifecycleStatus: true, nextVersion: { select: { id: true } } },
    })
    : null;
  if (input.previousArtifactId && !previous) throw new AppError(400, "Previous artifact version is unavailable in this workspace", "INVALID_ARTIFACT_VERSION");
  if (previous && previous.lifecycleStatus !== ArtifactLifecycleStatus.ACTIVE) throw new AppError(409, "Previous artifact version is not active", "ARTIFACT_VERSION_NOT_ACTIVE");
  if (previous?.nextVersion) throw new AppError(409, "Previous artifact already has a newer version", "ARTIFACT_VERSION_CONFLICT");

  await putArtifact(objectKey, input.bytes, input.mimeType);
  const data = { id: artifactId, workspaceId: input.workspaceId, createdBy: input.userId, kind: input.kind, classification: input.classification ?? DataClassification.INTERNAL, sha256: crypto.createHash("sha256").update(input.bytes).digest("hex"), detectedMimeType: input.detectedMimeType ?? input.mimeType, extractionStatus: input.kind === "SOURCE" ? ArtifactExtractionStatus.PENDING : ArtifactExtractionStatus.NOT_REQUIRED, filename: input.filename, mimeType: input.mimeType, objectKey, sizeBytes: BigInt(input.bytes.byteLength), versionSetId: previous?.versionSetId ?? artifactId, version: previous ? previous.version + 1 : 1, previousVersionId: previous?.id, retentionUntil: input.retentionUntil };
  let artifact;
  try {
    artifact = input.idempotencyKey
      ? await prisma.artifact.upsert({ where: { objectKey }, create: data, update: {} })
      : await prisma.artifact.create({ data });
  } catch (error) {
    await deleteObject(objectKey).catch(() => undefined);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && input.previousArtifactId) {
      throw new AppError(409, "Previous artifact already has a newer version", "ARTIFACT_VERSION_CONFLICT");
    }
    throw error;
  }
  // BigInt is not JSON-serializable by default; convert to plain object with sizeBytes as Number.
  return { ...artifact, sizeBytes: Number(artifact.sizeBytes) };
}

export async function findArtifact(id: string) {
  return prisma.artifact.findUnique({ where: { id } });
}

export async function listArtifacts(input: { workspaceId: string; limit: number; kind?: ArtifactKind; extractionStatus?: ArtifactExtractionStatus; lifecycleStatus?: ArtifactLifecycleStatus; cursor?: ArtifactCursor }) {
  const artifacts = await prisma.artifact.findMany({
    where: {
      workspaceId: input.workspaceId,
      kind: input.kind,
      extractionStatus: input.extractionStatus,
      lifecycleStatus: input.lifecycleStatus ?? { not: ArtifactLifecycleStatus.DELETED },
      ...(input.cursor ? {
        OR: [
          { createdAt: { lt: input.cursor.createdAt } },
          { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
        ],
      } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: artifactMetadataSelect,
  });
  const page = artifacts.slice(0, input.limit);
  return {
    artifacts: page.map(serializeArtifact),
    nextCursor: artifacts.length > input.limit ? encodeCursor(page[page.length - 1]!) : null,
  };
}

export async function requestArtifactDeletion(input: { workspaceId: string; artifactId: string; requestedBy: string; now?: Date }) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (transaction) => {
    const artifact = await transaction.artifact.findFirst({
      where: { id: input.artifactId, workspaceId: input.workspaceId },
      include: {
        deletionJob: true,
        knowledgeSource: {
          select: {
            id: true,
            status: true,
            sourceIndexes: {
              where: { jobs: { some: { status: { in: [KnowledgeJobStatus.QUEUED, KnowledgeJobStatus.RUNNING] } } } },
              select: { id: true },
            },
          },
        },
      },
    });
    if (!artifact) throw new AppError(404, "Artifact not found", "NOT_FOUND");
    if (artifact.lifecycleStatus !== ArtifactLifecycleStatus.ACTIVE) {
      if (!artifact.deletionJob) throw new AppError(409, "Artifact deletion state is invalid", "ARTIFACT_DELETION_STATE_INVALID");
      if (artifact.lifecycleStatus === ArtifactLifecycleStatus.DELETING && artifact.deletionJob.status === ArtifactDeletionJobStatus.FAILED) {
        const deletionJob = await transaction.artifactDeletionJob.update({
          where: { id: artifact.deletionJob.id },
          data: { status: ArtifactDeletionJobStatus.QUEUED, attempts: 0, availableAt: now, leaseId: null, leaseExpiresAt: null, lastError: null, startedAt: null, completedAt: null },
        });
        await transaction.outboxEvent.create({
          data: { topic: ARTIFACT_DELETION_REQUESTED_TOPIC, aggregateId: deletionJob.id, payload: { deletionJobId: deletionJob.id } },
        });
        return { artifact: serializeArtifact(artifact), deletionJob };
      }
      return { artifact: serializeArtifact(artifact), deletionJob: artifact.deletionJob };
    }
    if (artifact.retentionUntil && artifact.retentionUntil > now) {
      throw new AppError(409, "Artifact retention period has not expired", "ARTIFACT_RETENTION_ACTIVE");
    }
    if (artifact.extractionStatus === ArtifactExtractionStatus.PROCESSING) {
      throw new AppError(409, "Artifact extraction is in progress", "ARTIFACT_EXTRACTION_BLOCKED");
    }
    const activeRuns = await transaction.agentRun.count({
      where: { sourceArtifactId: artifact.id, status: { in: [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.WAITING_APPROVAL] } },
    });
    if (activeRuns > 0) throw new AppError(409, "Artifact is referenced by a nonterminal run", "ARTIFACT_RUN_BLOCKED");
    if (artifact.knowledgeSource?.status === KnowledgeSourceStatus.ACTIVE) {
      throw new AppError(409, "Artifact is an active knowledge source", "ARTIFACT_KNOWLEDGE_SOURCE_BLOCKED");
    }
    if (artifact.knowledgeSource && artifact.knowledgeSource.sourceIndexes.length > 0) {
      throw new AppError(409, "Artifact knowledge cleanup is still in progress", "ARTIFACT_KNOWLEDGE_JOB_BLOCKED");
    }

    const deletionJobId = crypto.randomUUID();
    const transitioned = await transaction.artifact.updateMany({
      where: { id: artifact.id, lifecycleStatus: ArtifactLifecycleStatus.ACTIVE, extractionStatus: { not: ArtifactExtractionStatus.PROCESSING } },
      data: { lifecycleStatus: ArtifactLifecycleStatus.DELETING, deletionRequestedAt: now },
    });
    if (transitioned.count !== 1) throw new AppError(409, "Artifact state changed before deletion could start", "ARTIFACT_DELETION_CONFLICT");
    if (artifact.knowledgeSource && artifact.knowledgeSource.status !== KnowledgeSourceStatus.DELETED) {
      await transaction.knowledgeSource.update({ where: { id: artifact.knowledgeSource.id }, data: { status: KnowledgeSourceStatus.DELETING } });
    }
    const deletionJob = await transaction.artifactDeletionJob.create({
      data: { id: deletionJobId, artifactId: artifact.id, requestedBy: input.requestedBy },
    });
    await transaction.outboxEvent.create({
      data: { topic: ARTIFACT_DELETION_REQUESTED_TOPIC, aggregateId: deletionJobId, payload: { deletionJobId } },
    });
    await transaction.auditEvent.create({
      data: { actorId: input.requestedBy, workspaceId: input.workspaceId, eventType: "ARTIFACT_DELETION_REQUESTED", metadata: { artifactId: artifact.id, deletionJobId } },
    });
    return { artifact: serializeArtifact({ ...artifact, lifecycleStatus: ArtifactLifecycleStatus.DELETING, deletionRequestedAt: now }), deletionJob };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function getArtifactMetadata(artifactId: string, actor: Pick<AuthUser, "id" | "role">) {
  const artifact = await prisma.artifact.findFirst({
    where: actor.role === "ADMIN"
      ? { id: artifactId }
      : { id: artifactId, workspace: { members: { some: { userId: actor.id } } } },
    select: artifactMetadataSelect,
  });
  return artifact ? serializeArtifact(artifact) : null;
}

export { getArtifact, getArtifactBounded };
