import { DataClassification, KnowledgeSourceStatus, KnowledgeVisibility } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { requireWorkspaceAccess } from "../../middleware/workspace-access.js";
import {
  createKnowledgeQuery,
  createKnowledgeSource,
  getKnowledgeQuery,
  getKnowledgeSource,
  listKnowledgeSources,
  reindexKnowledgeSource,
} from "./knowledge.service.js";

export const knowledgeRouter = Router();

const uuidSchema = z.string().uuid();
const idParamsSchema = z.object({ sourceId: uuidSchema }).strict();
const queryIdParamsSchema = z.object({ queryId: uuidSchema }).strict();
const cursorPayloadSchema = z.object({ createdAt: z.string().datetime(), id: uuidSchema }).strict();
const cursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).transform((value, context) => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid knowledge source cursor" });
    return z.NEVER;
  }
  const parsed = cursorPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid knowledge source cursor" });
    return z.NEVER;
  }
  return { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id };
});
const sourceListQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  visibility: z.nativeEnum(KnowledgeVisibility).optional(),
  status: z.nativeEnum(KnowledgeSourceStatus).optional(),
}).strict();
const createSourceSchema = z.object({
  artifactId: uuidSchema,
  visibility: z.nativeEnum(KnowledgeVisibility).default(KnowledgeVisibility.WORKSPACE_PRIVATE),
}).strict();
const queryFiltersSchema = z.object({
  artifactIds: z.array(uuidSchema).min(1).max(100).optional(),
  classifications: z.array(z.nativeEnum(DataClassification)).min(1).max(4).optional(),
  scoreThreshold: z.number().finite().optional(),
}).strict();
const createQuerySchema = z.object({
  queryText: z.string().trim().min(1).max(10_000),
  topK: z.number().int().min(1).max(100).default(10),
  filters: queryFiltersSchema.default({}),
  dataClassification: z.nativeEnum(DataClassification).default(DataClassification.INTERNAL),
}).strict();

knowledgeRouter.get("/workspaces/:workspaceId/knowledge-sources", authenticate, requireWorkspaceAccess, async (request, response, next) => {
  try {
    const query = sourceListQuerySchema.parse(request.query);
    const result = await listKnowledgeSources({ workspaceId: String(request.params.workspaceId), ...query });
    response.json({ knowledgeSources: result.knowledgeSources, pagination: { nextCursor: result.nextCursor } });
  } catch (error) { next(error); }
});

knowledgeRouter.post("/workspaces/:workspaceId/knowledge-sources", authenticate, requireWorkspaceAccess, requireRole("ADMIN", "OPERATOR"), async (request, response, next) => {
  try {
    const input = createSourceSchema.parse(request.body);
    const result = await createKnowledgeSource({ workspaceId: String(request.params.workspaceId), actor: request.user!, ...input });
    response.status(202).json(result);
  } catch (error) { next(error); }
});

knowledgeRouter.get("/knowledge-sources/:sourceId", authenticate, async (request, response, next) => {
  try {
    const { sourceId } = idParamsSchema.parse(request.params);
    const knowledgeSource = await getKnowledgeSource(sourceId, request.user!);
    if (!knowledgeSource) throw new AppError(404, "Knowledge source not found", "NOT_FOUND");
    response.json({ knowledgeSource });
  } catch (error) { next(error); }
});

knowledgeRouter.post("/knowledge-sources/:sourceId/reindex", authenticate, requireRole("ADMIN", "OPERATOR"), async (request, response, next) => {
  try {
    const { sourceId } = idParamsSchema.parse(request.params);
    response.status(202).json(await reindexKnowledgeSource(sourceId, request.user!));
  } catch (error) { next(error); }
});

knowledgeRouter.post("/workspaces/:workspaceId/knowledge-queries", authenticate, requireWorkspaceAccess, requireRole("ADMIN", "OPERATOR"), async (request, response, next) => {
  try {
    const input = createQuerySchema.parse(request.body);
    const result = await createKnowledgeQuery({ workspaceId: String(request.params.workspaceId), userId: request.user!.id, ...input });
    response.status(202).json(result);
  } catch (error) { next(error); }
});

knowledgeRouter.get("/knowledge-queries/:queryId", authenticate, async (request, response, next) => {
  try {
    const { queryId } = queryIdParamsSchema.parse(request.params);
    const knowledgeQuery = await getKnowledgeQuery(queryId, request.user!);
    if (!knowledgeQuery) throw new AppError(404, "Knowledge query not found", "NOT_FOUND");
    response.json({ knowledgeQuery });
  } catch (error) { next(error); }
});
