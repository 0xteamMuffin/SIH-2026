import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { artifactServiceMock, workspaceMemberMock } = vi.hoisted(() => ({
  artifactServiceMock: {
    createArtifact: vi.fn(),
    findArtifact: vi.fn(),
    getArtifact: vi.fn(),
    getArtifactMetadata: vi.fn(),
    listArtifacts: vi.fn(),
    requestArtifactDeletion: vi.fn(),
  },
  workspaceMemberMock: { findUnique: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (request: express.Request, _response: express.Response, next: express.NextFunction) => {
    request.user = { id: "30000000-0000-4000-8000-000000000001", email: "operator@example.com", role: "OPERATOR" };
    next();
  },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: { workspaceMember: workspaceMemberMock } }));
vi.mock("../src/modules/artifacts/artifacts.service.js", () => artifactServiceMock);

import { errorHandler } from "../src/lib/errors.js";
import { artifactsRouter } from "../src/modules/artifacts/artifacts.routes.js";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const artifactId = "10000000-0000-4000-8000-000000000001";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", artifactsRouter);
  app.use(errorHandler);
  return app;
}

describe("artifact routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceMemberMock.findUnique.mockResolvedValue({ workspaceId, userId: "30000000-0000-4000-8000-000000000001", role: "OPERATOR" });
  });

  it("returns the stable list envelope with validated filters and cursor", async () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-08-30T12:00:00.000Z", id: artifactId })).toString("base64url");
    artifactServiceMock.listArtifacts.mockResolvedValue({ artifacts: [{ id: artifactId, sizeBytes: "42" }], nextCursor: "next" });

    const response = await request(createTestApp()).get(`/api/workspaces/${workspaceId}/artifacts`).query({ limit: "10", kind: "SOURCE", extractionStatus: "COMPLETED", cursor });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ artifacts: [{ id: artifactId, sizeBytes: "42" }], pagination: { nextCursor: "next" } });
    expect(artifactServiceMock.listArtifacts).toHaveBeenCalledWith({
      workspaceId,
      limit: 10,
      kind: "SOURCE",
      extractionStatus: "COMPLETED",
      cursor: { createdAt: new Date("2026-08-30T12:00:00.000Z"), id: artifactId },
    });
  });

  it("rejects invalid list inputs before querying artifacts", async () => {
    const response = await request(createTestApp()).get(`/api/workspaces/${workspaceId}/artifacts`).query({ limit: "101", kind: "UNKNOWN" });

    expect(response.status).toBe(400);
    // Authenticated callers are told which field failed; the bare message is
    // reserved for unauthenticated endpoints.
    expect(response.body.error.code).toBe("INVALID_INPUT");
    expect(response.body.error.message).toMatch(/^Request validation failed — /);
    expect(artifactServiceMock.listArtifacts).not.toHaveBeenCalled();
  });

  it("prevents cross-workspace listing with the shared workspace access check", async () => {
    workspaceMemberMock.findUnique.mockResolvedValue(null);

    const response = await request(createTestApp()).get(`/api/workspaces/${workspaceId}/artifacts`);

    expect(response.status).toBe(403);
    expect(artifactServiceMock.listArtifacts).not.toHaveBeenCalled();
  });

  it("returns scoped artifact metadata in a stable envelope", async () => {
    artifactServiceMock.getArtifactMetadata.mockResolvedValue({ id: artifactId, workspaceId, sizeBytes: "42" });

    const response = await request(createTestApp()).get(`/api/artifacts/${artifactId}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ artifact: { id: artifactId, workspaceId, sizeBytes: "42" } });
    expect(artifactServiceMock.getArtifactMetadata).toHaveBeenCalledWith(artifactId, expect.objectContaining({ id: "30000000-0000-4000-8000-000000000001", role: "OPERATOR" }));
  });

  it("does not reveal inaccessible artifact metadata", async () => {
    artifactServiceMock.getArtifactMetadata.mockResolvedValue(null);

    const response = await request(createTestApp()).get(`/api/artifacts/${artifactId}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: "NOT_FOUND", message: "Artifact not found" } });
  });

  it("allows a workspace administrator to request asynchronous deletion", async () => {
    workspaceMemberMock.findUnique.mockResolvedValue({ workspaceId, userId: "30000000-0000-4000-8000-000000000001", role: "ADMIN" });
    artifactServiceMock.requestArtifactDeletion.mockResolvedValue({ artifact: { id: artifactId, lifecycleStatus: "DELETING" }, deletionJob: { id: "40000000-0000-4000-8000-000000000001", status: "QUEUED" } });

    const response = await request(createTestApp()).delete(`/api/workspaces/${workspaceId}/artifacts/${artifactId}`);

    expect(response.status).toBe(202);
    expect(artifactServiceMock.requestArtifactDeletion).toHaveBeenCalledWith({ workspaceId, artifactId, requestedBy: "30000000-0000-4000-8000-000000000001" });
  });

  it("rejects artifact deletion by a workspace operator", async () => {
    const response = await request(createTestApp()).delete(`/api/workspaces/${workspaceId}/artifacts/${artifactId}`);

    expect(response.status).toBe(403);
    expect(artifactServiceMock.requestArtifactDeletion).not.toHaveBeenCalled();
  });

  it("rejects an upload whose content does not match its extension before storage", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

    const response = await request(createTestApp())
      .post(`/api/workspaces/${workspaceId}/artifacts`)
      .field("classification", "SYNTHETIC")
      .attach("file", png, { filename: "inspection.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(415);
    expect(response.body).toEqual({ error: { code: "FILE_TYPE_MISMATCH", message: "File content does not match its extension" } });
    expect(artifactServiceMock.createArtifact).not.toHaveBeenCalled();
  });

  it("blocks cross-workspace artifact downloads before object storage is read", async () => {
    artifactServiceMock.findArtifact.mockResolvedValue({ id: artifactId, workspaceId: "20000000-0000-4000-8000-000000000002" });
    workspaceMemberMock.findUnique.mockResolvedValue(null);

    const response = await request(createTestApp()).get(`/api/artifacts/${artifactId}/download`);

    expect(response.status).toBe(403);
    expect(artifactServiceMock.getArtifact).not.toHaveBeenCalled();
  });
});
