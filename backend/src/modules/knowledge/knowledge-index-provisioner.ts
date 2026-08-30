import { createHash } from "node:crypto";
import {
  DataClassification,
  KnowledgeIndexStatus,
  KnowledgeVectorDistance,
  Prisma,
  type KnowledgeIndex,
} from "@prisma/client";
import { selectEmbeddingProfile } from "../../infrastructure/embeddings/embedding-profile-resolver.js";
import type { EmbeddingModelProfile } from "../../infrastructure/models/model-registry.js";
import { getQdrantVectorStore } from "../../infrastructure/vector-store/qdrant-vector-store.js";
import type {
  DenseCollectionDefinition,
  PayloadIndexDefinition,
  VectorStoreAdmin,
} from "../../infrastructure/vector-store/vector-store-admin.js";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";

export const KNOWLEDGE_CHUNKER_VERSION = "text-v1";
export const KNOWLEDGE_PAYLOAD_SCHEMA_VERSION = "v1";
export const KNOWLEDGE_VECTOR_NAME = "content";

export const KNOWLEDGE_PAYLOAD_INDEXES: readonly PayloadIndexDefinition[] = Object.freeze([
  { fieldName: "scope_key", type: "keyword" },
  { fieldName: "knowledge_source_id", type: "uuid" },
  { fieldName: "artifact_id", type: "uuid" },
  { fieldName: "workspace_id", type: "uuid" },
  { fieldName: "classification", type: "keyword" },
  { fieldName: "source_revision", type: "integer" },
  { fieldName: "active", type: "bool" },
]);

type KnowledgeIndexCreateData = Pick<KnowledgeIndex,
  | "fingerprint"
  | "collectionName"
  | "vectorName"
  | "profileId"
  | "providerId"
  | "modelId"
  | "revision"
  | "dimensions"
  | "distance"
  | "chunkerVersion"
  | "status"
>;

interface KnowledgeIndexDelegate {
  findUnique(args: { where: { fingerprint: string } }): Promise<KnowledgeIndex | null>;
  create(args: { data: KnowledgeIndexCreateData }): Promise<KnowledgeIndex>;
  updateMany(args: {
    where: { status: KnowledgeIndexStatus; id: { not: string } };
    data: { status: KnowledgeIndexStatus; retiredAt: null };
  }): Promise<{ count: number }>;
  update(args: {
    where: { id: string };
    data: { status: KnowledgeIndexStatus; activatedAt: Date; retiredAt: null };
  }): Promise<KnowledgeIndex>;
}

export interface KnowledgeIndexDatabase {
  knowledgeIndex: KnowledgeIndexDelegate;
  $transaction<T>(
    work: (transaction: { knowledgeIndex: KnowledgeIndexDelegate }) => Promise<T>,
    options: { isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
}

export interface KnowledgeIndexProvisioningDependencies {
  database: KnowledgeIndexDatabase;
  vectorStore: VectorStoreAdmin;
  resolveEmbeddingProfile: () => EmbeddingModelProfile;
  now: () => Date;
  chunkerVersion: string;
  payloadSchemaVersion: string;
}

export interface KnowledgeIndexIdentity {
  fingerprint: string;
  collectionName: string;
  vectorName: string;
}

export class KnowledgeIndexProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeIndexProvisioningError";
  }
}

const distanceByProfile = {
  cosine: KnowledgeVectorDistance.COSINE,
  euclid: KnowledgeVectorDistance.EUCLID,
  dot: KnowledgeVectorDistance.DOT,
  manhattan: KnowledgeVectorDistance.MANHATTAN,
} as const;

export function knowledgeIndexIdentity(
  profile: EmbeddingModelProfile,
  chunkerVersion = KNOWLEDGE_CHUNKER_VERSION,
  payloadSchemaVersion = KNOWLEDGE_PAYLOAD_SCHEMA_VERSION,
): KnowledgeIndexIdentity {
  const canonicalMetadata = JSON.stringify({
    profileId: profile.id,
    providerId: profile.providerId,
    modelId: profile.modelId,
    modelRevision: profile.revision,
    dimensions: profile.dimensions,
    distance: profile.distance,
    inputModalities: [...profile.inputModalities].sort(),
    chunkerVersion,
    payloadSchemaVersion,
  });
  const fingerprint = createHash("sha256").update(canonicalMetadata).digest("hex");
  return {
    fingerprint,
    collectionName: `knowledge_${fingerprint.slice(0, 32)}`,
    vectorName: KNOWLEDGE_VECTOR_NAME,
  };
}

