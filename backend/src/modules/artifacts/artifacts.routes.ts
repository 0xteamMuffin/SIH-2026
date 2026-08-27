import { Router } from "express";
import multer from "multer";
import { authenticate } from "../../middleware/auth.js";
import { requireWorkspaceAccess } from "../../middleware/workspace-access.js";
import { AppError } from "../../lib/errors.js";
import { audit } from "../../lib/audit.js";
import { prisma } from "../../lib/prisma.js";
import { createArtifact, findArtifact, getArtifact } from "./artifacts.service.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
export const artifactsRouter = Router();
artifactsRouter.use(authenticate);

artifactsRouter.post("/workspaces/:workspaceId/artifacts", requireWorkspaceAccess, upload.single("file"), async (request, response, next) => {
  try {
    if (!request.file) throw new AppError(400, "A file is required", "INVALID_INPUT");
    const artifact = await createArtifact({ workspaceId: String(request.params.workspaceId), userId: request.user!.id, filename: request.file.originalname, mimeType: request.file.mimetype || "application/octet-stream", kind: "SOURCE", bytes: request.file.buffer });
    await audit({ actorId: request.user!.id, workspaceId: artifact.workspaceId, eventType: "ARTIFACT_UPLOADED", metadata: { artifactId: artifact.id, filename: artifact.filename } });
    response.status(201).json({ artifact });
  } catch (error) { next(error); }
});

artifactsRouter.get("/artifacts/:artifactId/download", async (request, response, next) => {
  try {
    const artifact = await findArtifact(request.params.artifactId!);
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
