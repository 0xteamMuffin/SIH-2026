import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireWorkspaceAccess } from "../../middleware/workspace-access.js";
import { createRun, getRun, cancelRun } from "./agent.service.js";

export const agentRouter = Router();
agentRouter.use(authenticate);
agentRouter.post("/workspaces/:workspaceId/runs", requireWorkspaceAccess, async (request, response, next) => {
  try {
    const input = z.object({ task: z.string().min(10).max(10_000), artifactId: z.string().uuid().optional() }).parse(request.body);
    response.status(202).json({ run: await createRun({ workspaceId: String(request.params.workspaceId), userId: request.user!.id, ...input }) });
  } catch (error) { next(error); }
});
agentRouter.get("/runs/:runId", async (request, response, next) => {
  try { response.json(await getRun(request.params.runId!) ?? { error: { code: "NOT_FOUND", message: "Run not found" } }); } catch (error) { next(error); }
});
agentRouter.post("/runs/:runId/cancel", async (request, response, next) => {
  try { response.json({ run: await cancelRun(request.params.runId!, request.user!.id) }); } catch (error) { next(error); }
});
