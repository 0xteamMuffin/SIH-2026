import { Router } from "express";
import { ArtifactExtractionStatus, ArtifactKind, DataClassification } from "@prisma/client";
import multer from "multer";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireWorkspaceAccess } from "../../middleware/workspace-access.js";
import { AppError } from "../../lib/errors.js";
import { audit } from "../../lib/audit.js";
import { prisma } from "../../lib/prisma.js";
import { createArtifact, findArtifact, getArtifact, getArtifactMetadata, listArtifacts } from "./artifacts.service.js";
import { validateSourceArtifact } from "./artifact-validation.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
export const artifactsRouter = Router();

const artifactCursorPayloadSchema = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() });
const artifactCursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).transform((value, context) => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid artifact cursor" });
    return z.NEVER;
  }
  const result = artifactCursorPayloadSchema.safeParse(decoded);
  if (!result.success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid artifact cursor" });
    return z.NEVER;
  }
  return { createdAt: new Date(result.data.createdAt), id: result.data.id };
});
const artifactListQuerySchema = z.object({
  cursor: artifactCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  kind: z.nativeEnum(ArtifactKind).optional(),
  extractionStatus: z.nativeEnum(ArtifactExtractionStatus).optional(),
});
const artifactIdParamsSchema = z.object({ artifactId: z.string().uuid() });

artifactsRouter.get("/workspaces/:workspaceId/artifacts", authenticate, requireWorkspaceAccess, async (request, response, next) => {
  try {
    const query = artifactListQuerySchema.parse(request.query);
    const result = await listArtifacts({ workspaceId: String(request.params.workspaceId), ...query });
    response.json({ artifacts: result.artifacts, pagination: { nextCursor: result.nextCursor } });
  } catch (error) { next(error); }
});

artifactsRouter.get("/artifacts/:artifactId", authenticate, async (request, response, next) => {
  try {
    const { artifactId } = artifactIdParamsSchema.parse(request.params);
    const artifact = await getArtifactMetadata(artifactId, request.user!);
    if (!artifact) throw new AppError(404, "Artifact not found", "NOT_FOUND");
    response.json({ artifact });
  } catch (error) { next(error); }
});

artifactsRouter.post("/workspaces/:workspaceId/artifacts", authenticate, requireWorkspaceAccess, upload.single("file"), async (request, response, next) => {
  try {
    if (!request.file) throw new AppError(400, "A file is required", "INVALID_INPUT");
    const classification = z.nativeEnum(DataClassification).parse(request.body.classification);
    const detected = await validateSourceArtifact(request.file.originalname, request.file.buffer);
    const artifact = await createArtifact({ workspaceId: String(request.params.workspaceId), userId: request.user!.id, filename: request.file.originalname, mimeType: detected.mimeType, detectedMimeType: detected.mimeType, kind: "SOURCE", classification, bytes: request.file.buffer });
    await audit({ actorId: request.user!.id, workspaceId: artifact.workspaceId, eventType: "ARTIFACT_UPLOADED", metadata: { artifactId: artifact.id, filename: artifact.filename, classification } });
    response.status(201).json({ artifact });
  } catch (error) { next(error); }
});

artifactsRouter.get("/artifacts/:artifactId/download", authenticate, async (request, response, next) => {
  try {
    const artifact = await findArtifact(String(request.params.artifactId));
    if (!artifact) throw new AppError(404, "Artifact not found", "NOT_FOUND");
    if (request.user!.role !== "ADMIN") {
      const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: artifact.workspaceId, userId: request.user!.id } } });
      if (!membership) throw new AppError(403, "Artifact access denied", "FORBIDDEN");
    }
    const bytes = await getArtifact(artifact.objectKey);
    response.setHeader("content-type", artifact.mimeType);
    response.setHeader("content-disposition", `attachment; filename="${artifact.filename.replace(/\"/g, "")}"`);
    response.send(bytes);
  } catch (error) { next(error); }
});
