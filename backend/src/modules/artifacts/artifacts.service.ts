import crypto from "node:crypto";
import { ArtifactExtractionStatus, ArtifactKind, DataClassification, Prisma } from "@prisma/client";
import type { AuthUser } from "../../middleware/auth.js";
import { prisma } from "../../lib/prisma.js";
import { putArtifact, getArtifact, getArtifactBounded } from "../../infrastructure/storage/artifact-store.js";

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
  createdAt: true,
} satisfies Prisma.ArtifactSelect;

type ArtifactMetadataRow = Prisma.ArtifactGetPayload<{ select: typeof artifactMetadataSelect }>;
export type ArtifactCursor = { createdAt: Date; id: string };

function serializeArtifact(artifact: ArtifactMetadataRow) {
  return { ...artifact, sizeBytes: artifact.sizeBytes.toString() };
}

function encodeCursor(artifact: Pick<ArtifactMetadataRow, "createdAt" | "id">) {
  return Buffer.from(JSON.stringify({ createdAt: artifact.createdAt.toISOString(), id: artifact.id })).toString("base64url");
}

export async function createArtifact(input: { workspaceId: string; userId: string; filename: string; mimeType: string; kind: "SOURCE" | "GENERATED_DOCX" | "CODE_OUTPUT"; classification?: DataClassification; detectedMimeType?: string; bytes: Buffer; idempotencyKey?: string }) {
  const key = input.idempotencyKey?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? crypto.randomUUID();
  const objectKey = `${input.workspaceId}/${key}-${input.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  if (input.idempotencyKey) {
    const existing = await prisma.artifact.findUnique({ where: { objectKey } });
    if (existing) return { ...existing, sizeBytes: Number(existing.sizeBytes) };
  }
  await putArtifact(objectKey, input.bytes, input.mimeType);
  const data = { workspaceId: input.workspaceId, createdBy: input.userId, kind: input.kind, classification: input.classification ?? DataClassification.INTERNAL, sha256: crypto.createHash("sha256").update(input.bytes).digest("hex"), detectedMimeType: input.detectedMimeType ?? input.mimeType, extractionStatus: input.kind === "SOURCE" ? ArtifactExtractionStatus.PENDING : ArtifactExtractionStatus.NOT_REQUIRED, filename: input.filename, mimeType: input.mimeType, objectKey, sizeBytes: BigInt(input.bytes.byteLength) };
  const artifact = input.idempotencyKey
    ? await prisma.artifact.upsert({ where: { objectKey }, create: data, update: {} })
    : await prisma.artifact.create({ data });
  // BigInt is not JSON-serializable by default; convert to plain object with sizeBytes as Number.
  return { ...artifact, sizeBytes: Number(artifact.sizeBytes) };
}

export async function findArtifact(id: string) {
  return prisma.artifact.findUnique({ where: { id } });
}

export async function listArtifacts(input: { workspaceId: string; limit: number; kind?: ArtifactKind; extractionStatus?: ArtifactExtractionStatus; cursor?: ArtifactCursor }) {
  const artifacts = await prisma.artifact.findMany({
    where: {
      workspaceId: input.workspaceId,
      kind: input.kind,
      extractionStatus: input.extractionStatus,
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
