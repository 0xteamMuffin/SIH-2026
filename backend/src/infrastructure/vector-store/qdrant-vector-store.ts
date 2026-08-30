import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";
import { env } from "../../config/env.js";
import type {
  CollectionReference,
  CollectionValidation,
  DenseCollectionDefinition,
  DenseVectorDistance,
  PayloadIndexDefinition,
  VectorStoreAdmin,
} from "./vector-store-admin.js";

const identifierSchema = z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const payloadFieldSchema = z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const collectionReferenceSchema = z.object({ collectionName: identifierSchema }).strict();
const vectorSchema = z.object({
  name: identifierSchema,
  size: z.number().int().min(1).max(65_536),
  distance: z.enum(["cosine", "euclid", "dot", "manhattan"]),
}).strict();
const collectionDefinitionSchema = collectionReferenceSchema.extend({ vector: vectorSchema }).strict();
const payloadIndexSchema = z.object({
  fieldName: payloadFieldSchema,
  type: z.enum(["keyword", "integer", "float", "geo", "text", "bool", "datetime", "uuid"]),
}).strict();
const createPayloadIndexSchema = collectionReferenceSchema.extend({ index: payloadIndexSchema }).strict();
const ensurePayloadIndexesSchema = collectionReferenceSchema.extend({
  indexes: z.array(payloadIndexSchema).max(64).superRefine((indexes, context) => {
    const seen = new Set<string>();
    for (const [index, definition] of indexes.entries()) {
      if (seen.has(definition.fieldName)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Payload index fields must be unique", path: [index, "fieldName"] });
      }
      seen.add(definition.fieldName);
    }
  }),
}).strict();

type QdrantAdministrationClient = Pick<QdrantClient,
  "getCollections" | "collectionExists" | "createCollection" | "getCollection" | "createPayloadIndex"
>;

const qdrantDistance: Record<DenseVectorDistance, "Cosine" | "Euclid" | "Dot" | "Manhattan"> = {
  cosine: "Cosine",
  euclid: "Euclid",
  dot: "Dot",
  manhattan: "Manhattan",
};

export class VectorStoreConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorStoreConfigurationError";
  }
}

export class QdrantVectorStore implements VectorStoreAdmin {
  constructor(private readonly client: QdrantAdministrationClient) {}

  async isReady(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  async collectionExists(input: CollectionReference): Promise<boolean> {
    const parsed = collectionReferenceSchema.parse(input);
    return (await this.client.collectionExists(parsed.collectionName)).exists;
  }

  async createCollection(input: DenseCollectionDefinition): Promise<void> {
    const parsed = collectionDefinitionSchema.parse(input);
    const created = await this.client.createCollection(parsed.collectionName, {
      vectors: {
        [parsed.vector.name]: {
          size: parsed.vector.size,
          distance: qdrantDistance[parsed.vector.distance],
        },
      },
    });
    if (!created) throw new Error(`Qdrant did not create collection ${parsed.collectionName}`);
  }

  async validateCollection(input: DenseCollectionDefinition): Promise<CollectionValidation> {
    const parsed = collectionDefinitionSchema.parse(input);
    const collection = await this.client.getCollection(parsed.collectionName);
    const vectors = collection.config.params.vectors;
    const mismatches: string[] = [];

    if (!vectors || "size" in vectors) {
      mismatches.push(`expected named dense vector ${parsed.vector.name}`);
      return { valid: false, mismatches };
    }

    const names = Object.keys(vectors);
    const actual = vectors[parsed.vector.name];
    if (!actual) mismatches.push(`missing dense vector ${parsed.vector.name}`);
    if (names.length !== 1 || names[0] !== parsed.vector.name) mismatches.push(`expected only dense vector ${parsed.vector.name}`);
    if (actual?.size !== parsed.vector.size) mismatches.push(`dense vector ${parsed.vector.name} must have size ${parsed.vector.size}`);
    if (actual?.distance !== qdrantDistance[parsed.vector.distance]) mismatches.push(`dense vector ${parsed.vector.name} must use ${parsed.vector.distance} distance`);

    return { valid: mismatches.length === 0, mismatches };
  }

  async createPayloadIndex(input: CollectionReference & { index: PayloadIndexDefinition }): Promise<void> {
    const parsed = createPayloadIndexSchema.parse(input);
    await this.client.createPayloadIndex(parsed.collectionName, {
      field_name: parsed.index.fieldName,
      field_schema: parsed.index.type,
      wait: true,
    });
  }

  async ensurePayloadIndexes(input: CollectionReference & { indexes: PayloadIndexDefinition[] }): Promise<void> {
    const parsed = ensurePayloadIndexesSchema.parse(input);
    const collection = await this.client.getCollection(parsed.collectionName);

    for (const index of parsed.indexes) {
      const existing = collection.payload_schema[index.fieldName];
      if (existing && existing.data_type !== index.type) {
        throw new VectorStoreConfigurationError(`Payload index ${index.fieldName} is ${existing.data_type}, expected ${index.type}`);
      }
      if (!existing) await this.createPayloadIndex({ collectionName: parsed.collectionName, index });
    }
  }
}

let configuredStore: QdrantVectorStore | undefined;

export function getQdrantVectorStore(): QdrantVectorStore {
  configuredStore ??= new QdrantVectorStore(new QdrantClient({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY,
    timeout: 5_000,
    checkCompatibility: false,
  }));
  return configuredStore;
}
