import {
  DataClassification,
  KnowledgeIndexStatus,
  KnowledgeJobStatus,
  KnowledgeJobType,
  KnowledgeQueryStatus,
  KnowledgeSourceIndexStatus,
  KnowledgeSourceStatus,
  KnowledgeVisibility,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingModelProfile } from "../src/infrastructure/models/model-registry.js";
import type { VectorQueryMatch } from "../src/infrastructure/vector-store/vector-store-data-plane.js";
import { AppError } from "../src/lib/errors.js";
import { knowledgeIndexIdentity } from "../src/modules/knowledge/knowledge-index-provisioner.js";
import { failKnowledgeQueryJob, processKnowledgeQueryJob, type KnowledgeQueryProcessorDependencies } from "../src/modules/knowledge/knowledge-query-processor.js";

const now = new Date("2026-08-30T12:00:00.000Z");
const workspaceId = "10000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "10000000-0000-4000-8000-000000000002";
const jobId = "20000000-0000-4000-8000-000000000001";
const queryId = "30000000-0000-4000-8000-000000000001";
const indexId = "40000000-0000-4000-8000-000000000001";

const profile: EmbeddingModelProfile = {
  id: "knowledge-embedding",
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

const index = {
  id: indexId,
  fingerprint: knowledgeIndexIdentity(profile).fingerprint,
  collectionName: "knowledge_v1",
  vectorName: "content",
  profileId: profile.id,
  providerId: profile.providerId,
  modelId: profile.modelId,
  revision: 7,
  dimensions: 3,
  distance: "COSINE",
  chunkerVersion: "text-v1",
  status: KnowledgeIndexStatus.ACTIVE,
  createdAt: now,
  updatedAt: now,
  activatedAt: now,
  retiredAt: null,
};

const query = {
  id: queryId,
  workspaceId,
  requestedBy: "50000000-0000-4000-8000-000000000001",
  indexId,
  indexRevision: 7,
  dataClassification: DataClassification.INTERNAL,
  status: KnowledgeQueryStatus.QUEUED,
  queryText: "Where is valve V-101?",
  topK: 10,
  filters: {},
  result: null,
  lastError: null,
  startedAt: null,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
};

function match(input: {
  pointId: string;
  sourceId: string;
  artifactId: string;
  workspace: string;
  scope: string;
  score?: number;
  sourceRevision?: number;
  extra?: Record<string, unknown>;
}): VectorQueryMatch {
  return {
    id: input.pointId,
    score: input.score ?? 0.9,
    payload: {
      knowledge_source_id: input.sourceId,
      artifact_id: input.artifactId,
      workspace_id: input.workspace,
      scope_key: input.scope,
      classification: "INTERNAL",
      source_revision: input.sourceRevision ?? 2,
      index_revision: 7,
      text: `Text for ${input.pointId}`,
      ...(input.extra ?? {}),
    },
  } as VectorQueryMatch;
}

function sourceIndex(input: {
  sourceId: string;
  artifactId: string;
  workspace?: string;
  visibility: KnowledgeVisibility;
  filename?: string;
  sourceRevision?: number;
}) {
  return {
    sourceRevision: input.sourceRevision ?? 2,
    indexRevision: 7,
    status: KnowledgeSourceIndexStatus.READY,
    source: {
      id: input.sourceId,
      workspaceId: input.workspace ?? workspaceId,
      visibility: input.visibility,
      status: KnowledgeSourceStatus.ACTIVE,
      revision: input.sourceRevision ?? 2,
      artifact: { id: input.artifactId, filename: input.filename ?? "manual.pdf", classification: DataClassification.INTERNAL },
    },
  };
}

function setup(matches: VectorQueryMatch[], sourceIndexes: ReturnType<typeof sourceIndex>[]) {
  const candidate = {
    id: jobId,
    queryId,
    type: KnowledgeJobType.EXECUTE_QUERY,
    status: KnowledgeJobStatus.QUEUED,
    attempts: 0,
    maxAttempts: 3,
    availableAt: now,
    leaseExpiresAt: null,
    startedAt: null,
  };
  const claimedJob = {
    ...candidate,
    status: KnowledgeJobStatus.RUNNING,
    attempts: 1,
    indexId,
    queryId,
    index,
    query,
  };
  const store = {
    knowledgeJob: {
      findUnique: vi.fn().mockResolvedValueOnce(candidate).mockResolvedValueOnce(claimedJob),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    knowledgeQuery: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    knowledgeIndex: { findFirst: vi.fn().mockResolvedValue({ id: indexId }) },
    knowledgeSourceIndex: { findMany: vi.fn().mockResolvedValue(sourceIndexes) },
    embeddingInvocation: {
      create: vi.fn().mockResolvedValue({ id: "60000000-0000-4000-8000-000000000001" }),
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work(store)),
  };
  const vectorStore = { queryPoints: vi.fn().mockResolvedValue(matches) };
  const dependencies: Partial<KnowledgeQueryProcessorDependencies> = {
    store: store as unknown as KnowledgeQueryProcessorDependencies["store"],
    vectorStore,
    resolveEmbeddingProfile: vi.fn().mockReturnValue(profile),
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    now: () => now,
    monotonicNow: vi.fn().mockReturnValueOnce(100).mockReturnValue(112),
    leaseDurationMs: 60_000,
  };
  return { store, vectorStore, dependencies };
}

function succeededResult(store: ReturnType<typeof setup>["store"]) {
  const call = store.knowledgeQuery.updateMany.mock.calls.find((entry) => entry[0].data.status === KnowledgeQueryStatus.SUCCEEDED);
  return call?.[0].data.result;
}

describe("knowledge query processor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("derives private and shared scopes server-side and excludes another workspace's private point", async () => {
    const privateSource = "70000000-0000-4000-8000-000000000001";
    const sharedSource = "70000000-0000-4000-8000-000000000002";
    const leakedSource = "70000000-0000-4000-8000-000000000003";
    const privateArtifact = "80000000-0000-4000-8000-000000000001";
    const sharedArtifact = "80000000-0000-4000-8000-000000000002";
    const leakedArtifact = "80000000-0000-4000-8000-000000000003";
    const matches = [
      match({ pointId: "private", sourceId: privateSource, artifactId: privateArtifact, workspace: workspaceId, scope: `workspace:${workspaceId}` }),
      match({ pointId: "shared", sourceId: sharedSource, artifactId: sharedArtifact, workspace: otherWorkspaceId, scope: "organization:default" }),
      match({ pointId: "leaked", sourceId: leakedSource, artifactId: leakedArtifact, workspace: otherWorkspaceId, scope: `workspace:${otherWorkspaceId}` }),
    ];
    const { store, vectorStore, dependencies } = setup(matches, [
      sourceIndex({ sourceId: privateSource, artifactId: privateArtifact, visibility: KnowledgeVisibility.WORKSPACE_PRIVATE }),
      sourceIndex({ sourceId: sharedSource, artifactId: sharedArtifact, workspace: otherWorkspaceId, visibility: KnowledgeVisibility.ORGANIZATION_SHARED }),
    ]);

    await processKnowledgeQueryJob(jobId, dependencies);

    expect(vectorStore.queryPoints).toHaveBeenCalledWith(expect.objectContaining({
      permittedScopeKeys: [`workspace:${workspaceId}`, "organization:default"],
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
    expect(succeededResult(store).citations.map((citation: { pointId: string }) => citation.pointId)).toEqual(["private", "shared"]);
  });

  it("post-filters stale revision and deleted-source points", async () => {
    const staleSource = "70000000-0000-4000-8000-000000000011";
    const deletedSource = "70000000-0000-4000-8000-000000000012";
    const currentSource = "70000000-0000-4000-8000-000000000013";
    const staleArtifact = "80000000-0000-4000-8000-000000000011";
    const deletedArtifact = "80000000-0000-4000-8000-000000000012";
    const currentArtifact = "80000000-0000-4000-8000-000000000013";
    const matches = [
      match({ pointId: "stale", sourceId: staleSource, artifactId: staleArtifact, workspace: workspaceId, scope: `workspace:${workspaceId}`, sourceRevision: 1, score: 0.99 }),
      match({ pointId: "deleted", sourceId: deletedSource, artifactId: deletedArtifact, workspace: workspaceId, scope: `workspace:${workspaceId}`, score: 0.98 }),
      match({ pointId: "current", sourceId: currentSource, artifactId: currentArtifact, workspace: workspaceId, scope: `workspace:${workspaceId}`, score: 0.8 }),
    ];
    const { store, dependencies } = setup(matches, [
      sourceIndex({ sourceId: staleSource, artifactId: staleArtifact, visibility: KnowledgeVisibility.WORKSPACE_PRIVATE, sourceRevision: 2 }),
      sourceIndex({ sourceId: currentSource, artifactId: currentArtifact, visibility: KnowledgeVisibility.WORKSPACE_PRIVATE }),
    ]);

    await processKnowledgeQueryJob(jobId, dependencies);

    expect(succeededResult(store).citations.map((citation: { pointId: string }) => citation.pointId)).toEqual(["current"]);
  });

  it("persists bounded deterministic citation metadata and embedding telemetry", async () => {
    const sourceId = "70000000-0000-4000-8000-000000000021";
    const artifactId = "80000000-0000-4000-8000-000000000021";
    const matches = [match({
      pointId: "citation-b",
      sourceId,
      artifactId,
      workspace: workspaceId,
      scope: `workspace:${workspaceId}`,
      extra: {
        text: "  Valve V-101 is on the feed line.  ",
        heading_path: ["Operations", "Valves"],
        page: 4,
        slide: 2,
        sheet: "P&ID",
        bbox: [10, 20, 30, 40],
        char_range: { start: 120, end: 154 },
        line_range: { start: 8, end: 9 },
      },
    })];
    const { store, dependencies } = setup(matches, [
      sourceIndex({ sourceId, artifactId, visibility: KnowledgeVisibility.WORKSPACE_PRIVATE, filename: "plant-manual.pdf" }),
    ]);

    await processKnowledgeQueryJob(jobId, dependencies);

    expect(store.embeddingInvocation.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      purpose: "QUERY",
      attempt: 1,
      inputCount: 1,
      inputCharacters: query.queryText.length,
      dimensions: 3,
    }) });
    expect(store.embeddingInvocation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SUCCEEDED", latencyMs: 12 }),
    }));
    expect(succeededResult(store)).toEqual({
      indexId,
      indexRevision: 7,
      citations: [{
        pointId: "citation-b",
        score: 0.9,
        knowledgeSourceId: sourceId,
        artifactId,
        artifactFilename: "plant-manual.pdf",
        text: "Valve V-101 is on the feed line.",
        headingPath: ["Operations", "Valves"],
        page: 4,
        slide: 2,
        sheet: "P&ID",
        bbox: [10, 20, 30, 40],
        charRange: { start: 120, end: 154 },
        lineRange: { start: 8, end: 9 },
        sourceRef: `artifact:${artifactId}#page=4&slide=2&sheet=P%26ID&chars=120-154&lines=8-9`,
      }],
    });
    expect(store.knowledgeJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: KnowledgeJobStatus.RUNNING, leaseId: expect.any(String) }),
      data: expect.objectContaining({ status: KnowledgeJobStatus.SUCCEEDED, leaseId: null }),
    }));
  });

  it("throws and lease-fenced resets job and query state after a transient embedding failure", async () => {
    const { store, vectorStore, dependencies } = setup([], []);
    const providerError = new AppError(502, "Embedding provider is unavailable", "EMBEDDING_PROVIDER_UNAVAILABLE");
    dependencies.embed = vi.fn().mockRejectedValue(providerError);

    await expect(processKnowledgeQueryJob(jobId, dependencies)).rejects.toBe(providerError);

    expect(store.embeddingInvocation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "FAILED",
        sanitizedError: "EMBEDDING_PROVIDER_UNAVAILABLE: Embedding provider is unavailable",
      }),
    }));
    expect(vectorStore.queryPoints).not.toHaveBeenCalled();
    expect(store.knowledgeJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: KnowledgeJobStatus.RUNNING, leaseId: expect.any(String) }),
      data: expect.objectContaining({ status: KnowledgeJobStatus.QUEUED, availableAt: now, leaseId: null, startedAt: null }),
    }));
    expect(store.knowledgeQuery.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: queryId, status: KnowledgeQueryStatus.RUNNING },
      data: expect.objectContaining({ status: KnowledgeQueryStatus.QUEUED, startedAt: null }),
    }));
  });

  it("fails a permanent profile mismatch without throwing or scheduling a retry", async () => {
    const { store, vectorStore, dependencies } = setup([], []);
    dependencies.resolveEmbeddingProfile = vi.fn().mockReturnValue({ ...profile, dimensions: 4 });

    await expect(processKnowledgeQueryJob(jobId, dependencies)).resolves.toBeUndefined();

    expect(vectorStore.queryPoints).not.toHaveBeenCalled();
    expect(store.knowledgeJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: KnowledgeJobStatus.RUNNING, leaseId: expect.any(String) }),
      data: expect.objectContaining({
        status: KnowledgeJobStatus.FAILED,
        lastError: expect.stringContaining("KNOWLEDGE_INDEX_PROFILE_MISMATCH"),
        leaseId: null,
      }),
    }));
    expect(store.knowledgeQuery.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: queryId, status: { in: [KnowledgeQueryStatus.QUEUED, KnowledgeQueryStatus.RUNNING] } },
      data: expect.objectContaining({ status: KnowledgeQueryStatus.FAILED }),
    }));
    expect(store.knowledgeJob.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: KnowledgeJobStatus.QUEUED }),
    }));
  });

  it("terminally fails an exhausted queued query job through the exported fail handler", async () => {
    const exhausted = new AppError(503, "Embedding provider is unavailable", "EMBEDDING_PROVIDER_UNAVAILABLE");
    const { store, dependencies } = setup([], []);
    store.knowledgeJob.findUnique.mockReset().mockResolvedValue({
      id: jobId,
      queryId,
      type: KnowledgeJobType.EXECUTE_QUERY,
      status: KnowledgeJobStatus.QUEUED,
      leaseId: null,
      leaseExpiresAt: null,
    });

    await failKnowledgeQueryJob(jobId, exhausted, { store: dependencies.store, now: dependencies.now });

    expect(store.knowledgeJob.updateMany).toHaveBeenCalledWith({
      where: { id: jobId, status: KnowledgeJobStatus.QUEUED },
      data: expect.objectContaining({ status: KnowledgeJobStatus.FAILED, leaseId: null, completedAt: now }),
    });
    expect(store.knowledgeQuery.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: queryId, status: { in: [KnowledgeQueryStatus.QUEUED, KnowledgeQueryStatus.RUNNING] } },
      data: expect.objectContaining({ status: KnowledgeQueryStatus.FAILED, completedAt: now }),
    }));
  });
});
