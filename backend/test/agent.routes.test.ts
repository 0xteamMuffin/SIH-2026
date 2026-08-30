import express from "express";
import request from "supertest";
import { ApprovalStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { approvalServiceMock, agentServiceMock, workspaceMemberMock } = vi.hoisted(() => ({
  approvalServiceMock: { decideToolApproval: vi.fn() },
  agentServiceMock: { createRun: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn(), listRuns: vi.fn() },
  workspaceMemberMock: { findUnique: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (request: express.Request, _response: express.Response, next: express.NextFunction) => {
    request.user = { id: "30000000-0000-4000-8000-000000000001", email: "reviewer@example.com", role: "REVIEWER" };
    next();
  },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: { workspaceMember: workspaceMemberMock } }));
vi.mock("../src/modules/agent/agent.service.js", () => agentServiceMock);
vi.mock("../src/modules/agent/agent-approval.service.js", () => approvalServiceMock);

import { errorHandler } from "../src/lib/errors.js";
import { agentRouter } from "../src/modules/agent/agent.routes.js";

function testApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", agentRouter);
  app.use(errorHandler);
  return app;
}

const workspaceId = "20000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000001";

describe("agent routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceMemberMock.findUnique.mockResolvedValue({ workspaceId, userId: "30000000-0000-4000-8000-000000000001", role: "REVIEWER" });
  });

  it("returns a validated, stable workspace run page", async () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-08-30T12:00:00.000Z", id: runId })).toString("base64url");
    agentServiceMock.listRuns.mockResolvedValue({ runs: [{ id: runId, status: "COMPLETED" }], nextCursor: "next" });

    const response = await request(testApp()).get(`/api/workspaces/${workspaceId}/runs`).query({ limit: "10", cursor });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ runs: [{ id: runId, status: "COMPLETED" }], pagination: { nextCursor: "next" } });
    expect(agentServiceMock.listRuns).toHaveBeenCalledWith({ workspaceId, limit: 10, cursor: { createdAt: new Date("2026-08-30T12:00:00.000Z"), id: runId } });
  });

  it("rejects invalid pagination before listing runs", async () => {
    const response = await request(testApp()).get(`/api/workspaces/${workspaceId}/runs`).query({ limit: "101", cursor: "not-json" });

    expect(response.status).toBe(400);
    expect(agentServiceMock.listRuns).not.toHaveBeenCalled();
  });

  it("prevents cross-workspace run listing", async () => {
    workspaceMemberMock.findUnique.mockResolvedValue(null);

    const response = await request(testApp()).get(`/api/workspaces/${workspaceId}/runs`);

    expect(response.status).toBe(403);
    expect(agentServiceMock.listRuns).not.toHaveBeenCalled();
  });

  it("accepts an approval decision and passes the authenticated actor", async () => {
    const approvalId = "40000000-0000-4000-8000-000000000001";
    approvalServiceMock.decideToolApproval.mockResolvedValue({ id: approvalId, status: ApprovalStatus.APPROVED });

    const response = await request(testApp()).post(`/api/agent-approvals/${approvalId}/decision`).send({ decision: "APPROVED", note: "Safe to run" });

    expect(response.status).toBe(200);
    expect(response.body.approval.status).toBe("APPROVED");
    expect(approvalServiceMock.decideToolApproval).toHaveBeenCalledWith(approvalId, expect.objectContaining({ id: "30000000-0000-4000-8000-000000000001" }), ApprovalStatus.APPROVED, "Safe to run");
  });

  it("rejects unsupported decisions before the service boundary", async () => {
    const response = await request(testApp()).post("/api/agent-approvals/40000000-0000-4000-8000-000000000001/decision").send({ decision: "SKIP" });
    expect(response.status).toBe(400);
    expect(approvalServiceMock.decideToolApproval).not.toHaveBeenCalled();
  });
});
