import crypto from "node:crypto";
import { ArtifactExtractionStatus, ArtifactKind, ArtifactLifecycleStatus, Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { extractWithDocling } from "../../infrastructure/docling/docling-client.js";
import {
  createExtractionProvenanceSidecar,
  EXTRACTION_PROVENANCE_SCHEMA_VERSION,
  localTextProvenance,
  parseExtractionProvenanceSidecar,
  sha256,
} from "../../infrastructure/extraction/extraction-provenance.js";
import { getArtifact, putArtifact } from "../../infrastructure/storage/artifact-store.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import type { SourceTextBlock } from "../knowledge/text-chunker.js";
import { validateSourceArtifact } from "./artifact-validation.js";

type ExtractionResult = { text: string; objectKey: string; metadata: Prisma.JsonObject; sourceBlocks: SourceTextBlock[] };

function errorDetails(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: "EXTRACTION_FAILED", message: "Document extraction failed" };
}

async function readCompletedExtraction(artifact: {
  extractedObjectKey: string | null;
  extractionMetadata: Prisma.JsonValue | null;
  extractionProvenanceObjectKey: string | null;
  extractionProvenanceSha256: string | null;
  extractionProvenanceSchemaVersion: number | null;
  sha256: string | null;
}, signal?: AbortSignal): Promise<ExtractionResult> {
  if (!artifact.extractedObjectKey) throw new AppError(500, "Completed extraction has no stored content", "EXTRACTION_STATE_INVALID");
  const bytes = await getArtifact(artifact.extractedObjectKey, signal);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const hasAnyProvenanceField = artifact.extractionProvenanceObjectKey !== null
      || artifact.extractionProvenanceSha256 !== null
      || artifact.extractionProvenanceSchemaVersion !== null;
    if (!hasAnyProvenanceField) return { text, objectKey: artifact.extractedObjectKey, metadata: (artifact.extractionMetadata ?? {}) as Prisma.JsonObject, sourceBlocks: [] };
    if (!artifact.extractionProvenanceObjectKey || !artifact.extractionProvenanceSha256 || artifact.extractionProvenanceSchemaVersion !== EXTRACTION_PROVENANCE_SCHEMA_VERSION) {
      throw new Error("Stored extraction provenance metadata is incomplete or unsupported");
    }
    const provenanceBytes = await getArtifact(artifact.extractionProvenanceObjectKey, signal);
    if (sha256(provenanceBytes) !== artifact.extractionProvenanceSha256) throw new Error("Stored extraction provenance checksum does not match");
    const sidecar = parseExtractionProvenanceSidecar(provenanceBytes, text);
    if (artifact.sha256 && sidecar.sourceSha256 !== artifact.sha256) throw new Error("Stored extraction provenance source checksum does not match");
    return { text, objectKey: artifact.extractedObjectKey, metadata: (artifact.extractionMetadata ?? {}) as Prisma.JsonObject, sourceBlocks: sidecar.blocks as SourceTextBlock[] };
  } catch {
    throw new AppError(500, "Stored extraction or provenance is invalid", "EXTRACTION_STATE_INVALID");
  }
}

