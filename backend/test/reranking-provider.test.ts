import { DataClassification } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RerankingModelProfile } from "../src/infrastructure/models/model-registry.js";
import { rerankDocuments, rerankIfConfigured, selectRerankingProfile } from "../src/infrastructure/models/reranking-provider.js";

const localProfile: RerankingModelProfile = {
  id: "local-reranker",
  providerId: "local",
  location: "local",
  baseUrl: "http://localhost:8080/v1",
  modelId: "reranker-v1",
  capabilities: ["reranking"],
  priority: 1,
  enabled: true,
  sovereign: true,
  maxOutputTokens: 1,
  revision: "reranker-v1.0.0",
  maxDocuments: 10,
  maxDocumentCharacters: 1_000,
  maxQueryCharacters: 500,
  maxBatchCharacters: 5_000,
};
const remoteProfile: RerankingModelProfile = { ...localProfile, id: "remote-reranker", providerId: "remote", location: "remote", baseUrl: "https://rerank.example/v1", sovereign: false };

describe("reranking provider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is a stable no-op without an eligible profile", async () => {
    const items = [{ text: "first" }, { text: "second" }];
    await expect(rerankIfConfigured({ classification: DataClassification.INTERNAL, query: "query", items, text: (item) => item.text })).resolves.toEqual(items);
  });

  it("selects no remote profile for sensitive data", () => {
    expect(selectRerankingProfile(DataClassification.CONFIDENTIAL, [remoteProfile])).toBeUndefined();
    expect(selectRerankingProfile(DataClassification.PUBLIC, [remoteProfile])?.id).toBe("remote-reranker");
  });

  it("blocks sensitive data before contacting a remote reranker", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(rerankDocuments(remoteProfile, DataClassification.INTERNAL, "private query", ["private document"]))
      .rejects.toMatchObject({ code: "EXTERNAL_INFERENCE_BLOCKED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the provider's validated ordering", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      results: [{ index: 1, relevance_score: 0.95 }, { index: 0, relevance_score: 0.4 }],
    }), { status: 200 }));

    await expect(rerankDocuments(localProfile, DataClassification.CONFIDENTIAL, "valve", ["pump", "valve"])).resolves.toEqual([
      { index: 1, score: 0.95 },
      { index: 0, score: 0.4 },
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ model: "reranker-v1", query: "valve", documents: ["pump", "valve"], top_n: 2 });
  });

  it("rejects incomplete or duplicate rankings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }],
    }), { status: 200 }));

    await expect(rerankDocuments(localProfile, DataClassification.INTERNAL, "query", ["one", "two"]))
      .rejects.toMatchObject({ code: "RERANKING_RESPONSE_INVALID" });
  });
});
