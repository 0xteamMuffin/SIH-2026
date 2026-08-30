import {
  DataClassification,
  KnowledgeIndexStatus,
  KnowledgeSourceIndexStatus,
  KnowledgeSourceStatus,
  KnowledgeVisibility,
  type PrismaClient,
} from "@prisma/client";
import { embedTexts, type EmbeddingVector } from "../../infrastructure/embeddings/embedding-provider.js";
import { selectEmbeddingProfile } from "../../infrastructure/embeddings/embedding-profile-resolver.js";
import type { EmbeddingModelProfile } from "../../infrastructure/models/model-registry.js";
import { getQdrantDataPlane } from "../../infrastructure/vector-store/qdrant-data-plane.js";
import type { VectorPayload, VectorQueryMatch, VectorStoreDataPlane } from "../../infrastructure/vector-store/vector-store-data-plane.js";
import { allowsExternalInference } from "../../lib/data-classification.js";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { knowledgeIndexIdentity } from "../knowledge/knowledge-index-provisioner.js";

const MAX_CITATIONS = 8;
const MAX_CITATION_TEXT = 2_000;

type KnowledgeSearchStore = Pick<PrismaClient, "knowledgeIndex" | "knowledgeSourceIndex">;

export type KnowledgeSearchCitation = {
  artifactId: string;
  title: string;
  text: string;
  sourceRef: string;
  score: number;
};

export type AgentKnowledgeSearchDependencies = {
  store: KnowledgeSearchStore;
  vectorStore: Pick<VectorStoreDataPlane, "queryPoints">;
  resolveEmbeddingProfile: (classification: DataClassification) => EmbeddingModelProfile;
  embed: (profile: EmbeddingModelProfile, classification: DataClassification, inputs: readonly string[], signal?: AbortSignal) => Promise<EmbeddingVector[]>;
};

type SourceIndex = {
  sourceRevision: number;
  indexRevision: number;
  status: KnowledgeSourceIndexStatus;
  source: {
    id: string;
    workspaceId: string;
    visibility: KnowledgeVisibility;
    status: KnowledgeSourceStatus;
    revision: number;
    artifact: { id: string; filename: string; classification: DataClassification };
  };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function range(value: unknown, oneBased: boolean): { start: number; end: number } | undefined {
  const candidate = record(value);
  if (!candidate || !Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end)) return undefined;
  const start = candidate.start as number;
  const end = candidate.end as number;
  return start >= (oneBased ? 1 : 0) && end >= start ? { start, end } : undefined;
}

function locationRecord(payload: VectorPayload): Record<string, unknown> {
  const direct = payload as Record<string, unknown>;
  const provenance = record(direct.provenance);
  const sourceBlocks = Array.isArray(direct.source_blocks) ? direct.source_blocks : direct.sourceBlocks;
  const firstBlock = Array.isArray(sourceBlocks) ? record(sourceBlocks[0]) : undefined;
  return { ...record(firstBlock?.provenance), ...provenance, ...direct };
}

function sourceRef(artifactId: string, payload: VectorPayload): string {
  const location = locationRecord(payload);
  const parts: string[] = [];
  const page = positiveInteger(location.page);
  const slide = positiveInteger(location.slide);
  const sheet = typeof location.sheet === "string" && location.sheet.length > 0 ? location.sheet.slice(0, 255) : undefined;
  const charRange = range(payload.char_range ?? payload.charRange, false);
  const lineRange = range(payload.line_range ?? payload.lineRange, true);
  if (page !== undefined) parts.push(`page=${page}`);
  if (slide !== undefined) parts.push(`slide=${slide}`);
  if (sheet !== undefined) parts.push(`sheet=${encodeURIComponent(sheet)}`);
  if (charRange) parts.push(`chars=${charRange.start}-${charRange.end}`);
  if (lineRange) parts.push(`lines=${lineRange.start}-${lineRange.end}`);
  return `artifact:${artifactId}${parts.length > 0 ? `#${parts.join("&")}` : ""}`;
}

function permittedClassifications(classification: DataClassification): DataClassification[] {
  const external = [DataClassification.PUBLIC, DataClassification.SYNTHETIC];
  if (allowsExternalInference(classification)) return external;
  if (classification === DataClassification.INTERNAL) return [...external, DataClassification.INTERNAL];
  return [...external, DataClassification.INTERNAL, DataClassification.CONFIDENTIAL];
}

function payloadIdentity(match: VectorQueryMatch) {
  const sourceId = match.payload.knowledge_source_id;
  const artifactId = match.payload.artifact_id;
  const sourceRevision = match.payload.source_revision;
  const indexRevision = match.payload.index_revision;
  if (typeof sourceId !== "string" || typeof artifactId !== "string") return undefined;
  if (!Number.isSafeInteger(sourceRevision) || !Number.isSafeInteger(indexRevision)) return undefined;
  return { sourceId, artifactId, sourceRevision: sourceRevision as number, indexRevision: indexRevision as number };
}

