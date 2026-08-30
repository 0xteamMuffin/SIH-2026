import {
  KnowledgeIndexStatus,
  KnowledgeVectorDistance,
  type KnowledgeIndex,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingModelProfile } from "../src/infrastructure/models/model-registry.js";
import {
  ensureActiveKnowledgeIndex,
  knowledgeIndexIdentity,
  KnowledgeIndexProvisioningError,
  type KnowledgeIndexDatabase,
} from "../src/modules/knowledge/knowledge-index-provisioner.js";

function profile(overrides: Partial<EmbeddingModelProfile> = {}): EmbeddingModelProfile {
  return {
    id: "text-primary",
    providerId: "local",
    location: "local",
    baseUrl: "http://localhost:11434/v1",
    modelId: "embed-v1",
    capabilities: ["embedding"],
    priority: 10,
    enabled: true,
    sovereign: true,
    maxOutputTokens: 2_048,
    revision: "weights-2026-08",
    dimensions: 384,
    distance: "cosine",
    maxBatchInputs: 16,
    maxBatchCharacters: 8_192,
    maxInputCharacters: 4_096,
    inputModalities: ["TEXT"],
    ...overrides,
  };
}

function row(overrides: Partial<KnowledgeIndex> = {}): KnowledgeIndex {
  const identity = knowledgeIndexIdentity(profile());
  return {
    id: "index-1",
    fingerprint: identity.fingerprint,
    collectionName: identity.collectionName,
    vectorName: identity.vectorName,
    profileId: "text-primary",
    providerId: "local",
    modelId: "embed-v1",
    revision: 1,
    dimensions: 384,
    distance: KnowledgeVectorDistance.COSINE,
    chunkerVersion: "text-v1",
    status: KnowledgeIndexStatus.PROVISIONING,
    createdAt: new Date("2026-08-30T00:00:00Z"),
    updatedAt: new Date("2026-08-30T00:00:00Z"),
    activatedAt: null,
    retiredAt: null,
    ...overrides,
  };
}

