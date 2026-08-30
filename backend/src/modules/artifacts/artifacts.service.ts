import crypto from "node:crypto";
import { ArtifactExtractionStatus, DataClassification } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { putArtifact, getArtifact } from "../../infrastructure/storage/artifact-store.js";

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

export { getArtifact };
