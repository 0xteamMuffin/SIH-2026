import { Router } from "express";
import { DataClassification } from "@prisma/client";
import multer from "multer";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireWorkspaceAccess } from "../../middleware/workspace-access.js";
import { AppError } from "../../lib/errors.js";
import { audit } from "../../lib/audit.js";
import { prisma } from "../../lib/prisma.js";
import { createArtifact, findArtifact, getArtifact } from "./artifacts.service.js";
import { validateSourceArtifact } from "./artifact-validation.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
export const artifactsRouter = Router();

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