function vectorStore(overrides: Record<string, unknown> = {}) {
  return {
    isReady: vi.fn().mockResolvedValue(true),
    collectionExists: vi.fn().mockResolvedValue(false),
    createCollection: vi.fn().mockResolvedValue(undefined),
    validateCollection: vi.fn().mockResolvedValue({ valid: true, mismatches: [] }),
    createPayloadIndex: vi.fn().mockResolvedValue(undefined),
    ensurePayloadIndexes: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function database(existing: KnowledgeIndex | null = null) {
  let current = existing;
  const delegate = {
    findUnique: vi.fn(async () => current),
    create: vi.fn(async ({ data }: { data: Partial<KnowledgeIndex> }) => {
      current = row(data);
      return current;
    }),
    updateMany: vi.fn().mockResolvedValue({ count: existing?.status === KnowledgeIndexStatus.ACTIVE ? 1 : 0 }),
    update: vi.fn(async ({ data }: { data: Partial<KnowledgeIndex> }) => {
      current = { ...current!, ...data };
      return current;
    }),
  };
  return {
    delegate,
    store: {
      knowledgeIndex: delegate,
      $transaction: vi.fn(async (work) => work({ knowledgeIndex: delegate })),
    } as KnowledgeIndexDatabase,
  };
}

const fixedNow = new Date("2026-08-30T12:00:00Z");

describe("knowledge index provisioning", () => {
  it("derives a stable identity from immutable vector, chunker, and payload metadata", () => {
    const first = knowledgeIndexIdentity(profile());
    const operationalChange = knowledgeIndexIdentity(profile({ priority: 999, baseUrl: "http://other.local/v1" }));

    expect(first).toEqual(operationalChange);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.collectionName).toBe(`knowledge_${first.fingerprint.slice(0, 32)}`);
    expect(knowledgeIndexIdentity(profile({ revision: "weights-2026-09" })).fingerprint).not.toBe(first.fingerprint);
    expect(knowledgeIndexIdentity(profile(), "text-v2").fingerprint).not.toBe(first.fingerprint);
    expect(knowledgeIndexIdentity(profile(), "text-v1", "v2").fingerprint).not.toBe(first.fingerprint);
  });

  it("creates and validates the named collection, payload indexes, and active DB row", async () => {
    const vectors = vectorStore();
    const db = database();

    const result = await ensureActiveKnowledgeIndex({
      database: db.store,
      vectorStore: vectors,
      resolveEmbeddingProfile: () => profile(),
      now: () => fixedNow,
    });
    const identity = knowledgeIndexIdentity(profile());
    const definition = {
      collectionName: identity.collectionName,
      vector: { name: "content", size: 384, distance: "cosine" },
    };

    expect(vectors.createCollection).toHaveBeenCalledWith(definition);
    expect(vectors.validateCollection).toHaveBeenCalledWith(definition);
    expect(vectors.ensurePayloadIndexes).toHaveBeenCalledWith({
      collectionName: identity.collectionName,
      indexes: [
        { fieldName: "scope_key", type: "keyword" },
        { fieldName: "knowledge_source_id", type: "uuid" },
        { fieldName: "artifact_id", type: "uuid" },
        { fieldName: "workspace_id", type: "uuid" },
        { fieldName: "classification", type: "keyword" },
        { fieldName: "source_revision", type: "integer" },
        { fieldName: "active", type: "bool" },
      ],
    });
    expect(db.delegate.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      fingerprint: identity.fingerprint,
      collectionName: identity.collectionName,
      vectorName: "content",
      revision: 1,
      distance: KnowledgeVectorDistance.COSINE,
      status: KnowledgeIndexStatus.PROVISIONING,
    }) });
    expect(db.delegate.updateMany).toHaveBeenCalledWith({
      where: { status: KnowledgeIndexStatus.ACTIVE, id: { not: "index-1" } },
      data: { status: KnowledgeIndexStatus.RETIRING, retiredAt: null },
    });
    expect(db.store.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(result).toMatchObject({ status: KnowledgeIndexStatus.ACTIVE, activatedAt: fixedNow });
  });

  it("reuses and validates an existing collection and index", async () => {
    const vectors = vectorStore({ collectionExists: vi.fn().mockResolvedValue(true) });
    const existing = row({ status: KnowledgeIndexStatus.ACTIVE, activatedAt: fixedNow });
    const db = database(existing);

    await expect(ensureActiveKnowledgeIndex({
      database: db.store,
      vectorStore: vectors,
      resolveEmbeddingProfile: () => profile(),
      now: () => fixedNow,
    })).resolves.toMatchObject({ id: existing.id, status: KnowledgeIndexStatus.ACTIVE });

    expect(vectors.createCollection).not.toHaveBeenCalled();
    expect(db.delegate.create).not.toHaveBeenCalled();
  });

  it("does not activate a database row when collection validation fails", async () => {
    const vectors = vectorStore({
      collectionExists: vi.fn().mockResolvedValue(true),
      validateCollection: vi.fn().mockResolvedValue({ valid: false, mismatches: ["wrong dimensions"] }),
    });
    const db = database();

    await expect(ensureActiveKnowledgeIndex({
      database: db.store,
      vectorStore: vectors,
      resolveEmbeddingProfile: () => profile(),
    })).rejects.toThrow("wrong dimensions");
    expect(db.store.$transaction).not.toHaveBeenCalled();
  });

  it("continues when another provisioner wins collection creation", async () => {
    const collectionExists = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const vectors = vectorStore({
      collectionExists,
      createCollection: vi.fn().mockRejectedValue(new Error("already exists")),
    });
    const db = database();

    await expect(ensureActiveKnowledgeIndex({
      database: db.store,
      vectorStore: vectors,
      resolveEmbeddingProfile: () => profile(),
    })).resolves.toMatchObject({ status: KnowledgeIndexStatus.ACTIVE });
    expect(collectionExists).toHaveBeenCalledTimes(2);
  });

  it("reloads, validates, and activates the winner after a concurrent unique race", async () => {
    const winner = row();
    const db = database(winner);
    const transaction = vi.fn()
      .mockRejectedValueOnce({ code: "P2002" })
      .mockImplementation(async (work) => work({ knowledgeIndex: db.delegate }));
    db.store.$transaction = transaction;

    await expect(ensureActiveKnowledgeIndex({
      database: db.store,
      vectorStore: vectorStore({ collectionExists: vi.fn().mockResolvedValue(true) }),
      resolveEmbeddingProfile: () => profile(),
    })).resolves.toMatchObject({ id: winner.id, status: KnowledgeIndexStatus.ACTIVE });

    expect(db.delegate.findUnique).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("rejects incompatible metadata loaded after a unique race", async () => {
    const db = database(row({ dimensions: 768 }));
    db.store.$transaction = vi.fn().mockRejectedValue({ code: "P2002" });

    await expect(ensureActiveKnowledgeIndex({
      database: db.store,
      vectorStore: vectorStore({ collectionExists: vi.fn().mockResolvedValue(true) }),
      resolveEmbeddingProfile: () => profile(),
    })).rejects.toBeInstanceOf(KnowledgeIndexProvisioningError);
    expect(db.store.$transaction).toHaveBeenCalledOnce();
  });
});
