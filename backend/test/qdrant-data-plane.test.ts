import { describe, expect, it, vi } from "vitest";
import { QdrantDataPlane } from "../src/infrastructure/vector-store/qdrant-data-plane.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const artifactId = "20000000-0000-4000-8000-000000000001";
const sourceId = "30000000-0000-4000-8000-000000000001";
const pointId = "40000000-0000-4000-8000-000000000001";
const privateScopeKey = `workspace:${workspaceId}`;
const sharedScopeKey = "organization:default";

function createClient() {
  return {
    upsert: vi.fn().mockResolvedValue({ operation_id: 1, status: "completed" }),
    query: vi.fn().mockResolvedValue({ points: [] }),
    delete: vi.fn().mockResolvedValue({ operation_id: 2, status: "completed" }),
    count: vi.fn().mockResolvedValue({ count: 0 }),
    scroll: vi.fn().mockResolvedValue({ points: [], next_page_offset: null }),
  };
}

function createDataPlane(client = createClient()) {
  return { client, dataPlane: new QdrantDataPlane(client as never) };
}

describe("Qdrant data plane", () => {
  it("upserts named vectors synchronously and injects trusted payload fields", async () => {
    const { client, dataPlane } = createDataPlane();

    await dataPlane.upsertPoints({
      collectionName: "knowledge",
      vectorName: "content",
      scope: { workspaceId, scopeKey: privateScopeKey },
      points: [{
        id: pointId,
        vector: [0.1, 0.2],
        knowledgeSourceId: sourceId,
        artifactId,
        classification: "INTERNAL",
        payload: { text: "validated chunk", page: 3 },
      }],
    });

    expect(client.upsert).toHaveBeenCalledWith("knowledge", {
      wait: true,
      points: [{
        id: pointId,
        vector: { content: [0.1, 0.2] },
        payload: {
          text: "validated chunk",
          page: 3,
          scope_key: privateScopeKey,
          workspace_id: workspaceId,
          artifact_id: artifactId,
          classification: "INTERNAL",
          knowledge_source_id: sourceId,
        },
      }],
    });
  });

  it("rejects malformed points, unknown input, and reserved payload keys", async () => {
    const { dataPlane } = createDataPlane();
    const valid = {
      collectionName: "knowledge",
      vectorName: "content",
      scope: { workspaceId, scopeKey: privateScopeKey },
      points: [{ id: pointId, vector: [0.1], knowledgeSourceId: sourceId, artifactId, classification: "PUBLIC" as const }],
    };

    await expect(dataPlane.upsertPoints({ ...valid, extra: true } as never)).rejects.toMatchObject({ name: "ZodError" });
    await expect(dataPlane.upsertPoints({ ...valid, points: [{ ...valid.points[0], vector: [Number.NaN] }] })).rejects.toMatchObject({ name: "ZodError" });
    await expect(dataPlane.upsertPoints({ ...valid, scope: { workspaceId, scopeKey: `workspace:${artifactId}` } })).rejects.toMatchObject({ name: "ZodError" });
    await expect(dataPlane.upsertPoints({ ...valid, points: [{ ...valid.points[0], payload: { workspace_id: "spoofed" } }] })).rejects.toMatchObject({ name: "ZodError" });
    await expect(dataPlane.upsertPoints({ ...valid, points: [{ ...valid.points[0], payload: { scope_key: sharedScopeKey } }] })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("queries workspace-private knowledge with a mandatory permitted scope key", async () => {
    const { client, dataPlane } = createDataPlane();

    await dataPlane.queryPoints({
      collectionName: "knowledge",
      vectorName: "content",
      vector: [0.4, 0.5],
      permittedScopeKeys: [privateScopeKey],
    });

    expect(client.query).toHaveBeenCalledWith("knowledge", expect.objectContaining({
      filter: { must: [{ key: "scope_key", match: { any: [privateScopeKey] } }] },
    }));
  });

  it("queries workspace-private and organization-shared knowledge with optional filters", async () => {
    const { client, dataPlane } = createDataPlane();
    client.query.mockResolvedValueOnce({ points: [{ id: pointId, score: 0.91, payload: { text: "match" } }] });

    await expect(dataPlane.queryPoints({
      collectionName: "knowledge",
      vectorName: "content",
      vector: [0.4, 0.5],
      permittedScopeKeys: [privateScopeKey, sharedScopeKey],
      artifactIds: [artifactId],
      classifications: ["INTERNAL", "CONFIDENTIAL"],
      limit: 5,
      scoreThreshold: 0.7,
    })).resolves.toEqual([{ id: pointId, score: 0.91, payload: { text: "match" } }]);

    expect(client.query).toHaveBeenCalledWith("knowledge", {
      query: [0.4, 0.5],
      using: "content",
      filter: { must: [
        { key: "scope_key", match: { any: [privateScopeKey, sharedScopeKey] } },
        { key: "artifact_id", match: { any: [artifactId] } },
        { key: "classification", match: { any: ["INTERNAL", "CONFIDENTIAL"] } },
      ] },
      limit: 5,
      score_threshold: 0.7,
      with_payload: true,
      with_vector: false,
    });
  });

  it("rejects empty or malformed scopes, raw filters, and out-of-range query limits", async () => {
    const { dataPlane } = createDataPlane();
    const query = { collectionName: "knowledge", vectorName: "content", vector: [0.1], permittedScopeKeys: [privateScopeKey] };

    await expect(dataPlane.queryPoints({ ...query, permittedScopeKeys: [] })).rejects.toMatchObject({ name: "ZodError" });
    await expect(dataPlane.queryPoints({ ...query, permittedScopeKeys: ["workspace:not-a-uuid"] })).rejects.toMatchObject({ name: "ZodError" });
    await expect(dataPlane.queryPoints({ ...query, permittedScopeKeys: ["organization:"] })).rejects.toMatchObject({ name: "ZodError" });
    await expect(dataPlane.queryPoints({ ...query, filter: { must: [] } } as never)).rejects.toMatchObject({ name: "ZodError" });
    await expect(dataPlane.queryPoints({ ...query, limit: 101 })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("deletes a knowledge source synchronously with a fixed filter", async () => {
    const { client, dataPlane } = createDataPlane();

    await dataPlane.deleteByKnowledgeSourceId({ collectionName: "knowledge", knowledgeSourceId: sourceId });

    expect(client.delete).toHaveBeenCalledWith("knowledge", {
      wait: true,
      filter: { must: [{ key: "knowledge_source_id", match: { value: sourceId } }] },
    });
  });

  it("provides exact count and bounded payload-only scrolling for reconciliation", async () => {
    const { client, dataPlane } = createDataPlane();
    client.count.mockResolvedValueOnce({ count: 7 });
    client.scroll.mockResolvedValueOnce({
      points: [{ id: pointId, payload: { knowledge_source_id: sourceId } }],
      next_page_offset: 42,
    });

    await expect(dataPlane.countPoints({ collectionName: "knowledge", scope: { workspaceId, scopeKey: privateScopeKey }, knowledgeSourceId: sourceId }))
      .resolves.toBe(7);
    expect(client.count).toHaveBeenCalledWith("knowledge", {
      exact: true,
      filter: { must: [
        { key: "scope_key", match: { value: privateScopeKey } },
        { key: "workspace_id", match: { value: workspaceId } },
        { key: "knowledge_source_id", match: { value: sourceId } },
      ] },
    });

    await expect(dataPlane.scrollPoints({ collectionName: "knowledge", knowledgeSourceId: sourceId, cursor: 10, limit: 250 }))
      .resolves.toEqual({
        points: [{ id: pointId, payload: { knowledge_source_id: sourceId } }],
        nextCursor: 42,
      });
    expect(client.scroll).toHaveBeenCalledWith("knowledge", {
      filter: { must: [{ key: "knowledge_source_id", match: { value: sourceId } }] },
      limit: 250,
      offset: 10,
      with_payload: true,
      with_vector: false,
    });

    await expect(dataPlane.scrollPoints({ collectionName: "knowledge", limit: 1_001 })).rejects.toMatchObject({ name: "ZodError" });
  });
});
