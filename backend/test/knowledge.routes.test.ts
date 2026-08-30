import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authState, knowledgeServiceMock, workspaceMemberMock } = vi.hoisted(() => ({
  authState: { role: "OPERATOR" },
  knowledgeServiceMock: {
    createKnowledgeQuery: vi.fn(),
    createKnowledgeSource: vi.fn(),
    getKnowledgeQuery: vi.fn(),
    getKnowledgeSource: vi.fn(),
    listKnowledgeSources: vi.fn(),
    reindexKnowledgeSource: vi.fn(),
  },
  workspaceMemberMock: { findUnique: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/middleware/auth.js")>();
  return {
    ...actual,
    authenticate: (request: express.Request, _response: express.Response, next: express.NextFunction) => {
      request.user = { id: "30000000-0000-4000-8000-000000000001", email: "operator@example.com", role: authState.role as "ADMIN" | "OPERATOR" | "REVIEWER" };
      next();
    },
  };
});
vi.mock("../src/lib/prisma.js", () => ({ prisma: { workspaceMember: workspaceMemberMock } }));
vi.mock("../src/modules/knowledge/knowledge.service.js", () => knowledgeServiceMock);

import { errorHandler } from "../src/lib/errors.js";
import { knowledgeRouter } from "../src/modules/knowledge/knowledge.routes.js";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const artifactId = "10000000-0000-4000-8000-000000000001";
const sourceId = "40000000-0000-4000-8000-000000000001";
const queryId = "60000000-0000-4000-8000-000000000001";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", knowledgeRouter);
  app.use(errorHandler);
  return app;
}

describe("knowledge routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = "OPERATOR";
    workspaceMemberMock.findUnique.mockResolvedValue({ workspaceId, userId: "30000000-0000-4000-8000-000000000001" });
  });

  it("creates a private source through the stable asynchronous envelope", async () => {
    const result = { knowledgeSource: { id: sourceId }, job: { id: "70000000-0000-4000-8000-000000000001", status: "QUEUED" } };
    knowledgeServiceMock.createKnowledgeSource.mockResolvedValue(result);

    const response = await request(createTestApp()).post(`/api/workspaces/${workspaceId}/knowledge-sources`).send({ artifactId });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(result);
    expect(knowledgeServiceMock.createKnowledgeSource).toHaveBeenCalledWith({
      workspaceId,
      artifactId,
      visibility: "WORKSPACE_PRIVATE",
      actor: expect.objectContaining({ role: "OPERATOR" }),
    });
  });

  it("rejects knowledge mutations for reviewers", async () => {
    authState.role = "REVIEWER";

    const sourceResponse = await request(createTestApp()).post(`/api/workspaces/${workspaceId}/knowledge-sources`).send({ artifactId });
    const queryResponse = await request(createTestApp()).post(`/api/workspaces/${workspaceId}/knowledge-queries`).send({ queryText: "find the maintenance interval" });

    expect(sourceResponse.status).toBe(403);
    expect(queryResponse.status).toBe(403);
    expect(knowledgeServiceMock.createKnowledgeSource).not.toHaveBeenCalled();
    expect(knowledgeServiceMock.createKnowledgeQuery).not.toHaveBeenCalled();
  });

  it("returns a validated paginated source list", async () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-08-30T12:00:00.000Z", id: sourceId })).toString("base64url");
    knowledgeServiceMock.listKnowledgeSources.mockResolvedValue({ knowledgeSources: [{ id: sourceId }], nextCursor: "next" });

    const response = await request(createTestApp()).get(`/api/workspaces/${workspaceId}/knowledge-sources`).query({ limit: "10", visibility: "WORKSPACE_PRIVATE", status: "ACTIVE", cursor });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ knowledgeSources: [{ id: sourceId }], pagination: { nextCursor: "next" } });
    expect(knowledgeServiceMock.listKnowledgeSources).toHaveBeenCalledWith({
      workspaceId,
      limit: 10,
      visibility: "WORKSPACE_PRIVATE",
      status: "ACTIVE",
      cursor: { createdAt: new Date("2026-08-30T12:00:00.000Z"), id: sourceId },
    });
  });

  it("enforces workspace membership before listing", async () => {
    workspaceMemberMock.findUnique.mockResolvedValue(null);

    const response = await request(createTestApp()).get(`/api/workspaces/${workspaceId}/knowledge-sources`);

    expect(response.status).toBe(403);
    expect(knowledgeServiceMock.listKnowledgeSources).not.toHaveBeenCalled();
  });

  it("returns a source envelope without revealing inaccessible records", async () => {
    knowledgeServiceMock.getKnowledgeSource.mockResolvedValueOnce({ id: sourceId }).mockResolvedValueOnce(null);

    const found = await request(createTestApp()).get(`/api/knowledge-sources/${sourceId}`);
    const missing = await request(createTestApp()).get(`/api/knowledge-sources/${sourceId}`);

    expect(found.status).toBe(200);
    expect(found.body).toEqual({ knowledgeSource: { id: sourceId } });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: "NOT_FOUND", message: "Knowledge source not found" } });
  });

  it("queues reindexing and validates source IDs", async () => {
    const result = { knowledgeSource: { id: sourceId, revision: 2 }, job: { status: "QUEUED" } };
    knowledgeServiceMock.reindexKnowledgeSource.mockResolvedValue(result);

    const response = await request(createTestApp()).post(`/api/knowledge-sources/${sourceId}/reindex`);
    const invalid = await request(createTestApp()).post("/api/knowledge-sources/not-a-uuid/reindex");

    expect(response.status).toBe(202);
    expect(response.body).toEqual(result);
    expect(invalid.status).toBe(400);
  });

  it("creates and retrieves asynchronous knowledge queries", async () => {
    const created = { knowledgeQuery: { id: queryId, status: "QUEUED" }, job: { status: "QUEUED" } };
    knowledgeServiceMock.createKnowledgeQuery.mockResolvedValue(created);
    knowledgeServiceMock.getKnowledgeQuery.mockResolvedValue({ id: queryId, status: "QUEUED" });

    const createResponse = await request(createTestApp()).post(`/api/workspaces/${workspaceId}/knowledge-queries`).send({
      queryText: "  find the maintenance interval  ",
      topK: 5,
      filters: { artifactIds: [artifactId], classifications: ["INTERNAL"] },
    });
    const getResponse = await request(createTestApp()).get(`/api/knowledge-queries/${queryId}`);

    expect(createResponse.status).toBe(202);
    expect(createResponse.body).toEqual(created);
    expect(knowledgeServiceMock.createKnowledgeQuery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      queryText: "find the maintenance interval",
      topK: 5,
      dataClassification: "INTERNAL",
    }));
    expect(getResponse.body).toEqual({ knowledgeQuery: { id: queryId, status: "QUEUED" } });
  });

  it("rejects invalid query filters before calling the service", async () => {
    const response = await request(createTestApp()).post(`/api/workspaces/${workspaceId}/knowledge-queries`).send({
      queryText: "find anything",
      filters: { scopeKey: "organization:default" },
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: "INVALID_INPUT", message: "Request validation failed" } });
    expect(knowledgeServiceMock.createKnowledgeQuery).not.toHaveBeenCalled();
  });
});
