import { Router, type Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireWorkspaceAccess, requireWorkspaceRole } from "../../middleware/workspace-access.js";
import { exportAuditEvents, listAuditEvents, type AuditFilters } from "./audit.service.js";

export const auditRouter = Router();

const uuidSchema = z.string().uuid();
const cursorPayloadSchema = z.object({ createdAt: z.string().datetime(), id: uuidSchema }).strict();
const cursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).transform((value, context) => {
  try {
    const parsed = cursorPayloadSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (parsed.success) return { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id };
  } catch {
    // Report all malformed cursor representations as the same validation error.
  }
  context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid audit event cursor" });
  return z.NEVER;
});
const dateSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const filterShape = {
  eventType: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  actorId: uuidSchema.optional(),
  runId: uuidSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
};
const validateRange = (query: { from?: Date; to?: Date }, context: z.RefinementCtx) => {
  if (query.from && query.to && query.from > query.to) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "from must not be later than to", path: ["from"] });
  }
};
const listQuerySchema = z.object({
  ...filterShape,
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict().superRefine(validateRange);
const exportQuerySchema = z.object({
  ...filterShape,
  format: z.enum(["json", "ndjson"]).default("json"),
}).strict().superRefine(validateRange);

function filters(query: AuditFilters): AuditFilters {
  return { eventType: query.eventType, actorId: query.actorId, runId: query.runId, from: query.from, to: query.to };
}

async function writeChunk(response: Response, chunk: string) {
  if (response.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}

auditRouter.get("/workspaces/:workspaceId/audit-events", authenticate, requireWorkspaceAccess, async (request, response, next) => {
  try {
    const query = listQuerySchema.parse(request.query);
    const result = await listAuditEvents({
      workspaceId: String(request.params.workspaceId),
      limit: query.limit,
      cursor: query.cursor,
      filters: filters(query),
    });
    response.json({ auditEvents: result.events, pagination: { nextCursor: result.nextCursor } });
  } catch (error) { next(error); }
});

auditRouter.get("/workspaces/:workspaceId/audit-events/export", authenticate, requireWorkspaceRole("ADMIN"), async (request, response, next) => {
  try {
    const query = exportQuerySchema.parse(request.query);
    const workspaceId = String(request.params.workspaceId);
    const exportFilters = filters({ ...query, to: query.to ?? new Date() });
    const filename = `audit-${workspaceId}-${new Date().toISOString().replace(/[:.]/g, "-")}.${query.format}`;
    response.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    response.type(query.format === "ndjson" ? "application/x-ndjson" : "application/json");
    if (query.format === "json") await writeChunk(response, "[");
    let first = true;
    for await (const event of exportAuditEvents(workspaceId, exportFilters)) {
      if (response.destroyed) break;
      if (query.format === "ndjson") {
        await writeChunk(response, `${JSON.stringify(event)}\n`);
      } else {
        await writeChunk(response, `${first ? "" : ","}${JSON.stringify(event)}`);
        first = false;
      }
    }
    if (!response.destroyed) response.end(query.format === "json" ? "]" : undefined);
  } catch (error) {
    if (!response.headersSent) next(error);
    else response.destroy(error instanceof Error ? error : new Error("Audit export failed"));
  }
});