function assembleCitations(matches: VectorQueryMatch[], sourceIndexes: SourceIndex[], workspaceId: string, indexRevision: number): KnowledgeSearchCitation[] {
  const authoritative = new Map(sourceIndexes.map((item) => [item.source.id, item]));
  const citations: KnowledgeSearchCitation[] = [];
  const seen = new Set<string>();
  for (const match of [...matches].sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)))) {
    const pointId = `${typeof match.id}:${String(match.id)}`;
    if (seen.has(pointId) || !Number.isFinite(match.score)) continue;
    seen.add(pointId);
    const identity = payloadIdentity(match);
    if (!identity || identity.indexRevision !== indexRevision) continue;
    const sourceIndex = authoritative.get(identity.sourceId);
    if (!sourceIndex || sourceIndex.status !== KnowledgeSourceIndexStatus.READY) continue;
    const source = sourceIndex.source;
    if (source.status !== KnowledgeSourceStatus.ACTIVE || source.revision !== sourceIndex.sourceRevision) continue;
    if (identity.sourceRevision !== sourceIndex.sourceRevision || identity.indexRevision !== sourceIndex.indexRevision) continue;
    if (identity.artifactId !== source.artifact.id || match.payload.classification !== source.artifact.classification) continue;
    const expectedScope = source.visibility === KnowledgeVisibility.ORGANIZATION_SHARED ? "organization:default" : `workspace:${workspaceId}`;
    if (match.payload.scope_key !== expectedScope || match.payload.workspace_id !== source.workspaceId) continue;
    const text = typeof match.payload.text === "string" ? match.payload.text.trim().slice(0, MAX_CITATION_TEXT) : "";
    if (!text) continue;
    const headings = Array.isArray(match.payload.heading_path) ? match.payload.heading_path : match.payload.headingPath;
    const heading = Array.isArray(headings)
      ? headings.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, 4).join(" > ").slice(0, 300)
      : "";
    citations.push({
      artifactId: source.artifact.id,
      title: `${source.artifact.filename}${heading ? ` - ${heading}` : ""}`.slice(0, 500),
      text,
      sourceRef: sourceRef(source.artifact.id, match.payload),
      score: match.score,
    });
    if (citations.length === MAX_CITATIONS) break;
  }
  return citations;
}

export async function searchAgentKnowledge(
  input: { workspaceId: string; classification: DataClassification; query: string; signal?: AbortSignal },
  dependencies: Partial<AgentKnowledgeSearchDependencies> = {},
): Promise<KnowledgeSearchCitation[]> {
  const store = dependencies.store ?? prisma;
  const vectorStore = dependencies.vectorStore ?? getQdrantDataPlane();
  const resolveEmbeddingProfile = dependencies.resolveEmbeddingProfile ?? selectEmbeddingProfile;
  const embed = dependencies.embed ?? embedTexts;
  const index = await store.knowledgeIndex.findFirst({
    where: { status: KnowledgeIndexStatus.ACTIVE },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!index) return [];

  let profile: EmbeddingModelProfile;
  try {
    profile = resolveEmbeddingProfile(input.classification);
  } catch {
    throw new AppError(503, "The knowledge index embedding profile is unavailable", "KNOWLEDGE_INDEX_PROFILE_UNAVAILABLE");
  }
  if (profile.location === "remote" && !allowsExternalInference(input.classification)) {
    throw new AppError(422, "External inference is restricted to public or synthetic data", "EXTERNAL_INFERENCE_BLOCKED");
  }
  const identity = knowledgeIndexIdentity(profile, index.chunkerVersion);
  if (identity.fingerprint !== index.fingerprint || profile.id !== index.profileId || profile.providerId !== index.providerId
    || profile.modelId !== index.modelId || profile.dimensions !== index.dimensions || profile.distance.toUpperCase() !== index.distance) {
    throw new AppError(409, "The active knowledge index embedding profile is unavailable", "KNOWLEDGE_INDEX_PROFILE_MISMATCH");
  }

  input.signal?.throwIfAborted();
  const vectors = await embed(profile, input.classification, [input.query], input.signal);
  if (vectors.length !== 1 || vectors[0].length !== profile.dimensions || vectors[0].some((value) => !Number.isFinite(value))) {
    throw new AppError(502, "Embedding provider returned an invalid query vector", "EMBEDDING_RESPONSE_INVALID");
  }
  input.signal?.throwIfAborted();
  const classifications = permittedClassifications(input.classification);
  const matches = await vectorStore.queryPoints({
    collectionName: index.collectionName,
    vectorName: index.vectorName,
    vector: vectors[0],
    permittedScopeKeys: [`workspace:${input.workspaceId}`, "organization:default"],
    classifications,
    limit: MAX_CITATIONS * 4,
  });
  input.signal?.throwIfAborted();
  const active = await store.knowledgeIndex.findFirst({
    where: { id: index.id, status: KnowledgeIndexStatus.ACTIVE, revision: index.revision },
    select: { id: true },
  });
  if (!active) throw new AppError(409, "The active knowledge index changed during retrieval", "KNOWLEDGE_INDEX_REVISION_INACTIVE");

  const identities = matches.map(payloadIdentity).filter((value): value is NonNullable<typeof value> => value !== undefined);
  const sourceIds = [...new Set(identities.map((value) => value.sourceId))];
  if (sourceIds.length === 0) return [];
  const sourceIndexes = await store.knowledgeSourceIndex.findMany({
    where: {
      indexId: index.id,
      indexRevision: index.revision,
      status: KnowledgeSourceIndexStatus.READY,
      sourceId: { in: sourceIds },
      source: {
        status: KnowledgeSourceStatus.ACTIVE,
        OR: [
          { workspaceId: input.workspaceId, visibility: KnowledgeVisibility.WORKSPACE_PRIVATE },
          { visibility: KnowledgeVisibility.ORGANIZATION_SHARED },
        ],
        artifact: { classification: { in: classifications } },
      },
    },
    select: {
      sourceRevision: true,
      indexRevision: true,
      status: true,
      source: {
        select: {
          id: true,
          workspaceId: true,
          visibility: true,
          status: true,
          revision: true,
          artifact: { select: { id: true, filename: true, classification: true } },
        },
      },
    },
  });
  return assembleCitations(matches, sourceIndexes, input.workspaceId, index.revision);
}
