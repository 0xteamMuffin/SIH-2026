import {
  DataClassification,
  KnowledgeIndexStatus,
  KnowledgeSourceIndexStatus,
  KnowledgeSourceStatus,
  KnowledgeVisibility,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingModelProfile } from "../src/infrastructure/models/model-registry.js";
import type { VectorQueryMatch } from "../src/infrastructure/vector-store/vector-store-data-plane.js";
import { searchAgentKnowledge, type AgentKnowledgeSearchDependencies } from "../src/modules/agent/agent-knowledge-search.js";
import { knowledgeIndexIdentity } from "../src/modules/knowledge/knowledge-index-provisioner.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "10000000-0000-4000-8000-000000000002";
const indexId = "20000000-0000-4000-8000-000000000001";
const profile: EmbeddingModelProfile = {
  id: "local-embedding",
  providerId: "local",
  location: "local",
  baseUrl: "http://localhost:11434/v1",
  modelId: "embed-v1",
  capabilities: ["embedding"],
  priority: 1,
  enabled: true,
  sovereign: true,
  maxOutputTokens: 1,
  revision: "v1",
  dimensions: 3,
  distance: "cosine",
  maxBatchInputs: 8,
  maxBatchCharacters: 10_000,
  maxInputCharacters: 10_000,
  inputModalities: ["TEXT"],
};

function activeIndex(embeddingProfile = profile) {
  return {
    id: indexId,
    fingerprint: knowledgeIndexIdentity(embeddingProfile).fingerprint,
    collectionName: "knowledge_v1",
    vectorName: "content",
    profileId: embeddingProfile.id,
    providerId: embeddingProfile.providerId,
    modelId: embeddingProfile.modelId,
    revision: 7,
    dimensions: embeddingProfile.dimensions,
    distance: "COSINE",
    chunkerVersion: "text-v1",
    status: KnowledgeIndexStatus.ACTIVE,
  };
}

function match(pointId: string, sourceId: string, artifactId: string, ownerWorkspaceId: string, scope: string): VectorQueryMatch {
  return {
    id: pointId,
    score: 0.9,
    payload: {
      knowledge_source_id: sourceId,
      artifact_id: artifactId,
      workspace_id: ownerWorkspaceId,
      scope_key: scope,
      classification: DataClassification.INTERNAL,
      source_revision: 2,
      index_revision: 7,
      text: `Text for ${pointId}`,
      page: 4,
      line_range: { start: 8, end: 9 },
    },
  };
}

function sourceIndex(sourceId: string, artifactId: string, ownerWorkspaceId: string, visibility: KnowledgeVisibility) {
  return {
    sourceRevision: 2,
    indexRevision: 7,
    status: KnowledgeSourceIndexStatus.READY,
    source: {
      id: sourceId,
      workspaceId: ownerWorkspaceId,
      visibility,
      status: KnowledgeSourceStatus.ACTIVE,
      revision: 2,
      artifact: { id: artifactId, filename: `${sourceId}.pdf`, classification: DataClassification.INTERNAL },
    },
  };
}

function dependencies(matches: VectorQueryMatch[], sourceIndexes: ReturnType<typeof sourceIndex>[], embeddingProfile = profile) {
  const index = activeIndex(embeddingProfile);
  const store = {
    knowledgeIndex: { findFirst: vi.fn().mockResolvedValueOnce(index).mockResolvedValueOnce({ id: index.id }) },
    knowledgeSourceIndex: { findMany: vi.fn().mockResolvedValue(sourceIndexes) },
  };
  const vectorStore = { queryPoints: vi.fn().mockResolvedValue(matches) };
  const value: Partial<AgentKnowledgeSearchDependencies> = {
    store: store as unknown as AgentKnowledgeSearchDependencies["store"],
    vectorStore,
    resolveEmbeddingProfile: vi.fn().mockReturnValue(embeddingProfile),
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  };
  return { store, vectorStore, value };
}

describe("agent knowledge search", () => {
  it("derives workspace and classification filters server-side and excludes cross-workspace private results", async () => {
    const privateSource = "30000000-0000-4000-8000-000000000001";
    const sharedSource = "30000000-0000-4000-8000-000000000002";
    const leakedSource = "30000000-0000-4000-8000-000000000003";
    const privateArtifact = "40000000-0000-4000-8000-000000000001";
    const sharedArtifact = "40000000-0000-4000-8000-000000000002";
    const leakedArtifact = "40000000-0000-4000-8000-000000000003";
    const { store, vectorStore, value } = dependencies([
      match("private", privateSource, privateArtifact, workspaceId, `workspace:${workspaceId}`),
      match("shared", sharedSource, sharedArtifact, otherWorkspaceId, "organization:default"),
      match("leaked", leakedSource, leakedArtifact, otherWorkspaceId, `workspace:${otherWorkspaceId}`),
    ], [
      sourceIndex(privateSource, privateArtifact, workspaceId, KnowledgeVisibility.WORKSPACE_PRIVATE),
      sourceIndex(sharedSource, sharedArtifact, otherWorkspaceId, KnowledgeVisibility.ORGANIZATION_SHARED),
    ]);

    const citations = await searchAgentKnowledge({ workspaceId, classification: DataClassification.INTERNAL, query: "valve" }, value);

    expect(vectorStore.queryPoints).toHaveBeenCalledWith(expect.objectContaining({
      permittedScopeKeys: [`workspace:${workspaceId}`, "organization:default"],
      classifications: [DataClassification.PUBLIC, DataClassification.SYNTHETIC, DataClassification.INTERNAL],
    }));
    expect(store.knowledgeSourceIndex.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        source: expect.objectContaining({
          OR: [
            { workspaceId, visibility: KnowledgeVisibility.WORKSPACE_PRIVATE },
            { visibility: KnowledgeVisibility.ORGANIZATION_SHARED },
          ],
        }),
      }),
    }));
    expect(citations.map((citation) => citation.sourceRef)).toEqual([
      `artifact:${privateArtifact}#page=4&lines=8-9`,
      `artifact:${sharedArtifact}#page=4&lines=8-9`,
    ]);
  });

  it("returns an empty bounded result when retrieval has no matches", async () => {
    const { store, value } = dependencies([], []);

    await expect(searchAgentKnowledge({ workspaceId, classification: DataClassification.INTERNAL, query: "missing" }, value)).resolves.toEqual([]);

    expect(store.knowledgeSourceIndex.findMany).not.toHaveBeenCalled();
  });

  it("blocks a remote embedding profile for restricted run data", async () => {
    const remoteProfile: EmbeddingModelProfile = { ...profile, id: "remote-embedding", providerId: "remote", location: "remote", baseUrl: "https://example.test/v1" };
    const { value } = dependencies([], [], remoteProfile);

    await expect(searchAgentKnowledge({ workspaceId, classification: DataClassification.CONFIDENTIAL, query: "secret" }, value)).rejects.toMatchObject({ code: "EXTERNAL_INFERENCE_BLOCKED" });
    expect(value.embed).not.toHaveBeenCalled();
  });
});
