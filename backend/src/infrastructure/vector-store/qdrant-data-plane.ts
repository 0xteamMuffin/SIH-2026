import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";
import { env } from "../../config/env.js";
import type {
  CountVectorPointsInput,
  DeleteKnowledgeSourceInput,
  QueryVectorPointsInput,
  ReconciliationSelector,
  ScrollVectorPointsInput,
  UpsertVectorPointsInput,
  VectorPayload,
  VectorPointId,
  VectorQueryMatch,
  VectorScrollPage,
  VectorStoreDataPlane,
} from "./vector-store-data-plane.js";

const MAX_VECTOR_SIZE = 65_536;
const MAX_UPSERT_POINTS = 256;
const MAX_QUERY_LIMIT = 100;
const MAX_SCROLL_LIMIT = 1_000;
const MAX_FILTER_VALUES = 100;
const RESERVED_PAYLOAD_KEYS = new Set(["scope_key", "workspace_id", "artifact_id", "classification", "knowledge_source_id"]);

const identifierSchema = z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const uuidSchema = z.string().uuid();
const pointIdSchema = z.union([uuidSchema, z.number().int().nonnegative().safe()]);
const vectorSchema = z.array(z.number().finite()).min(1).max(MAX_VECTOR_SIZE);
const classificationSchema = z.enum(["PUBLIC", "SYNTHETIC", "INTERNAL", "CONFIDENTIAL"]);
const scopeKeySchema = z.string().min(1).max(128).superRefine((value, context) => {
  if (value.startsWith("workspace:")) {
    if (!uuidSchema.safeParse(value.slice("workspace:".length)).success) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Workspace scope keys must contain a UUID" });
    }
    return;
  }
  if (!/^organization:[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid scope key" });
  }
});
const scopeSchema = z.object({ workspaceId: uuidSchema, scopeKey: scopeKeySchema }).strict().superRefine((scope, context) => {
  if (scope.scopeKey.startsWith("workspace:") && scope.scopeKey.slice("workspace:".length) !== scope.workspaceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Workspace scope key must match workspaceId", path: ["scopeKey"] });
  }
});
const permittedScopeKeysSchema = z.array(scopeKeySchema).min(1).max(MAX_FILTER_VALUES).superRefine((scopeKeys, context) => {
  const seen = new Set<string>();
  for (const [index, scopeKey] of scopeKeys.entries()) {
    if (seen.has(scopeKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Permitted scope keys must be unique", path: [index] });
    }
    seen.add(scopeKey);
  }
});
const jsonValueSchema: z.ZodType<null | boolean | number | string | unknown[] | Record<string, unknown>> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));
const payloadSchema = z.record(jsonValueSchema).superRefine((payload, context) => {
  for (const key of Object.keys(payload)) {
    if (RESERVED_PAYLOAD_KEYS.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${key} is managed by the vector store`, path: [key] });
    }
  }
});
const pointSchema = z.object({
  id: pointIdSchema,
  vector: vectorSchema,
  knowledgeSourceId: uuidSchema,
  artifactId: uuidSchema,
  classification: classificationSchema,
  payload: payloadSchema.optional(),
}).strict();
const upsertSchema = z.object({
  collectionName: identifierSchema,
  vectorName: identifierSchema,
  scope: scopeSchema,
  points: z.array(pointSchema).min(1).max(MAX_UPSERT_POINTS),
}).strict();
const querySchema = z.object({
  collectionName: identifierSchema,
  vectorName: identifierSchema,
  vector: vectorSchema,
  permittedScopeKeys: permittedScopeKeysSchema,
  artifactIds: z.array(uuidSchema).min(1).max(MAX_FILTER_VALUES).optional(),
  classifications: z.array(classificationSchema).min(1).max(4).optional(),
  limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).default(20),
  scoreThreshold: z.number().finite().optional(),
}).strict();
const deleteSchema = z.object({ collectionName: identifierSchema, knowledgeSourceId: uuidSchema }).strict();
const selectorShape = {
  scope: scopeSchema.optional(),
  knowledgeSourceId: uuidSchema.optional(),
};
const countSchema = z.object({
  collectionName: identifierSchema,
  ...selectorShape,
  exact: z.boolean().default(true),
}).strict();
const scrollSchema = z.object({
  collectionName: identifierSchema,
  ...selectorShape,
  cursor: pointIdSchema.optional(),
  limit: z.number().int().min(1).max(MAX_SCROLL_LIMIT).default(100),
}).strict();

type QdrantDataClient = Pick<QdrantClient, "upsert" | "query" | "delete" | "count" | "scroll">;
type FixedFilterCondition = { key: string; match: { value: string } | { any: string[] } };

function selectorFilter(selector: ReconciliationSelector) {
  const must = [];
  if (selector.scope) {
    must.push({ key: "scope_key", match: { value: selector.scope.scopeKey } });
    must.push({ key: "workspace_id", match: { value: selector.scope.workspaceId } });
  }
  if (selector.knowledgeSourceId) must.push({ key: "knowledge_source_id", match: { value: selector.knowledgeSourceId } });
  return must.length > 0 ? { must } : undefined;
}

function payloadOrEmpty(payload: unknown): VectorPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return payload as VectorPayload;
}

export class QdrantDataPlane implements VectorStoreDataPlane {
  constructor(private readonly client: QdrantDataClient) {}

  async upsertPoints(input: UpsertVectorPointsInput): Promise<void> {
    const parsed = upsertSchema.parse(input);
    await this.client.upsert(parsed.collectionName, {
      wait: true,
      points: parsed.points.map((point) => ({
        id: point.id,
        vector: { [parsed.vectorName]: point.vector },
        payload: {
          ...(point.payload ?? {}),
          scope_key: parsed.scope.scopeKey,
          workspace_id: parsed.scope.workspaceId,
          artifact_id: point.artifactId,
          classification: point.classification,
          knowledge_source_id: point.knowledgeSourceId,
        },
      })),
    });
  }

  async queryPoints(input: QueryVectorPointsInput): Promise<VectorQueryMatch[]> {
    const parsed = querySchema.parse(input);
    const must: FixedFilterCondition[] = [{ key: "scope_key", match: { any: parsed.permittedScopeKeys } }];
    if (parsed.artifactIds) must.push({ key: "artifact_id", match: { any: parsed.artifactIds } });
    if (parsed.classifications) must.push({ key: "classification", match: { any: parsed.classifications } });

    const result = await this.client.query(parsed.collectionName, {
      query: parsed.vector,
      using: parsed.vectorName,
      filter: { must },
      limit: parsed.limit,
      score_threshold: parsed.scoreThreshold,
      with_payload: true,
      with_vector: false,
    });
    return result.points.map((point) => ({ id: point.id, score: point.score, payload: payloadOrEmpty(point.payload) }));
  }

  async deleteByKnowledgeSourceId(input: DeleteKnowledgeSourceInput): Promise<void> {
    const parsed = deleteSchema.parse(input);
    await this.client.delete(parsed.collectionName, {
      wait: true,
      filter: { must: [{ key: "knowledge_source_id", match: { value: parsed.knowledgeSourceId } }] },
    });
  }

  async countPoints(input: CountVectorPointsInput): Promise<number> {
    const parsed = countSchema.parse(input);
    const result = await this.client.count(parsed.collectionName, {
      exact: parsed.exact,
      filter: selectorFilter(parsed),
    });
    return result.count;
  }

  async scrollPoints(input: ScrollVectorPointsInput): Promise<VectorScrollPage> {
    const parsed = scrollSchema.parse(input);
    const result = await this.client.scroll(parsed.collectionName, {
      filter: selectorFilter(parsed),
      limit: parsed.limit,
      offset: parsed.cursor,
      with_payload: true,
      with_vector: false,
    });
    return {
      points: result.points.map((point) => ({ id: point.id, payload: payloadOrEmpty(point.payload) })),
      ...(result.next_page_offset === null || result.next_page_offset === undefined
        ? {}
        : { nextCursor: result.next_page_offset as VectorPointId }),
    };
  }
}

let configuredDataPlane: QdrantDataPlane | undefined;

export function getQdrantDataPlane(): QdrantDataPlane {
  configuredDataPlane ??= new QdrantDataPlane(new QdrantClient({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY,
    timeout: 5_000,
    checkCompatibility: false,
  }));
  return configuredDataPlane;
}
