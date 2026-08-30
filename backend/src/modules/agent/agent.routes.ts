import { Router } from "express";
import { ApprovalStatus, DataClassification } from "@prisma/client";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireWorkspaceAccess, requireWorkspaceRole } from "../../middleware/workspace-access.js";
import { AppError } from "../../lib/errors.js";
import { createRun, getRun, cancelRun, listRuns } from "./agent.service.js";
import { decideToolApproval } from "./agent-approval.service.js";

export const agentRouter = Router();
const runCursorPayloadSchema = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).strict();
const runCursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).transform((value, context) => {
  try {
    const parsed = runCursorPayloadSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (parsed.success) return { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id };
  } catch {
    // All malformed cursor representations use the same validation error.
  }
  context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid run cursor" });
  return z.NEVER;
});
const runListQuerySchema = z.object({
  cursor: runCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

agentRouter.get("/workspaces/:workspaceId/runs", authenticate, requireWorkspaceAccess, async (request, response, next) => {
  try {
    const query = runListQuerySchema.parse(request.query);
    const result = await listRuns({ workspaceId: String(request.params.workspaceId), ...query });
    response.json({ runs: result.runs, pagination: { nextCursor: result.nextCursor } });
  } catch (error) { next(error); }
});

agentRouter.post("/workspaces/:workspaceId/runs", authenticate, requireWorkspaceRole("ADMIN", "OPERATOR"), async (request, response, next) => {
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
agentRouter.post("/agent-approvals/:approvalId/decision", authenticate, async (request, response, next) => {
  try {
    const input = z.object({
      decision: z.enum([ApprovalStatus.APPROVED, ApprovalStatus.REJECTED]),
      note: z.string().trim().min(1).max(2_000).optional(),
    }).strict().parse(request.body);
    const approvalId = z.string().uuid().parse(request.params.approvalId);
    response.json({ approval: await decideToolApproval(approvalId, request.user!, input.decision, input.note) });
  } catch (error) { next(error); }
});
