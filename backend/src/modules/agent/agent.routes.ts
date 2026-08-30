import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireWorkspaceAccess } from "../../middleware/workspace-access.js";
import { createRun, getRun, cancelRun } from "./agent.service.js";

export const agentRouter = Router();
agentRouter.post("/workspaces/:workspaceId/runs", authenticate, requireWorkspaceAccess, async (request, response, next) => {
  try {
    const input = z.object({ task: z.string().min(10).max(10_000), artifactId: z.string().uuid().optional() }).parse(request.body);
    response.status(202).json({ run: await createRun({ workspaceId: String(request.params.workspaceId), userId: request.user!.id, ...input }) });
  } catch (error) { next(error); }
});
agentRouter.get("/runs/:runId", authenticate, async (request, response, next) => {
  try { response.json(await getRun(String(request.params.runId)) ?? { error: { code: "NOT_FOUND", message: "Run not found" } }); } catch (error) { next(error); }
});
agentRouter.post("/runs/:runId/cancel", authenticate, async (request, response, next) => {
  try { response.json({ run: await cancelRun(String(request.params.runId), request.user!.id) }); } catch (error) { next(error); }
});
