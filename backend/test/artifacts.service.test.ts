import { ArtifactExtractionStatus, ArtifactKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { artifactMock } = vi.hoisted(() => ({
  artifactMock: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { artifact: artifactMock } }));

import { getArtifactMetadata, listArtifacts } from "../src/modules/artifacts/artifacts.service.js";

const firstArtifact = {
  id: "10000000-0000-4000-8000-000000000002",
  workspaceId: "20000000-0000-4000-8000-000000000001",
  createdBy: "30000000-0000-4000-8000-000000000001",
  kind: ArtifactKind.SOURCE,
  classification: "INTERNAL",
  sha256: "abc",
  detectedMimeType: "application/pdf",
  extractionStatus: ArtifactExtractionStatus.COMPLETED,
  extractionMetadata: { pages: 2 },
  extractionError: null,
  extractionStartedAt: new Date("2026-08-30T11:59:00.000Z"),
  extractedAt: new Date("2026-08-30T12:00:00.000Z"),
  filename: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 9007199254740993n,
  createdAt: new Date("2026-08-30T12:00:00.000Z"),
};

describe("artifact service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists a filtered workspace page and returns an exact BigInt string and stable cursor", async () => {
    const secondArtifact = { ...firstArtifact, id: "10000000-0000-4000-8000-000000000001", createdAt: new Date("2026-08-30T11:00:00.000Z") };
    artifactMock.findMany.mockResolvedValue([firstArtifact, secondArtifact]);

    const result = await listArtifacts({
      workspaceId: firstArtifact.workspaceId,
      limit: 1,
      kind: ArtifactKind.SOURCE,
      extractionStatus: ArtifactExtractionStatus.COMPLETED,
    });

    expect(artifactMock.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: firstArtifact.workspaceId, kind: ArtifactKind.SOURCE, extractionStatus: ArtifactExtractionStatus.COMPLETED }),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
    }));
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ id: firstArtifact.id, sizeBytes: "9007199254740993" });
    expect(JSON.parse(Buffer.from(result.nextCursor!, "base64url").toString("utf8"))).toEqual({ createdAt: firstArtifact.createdAt.toISOString(), id: firstArtifact.id });
  });

  it("applies a composite keyset cursor", async () => {
    artifactMock.findMany.mockResolvedValue([]);
    const cursor = { createdAt: new Date("2026-08-30T12:00:00.000Z"), id: firstArtifact.id };

    await listArtifacts({ workspaceId: firstArtifact.workspaceId, limit: 25, cursor });

    expect(artifactMock.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: firstArtifact.workspaceId,
        OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
      }),
    }));
  });

  it("scopes metadata reads to the actor's workspace membership", async () => {
    artifactMock.findFirst.mockResolvedValue(firstArtifact);

    const artifact = await getArtifactMetadata(firstArtifact.id, { id: "user-1", role: "OPERATOR" });

    expect(artifactMock.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: firstArtifact.id, workspace: { members: { some: { userId: "user-1" } } } },
    }));
    expect(artifact).toMatchObject({ id: firstArtifact.id, sizeBytes: "9007199254740993" });
  });

  it("allows administrators to read artifact metadata without membership", async () => {
    artifactMock.findFirst.mockResolvedValue(firstArtifact);

    await getArtifactMetadata(firstArtifact.id, { id: "admin-1", role: "ADMIN" });

    expect(artifactMock.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: firstArtifact.id } }));
  });
});
