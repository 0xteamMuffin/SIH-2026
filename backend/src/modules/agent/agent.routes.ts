import { Router } from "express";
import { DataClassification } from "@prisma/client";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireWorkspaceAccess } from "../../middleware/workspace-access.js";
import { AppError } from "../../lib/errors.js";
import { createRun, getRun, cancelRun } from "./agent.service.js";

export const agentRouter = Router();
agentRouter.post("/workspaces/:workspaceId/runs", authenticate, requireWorkspaceAccess, async (request, response, next) => {
  try {
    const input = z.object({ task: z.string().min(10).max(10_000), artifactId: z.string().uuid().optional(), dataClassification: z.nativeEnum(DataClassification) }).parse(request.body);
    response.status(202).json({ run: await createRun({ workspaceId: String(request.params.workspaceId), userId: request.user!.id, ...input }) });
  } catch (error) { next(error); }
});
agentRouter.get("/runs/:runId", authenticate, async (request, response, next) => {
  try {
    const run = await getRun(String(request.params.runId), request.user!);
    if (!run) throw new AppError(404, "Run not found", "NOT_FOUND");
    response.json({ run });
  } catch (error) { next(error); }
});
agentRouter.post("/runs/:runId/cancel", authenticate, async (request, response, next) => {
  try { response.json({ run: await cancelRun(String(request.params.runId), request.user!) }); } catch (error) { next(error); }
});
