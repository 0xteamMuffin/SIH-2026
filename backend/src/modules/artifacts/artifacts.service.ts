import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { putArtifact, getArtifact } from "../../infrastructure/storage/artifact-store.js";

export async function createArtifact(input: { workspaceId: string; userId: string; filename: string; mimeType: string; kind: "SOURCE" | "GENERATED_DOCX" | "CODE_OUTPUT"; bytes: Buffer }) {
  const objectKey = `${input.workspaceId}/${crypto.randomUUID()}-${input.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  await putArtifact(objectKey, input.bytes, input.mimeType);
  return prisma.artifact.create({ data: { workspaceId: input.workspaceId, createdBy: input.userId, kind: input.kind, filename: input.filename, mimeType: input.mimeType, objectKey, sizeBytes: BigInt(input.bytes.byteLength) } });
}

export async function findArtifact(id: string) {
  return prisma.artifact.findUnique({ where: { id } });
}

export { getArtifact };
