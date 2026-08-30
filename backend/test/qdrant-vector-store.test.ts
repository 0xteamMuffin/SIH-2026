import { describe, expect, it, vi } from "vitest";
import { QdrantVectorStore, VectorStoreConfigurationError } from "../src/infrastructure/vector-store/qdrant-vector-store.js";

function createClient() {
  return {
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    collectionExists: vi.fn().mockResolvedValue({ exists: true }),
    createCollection: vi.fn().mockResolvedValue(true),
    getCollection: vi.fn().mockResolvedValue({
      config: { params: { vectors: { content: { size: 384, distance: "Cosine" } } } },
      payload_schema: {},
    }),
    createPayloadIndex: vi.fn().mockResolvedValue({ operation_id: 1, status: "completed" }),
  };
}

function createStore(client = createClient()) {
  return { client, store: new QdrantVectorStore(client as never) };
}

describe("Qdrant vector store administration", () => {
  it("uses an authenticated collection request for readiness and handles failures", async () => {
    const { client, store } = createStore();
    await expect(store.isReady()).resolves.toBe(true);

    client.getCollections.mockRejectedValueOnce(new Error("offline"));
    await expect(store.isReady()).resolves.toBe(false);
  });

  it("checks collection existence with validated input", async () => {
    const { client, store } = createStore();

    await expect(store.collectionExists({ collectionName: "workspace_knowledge" })).resolves.toBe(true);
    expect(client.collectionExists).toHaveBeenCalledWith("workspace_knowledge");
    await expect(store.collectionExists({ collectionName: "../invalid" })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("creates only a named dense vector", async () => {
    const { client, store } = createStore();

    await store.createCollection({ collectionName: "knowledge", vector: { name: "content", size: 384, distance: "cosine" } });

    expect(client.createCollection).toHaveBeenCalledWith("knowledge", {
      vectors: { content: { size: 384, distance: "Cosine" } },
    });
  });

  it("validates the named vector configuration", async () => {
    const { client, store } = createStore();

    await expect(store.validateCollection({ collectionName: "knowledge", vector: { name: "content", size: 384, distance: "cosine" } }))
      .resolves.toEqual({ valid: true, mismatches: [] });

    client.getCollection.mockResolvedValueOnce({
      config: { params: { vectors: { content: { size: 768, distance: "Dot" }, legacy: { size: 384, distance: "Cosine" } } } },
      payload_schema: {},
    });
    const result = await store.validateCollection({ collectionName: "knowledge", vector: { name: "content", size: 384, distance: "cosine" } });
    expect(result.valid).toBe(false);
    expect(result.mismatches).toHaveLength(3);
  });

  it("creates missing payload indexes and rejects conflicting schemas", async () => {
    const { client, store } = createStore();
    client.getCollection.mockResolvedValueOnce({
      config: { params: { vectors: { content: { size: 384, distance: "Cosine" } } } },
      payload_schema: { workspaceId: { data_type: "keyword", points: 0 } },
    });

    await store.ensurePayloadIndexes({
      collectionName: "knowledge",
      indexes: [{ fieldName: "workspaceId", type: "keyword" }, { fieldName: "artifactId", type: "uuid" }],
    });
    expect(client.createPayloadIndex).toHaveBeenCalledOnce();
    expect(client.createPayloadIndex).toHaveBeenCalledWith("knowledge", { field_name: "artifactId", field_schema: "uuid", wait: true });

    client.getCollection.mockResolvedValueOnce({
      config: { params: { vectors: { content: { size: 384, distance: "Cosine" } } } },
      payload_schema: { workspaceId: { data_type: "integer", points: 0 } },
    });
    await expect(store.ensurePayloadIndexes({ collectionName: "knowledge", indexes: [{ fieldName: "workspaceId", type: "keyword" }] }))
      .rejects.toBeInstanceOf(VectorStoreConfigurationError);
  });

  it("rejects duplicate and unknown payload-index input", async () => {
    const { store } = createStore();
    const duplicate = { collectionName: "knowledge", indexes: [{ fieldName: "workspaceId", type: "keyword" as const }, { fieldName: "workspaceId", type: "keyword" as const }] };

    await expect(store.ensurePayloadIndexes(duplicate)).rejects.toMatchObject({ name: "ZodError" });
    await expect(store.createPayloadIndex({ collectionName: "knowledge", index: { fieldName: "workspaceId", type: "keyword" }, extra: true } as never))
      .rejects.toMatchObject({ name: "ZodError" });
  });
});