export async function extractArtifact(artifactId: string, signal?: AbortSignal): Promise<ExtractionResult> {
  signal?.throwIfAborted();
  const initial = await prisma.artifact.findFirst({ where: { id: artifactId, lifecycleStatus: ArtifactLifecycleStatus.ACTIVE } });
  if (!initial) throw new AppError(404, "Artifact not found", "NOT_FOUND");
  if (initial.kind !== ArtifactKind.SOURCE) throw new AppError(422, "Only source artifacts can be extracted", "EXTRACTION_NOT_REQUIRED");
  if (initial.extractionStatus === ArtifactExtractionStatus.COMPLETED) return readCompletedExtraction(initial, signal);

  const extractionStartedAt = new Date();
  const staleBefore = new Date(extractionStartedAt.getTime() - env.EXTRACTION_STALE_TIMEOUT_MS);
  const claimed = await prisma.artifact.updateMany({
    where: {
      id: artifactId,
      kind: ArtifactKind.SOURCE,
      lifecycleStatus: ArtifactLifecycleStatus.ACTIVE,
      OR: [
        { extractionStatus: { in: [ArtifactExtractionStatus.PENDING, ArtifactExtractionStatus.FAILED] } },
        { extractionStatus: ArtifactExtractionStatus.PROCESSING, extractionStartedAt: { lte: staleBefore } },
      ],
    },
    data: { extractionStatus: ArtifactExtractionStatus.PROCESSING, extractionStartedAt, extractionError: null, extractedAt: null },
  });
  if (claimed.count === 0) {
    const current = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
    if (current.extractionStatus === ArtifactExtractionStatus.COMPLETED) return readCompletedExtraction(current, signal);
    throw new AppError(409, "Artifact extraction is already in progress", "EXTRACTION_IN_PROGRESS");
  }

  try {
    signal?.throwIfAborted();
    const sourceBytes = await getArtifact(initial.objectKey, signal);
    const validated = await validateSourceArtifact(initial.filename, sourceBytes);
    const sourceSha256 = crypto.createHash("sha256").update(sourceBytes).digest("hex");
    let text: string;
    let format: "markdown" | "text";
    let metadata: Prisma.JsonObject;
    let sourceBlocks: SourceTextBlock[];
    if (["txt", "md", "csv"].includes(validated.extension)) {
      text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
      format = validated.extension === "md" ? "markdown" : "text";
      sourceBlocks = localTextProvenance(text, validated.extension === "csv" ? "table" : undefined);
      metadata = { extractor: "local-utf8", format, sourceMimeType: validated.mimeType };
    } else {
      const extracted = await extractWithDocling({ filename: initial.filename, mimeType: validated.mimeType, bytes: sourceBytes }, signal);
      text = extracted.markdown;
      sourceBlocks = extracted.sourceBlocks;
      format = "markdown";
      metadata = { extractor: "docling-serve", extractorVersion: "1.31.0", format, sourceMimeType: validated.mimeType, processingTimeSeconds: extracted.processingTimeSeconds, status: extracted.status, errorCount: extracted.errorCount };
    }
    signal?.throwIfAborted();
    if (!text.trim()) throw new AppError(422, "Document extraction returned no content", "EXTRACTION_EMPTY");
    const extractedBytes = Buffer.from(text, "utf8");
    const extractedSha256 = crypto.createHash("sha256").update(extractedBytes).digest("hex");
    const extension = format === "markdown" ? "md" : "txt";
    const objectKey = `${initial.workspaceId}/extractions/${initial.id}/${sourceSha256}.${extension}`;
    const sidecar = createExtractionProvenanceSidecar({ sourceSha256, canonicalText: text, blocks: sourceBlocks });
    const provenanceBytes = Buffer.from(JSON.stringify(sidecar), "utf8");
    const provenanceSha256 = sha256(provenanceBytes);
    const provenanceObjectKey = `${initial.workspaceId}/extractions/${initial.id}/${sourceSha256}.provenance.v${EXTRACTION_PROVENANCE_SCHEMA_VERSION}.json`;
    metadata = { ...metadata, sourceSha256, extractedSha256, characters: text.length, provenanceSha256, provenanceSchemaVersion: EXTRACTION_PROVENANCE_SCHEMA_VERSION };
    await putArtifact(objectKey, extractedBytes, format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8");
    await putArtifact(provenanceObjectKey, provenanceBytes, "application/json; charset=utf-8");
    signal?.throwIfAborted();
    const completed = await prisma.artifact.updateMany({
      where: { id: artifactId, lifecycleStatus: ArtifactLifecycleStatus.ACTIVE, extractionStatus: ArtifactExtractionStatus.PROCESSING, extractionStartedAt },
      data: {
        sha256: sourceSha256,
        detectedMimeType: validated.mimeType,
        extractionStatus: ArtifactExtractionStatus.COMPLETED,
        extractedObjectKey: objectKey,
        extractionProvenanceObjectKey: provenanceObjectKey,
        extractionProvenanceSha256: provenanceSha256,
        extractionProvenanceSchemaVersion: EXTRACTION_PROVENANCE_SCHEMA_VERSION,
        extractionMetadata: metadata,
        extractionError: null,
        extractionStartedAt: null,
        extractedAt: new Date(),
      },
    });
    if (completed.count === 0) throw new AppError(409, "Artifact extraction claim was lost", "EXTRACTION_CLAIM_LOST");
    return { text, objectKey, metadata, sourceBlocks };
  } catch (error) {
    const normalized = signal?.aborted
      ? new AppError(503, "Document extraction was cancelled", "EXTRACTION_CANCELLED")
      : error instanceof AppError ? error : new AppError(502, "Document extraction failed", "EXTRACTION_FAILED");
    const details = errorDetails(normalized);
    if (!(error instanceof AppError)) logger.warn({ error, artifactId }, "Artifact extraction failed");
    await prisma.artifact.updateMany({
      where: { id: artifactId, extractionStatus: ArtifactExtractionStatus.PROCESSING, extractionStartedAt },
      data: { extractionStatus: ArtifactExtractionStatus.FAILED, extractionError: `[${details.code}] ${details.message}`.slice(0, 2_000), extractionStartedAt: null },
    });
    throw normalized;
  }
}
