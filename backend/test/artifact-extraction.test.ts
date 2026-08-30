import { ArtifactExtractionStatus, ArtifactKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { artifactMock, doclingMock, getArtifactMock, putArtifactMock } = vi.hoisted(() => ({
  artifactMock: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
  doclingMock: vi.fn(),
  getArtifactMock: vi.fn(),
  putArtifactMock: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { artifact: artifactMock } }));
vi.mock("../src/infrastructure/storage/artifact-store.js", () => ({ getArtifact: getArtifactMock, putArtifact: putArtifactMock }));
vi.mock("../src/infrastructure/docling/docling-client.js", () => ({ extractWithDocling: doclingMock }));

import { extractArtifact } from "../src/modules/artifacts/artifact-extraction.service.js";

const pendingTextArtifact = {
  id: "artifact-1",
  workspaceId: "workspace-1",
  kind: ArtifactKind.SOURCE,
  extractionStatus: ArtifactExtractionStatus.PENDING,
  extractionStartedAt: null,
  extractedObjectKey: null,
  extractionMetadata: null,
  objectKey: "workspace-1/source.txt",
  filename: "source.txt",
};

describe("artifact extraction lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    putArtifactMock.mockResolvedValue(undefined);
  });

  it("extracts UTF-8 locally and completes the claimed artifact", async () => {
    artifactMock.findUnique.mockResolvedValue(pendingTextArtifact);
    artifactMock.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    getArtifactMock.mockResolvedValue(Buffer.from("Pump,Status\nP-101,Operational\n"));

    const result = await extractArtifact("artifact-1");

    expect(result.text).toContain("P-101,Operational");
    expect(doclingMock).not.toHaveBeenCalled();
    expect(putArtifactMock).toHaveBeenCalledWith(expect.stringMatching(/^workspace-1\/extractions\/artifact-1\/[a-f0-9]{64}\.txt$/), expect.any(Buffer), "text/plain; charset=utf-8");
    expect(artifactMock.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ extractionStatus: ArtifactExtractionStatus.PROCESSING, extractionStartedAt: expect.any(Date) }),
      data: expect.objectContaining({ extractionStatus: ArtifactExtractionStatus.COMPLETED, extractionStartedAt: null, extractionError: null }),
    }));
  });

  it("reuses a completed canonical extraction", async () => {
    artifactMock.findUnique.mockResolvedValue({ ...pendingTextArtifact, extractionStatus: ArtifactExtractionStatus.COMPLETED, extractedObjectKey: "workspace-1/extractions/artifact-1/hash.md", extractionMetadata: { format: "markdown" } });
    getArtifactMock.mockResolvedValue(Buffer.from("# Existing extraction"));

    await expect(extractArtifact("artifact-1")).resolves.toMatchObject({ text: "# Existing extraction", objectKey: "workspace-1/extractions/artifact-1/hash.md" });

    expect(artifactMock.updateMany).not.toHaveBeenCalled();
    expect(putArtifactMock).not.toHaveBeenCalled();
  });

  it("allows an expired PROCESSING claim to be recovered", async () => {
    artifactMock.findUnique.mockResolvedValue({ ...pendingTextArtifact, extractionStatus: ArtifactExtractionStatus.PROCESSING, extractionStartedAt: new Date(0) });
    artifactMock.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    getArtifactMock.mockResolvedValue(Buffer.from("Recovered text"));

    await extractArtifact("artifact-1");

    expect(artifactMock.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ OR: expect.arrayContaining([expect.objectContaining({ extractionStatus: ArtifactExtractionStatus.PROCESSING, extractionStartedAt: { lte: expect.any(Date) } })]) }),
    }));
  });

  it("persists a normalized failure for the active claim", async () => {
    const pdf = { ...pendingTextArtifact, filename: "source.pdf", objectKey: "workspace-1/source.pdf" };
    artifactMock.findUnique.mockResolvedValue(pdf);
    artifactMock.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    getArtifactMock.mockResolvedValue(Buffer.from("%PDF-1.7\nfixture"));
    doclingMock.mockRejectedValue(new Error("socket internals"));

    await expect(extractArtifact("artifact-1")).rejects.toMatchObject({ code: "EXTRACTION_FAILED", message: "Document extraction failed" });

    expect(artifactMock.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ extractionStatus: ArtifactExtractionStatus.FAILED, extractionError: "[EXTRACTION_FAILED] Document extraction failed", extractionStartedAt: null }),
    }));
  });
});