function validatePersistedIndex(index: KnowledgeIndex, expected: KnowledgeIndexCreateData): void {
  const mismatches = (Object.keys(expected) as (keyof KnowledgeIndexCreateData)[])
    .filter((field) => field !== "status")
    .filter((field) => index[field] !== expected[field]);
  if (mismatches.length > 0) {
    throw new KnowledgeIndexProvisioningError(
      `Knowledge index ${expected.fingerprint} has incompatible metadata: ${mismatches.join(", ")}`,
    );
  }
  if (index.status === KnowledgeIndexStatus.DELETING || index.status === KnowledgeIndexStatus.DELETED) {
    throw new KnowledgeIndexProvisioningError(`Knowledge index ${expected.fingerprint} is being deleted`);
  }
}

function hasPrismaCode(error: unknown, code: "P2002" | "P2034"): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function ensureCollection(vectorStore: VectorStoreAdmin, definition: DenseCollectionDefinition): Promise<void> {
  if (!(await vectorStore.collectionExists({ collectionName: definition.collectionName }))) {
    try {
      await vectorStore.createCollection(definition);
    } catch (error) {
      let createdConcurrently = false;
      try {
        createdConcurrently = await vectorStore.collectionExists({ collectionName: definition.collectionName });
      } catch {
        throw error;
      }
      if (!createdConcurrently) throw error;
    }
  }

  const validation = await vectorStore.validateCollection(definition);
  if (!validation.valid) {
    throw new KnowledgeIndexProvisioningError(
      `Knowledge collection ${definition.collectionName} is incompatible: ${validation.mismatches.join("; ")}`,
    );
  }
  await vectorStore.ensurePayloadIndexes({
    collectionName: definition.collectionName,
    indexes: [...KNOWLEDGE_PAYLOAD_INDEXES],
  });
}

async function activateIndex(
  database: KnowledgeIndexDatabase,
  expected: KnowledgeIndexCreateData,
  now: () => Date,
): Promise<KnowledgeIndex> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await database.$transaction(async (transaction) => {
        let index = await transaction.knowledgeIndex.findUnique({ where: { fingerprint: expected.fingerprint } });
        if (index) {
          validatePersistedIndex(index, expected);
        } else {
          index = await transaction.knowledgeIndex.create({ data: expected });
        }

        await transaction.knowledgeIndex.updateMany({
          where: { status: KnowledgeIndexStatus.ACTIVE, id: { not: index.id } },
          data: { status: KnowledgeIndexStatus.RETIRING, retiredAt: null },
        });
        return transaction.knowledgeIndex.update({
          where: { id: index.id },
          data: { status: KnowledgeIndexStatus.ACTIVE, activatedAt: now(), retiredAt: null },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (hasPrismaCode(error, "P2002")) {
        const winner = await database.knowledgeIndex.findUnique({ where: { fingerprint: expected.fingerprint } });
        if (!winner) throw error;
        validatePersistedIndex(winner, expected);
        continue;
      }
      if (hasPrismaCode(error, "P2034") && attempt < 2) continue;
      throw error;
    }
  }
  throw new KnowledgeIndexProvisioningError("Could not activate the knowledge index after concurrent updates");
}

export async function ensureActiveKnowledgeIndex(
  injected: Partial<KnowledgeIndexProvisioningDependencies> = {},
): Promise<KnowledgeIndex> {
  const dependencies: KnowledgeIndexProvisioningDependencies = {
    database: injected.database ?? prisma as unknown as KnowledgeIndexDatabase,
    vectorStore: injected.vectorStore ?? getQdrantVectorStore(),
    resolveEmbeddingProfile: injected.resolveEmbeddingProfile
      ?? (() => selectEmbeddingProfile(env.APP_MODE === "sovereign" ? DataClassification.CONFIDENTIAL : DataClassification.SYNTHETIC)),
    now: injected.now ?? (() => new Date()),
    chunkerVersion: injected.chunkerVersion ?? KNOWLEDGE_CHUNKER_VERSION,
    payloadSchemaVersion: injected.payloadSchemaVersion ?? KNOWLEDGE_PAYLOAD_SCHEMA_VERSION,
  };
  const profile = dependencies.resolveEmbeddingProfile();
  const identity = knowledgeIndexIdentity(profile, dependencies.chunkerVersion, dependencies.payloadSchemaVersion);
  const definition: DenseCollectionDefinition = {
    collectionName: identity.collectionName,
    vector: { name: identity.vectorName, size: profile.dimensions, distance: profile.distance },
  };
  const expected: KnowledgeIndexCreateData = {
    fingerprint: identity.fingerprint,
    collectionName: identity.collectionName,
    vectorName: identity.vectorName,
    profileId: profile.id,
    providerId: profile.providerId,
    modelId: profile.modelId,
    revision: 1,
    dimensions: profile.dimensions,
    distance: distanceByProfile[profile.distance],
    chunkerVersion: dependencies.chunkerVersion,
    status: KnowledgeIndexStatus.PROVISIONING,
  };

  await ensureCollection(dependencies.vectorStore, definition);
  return activateIndex(dependencies.database, expected, dependencies.now);
}
