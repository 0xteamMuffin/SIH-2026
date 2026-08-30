import express from "express";
import request from "supertest";
import { ApprovalStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { approvalServiceMock, agentServiceMock } = vi.hoisted(() => ({
  approvalServiceMock: { decideToolApproval: vi.fn() },
  agentServiceMock: { createRun: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (request: express.Request, _response: express.Response, next: express.NextFunction) => {
    request.user = { id: "30000000-0000-4000-8000-000000000001", email: "reviewer@example.com", role: "REVIEWER" };
    next();
  },
}));
vi.mock("../src/middleware/workspace-access.js", () => ({
  requireWorkspaceAccess: (_request: express.Request, _response: express.Response, next: express.NextFunction) => next(),
  requireWorkspaceRole: () => (_request: express.Request, _response: express.Response, next: express.NextFunction) => next(),
}));
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

describe("agent approval routes", () => {
  beforeEach(() => vi.clearAllMocks());

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
