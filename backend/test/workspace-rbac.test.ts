import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, authState, mocks, transactionMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  authState: { role: "OPERATOR" },
  mocks: {
    user: { findFirst: vi.fn() },
    workspace: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    workspaceMember: { count: vi.fn(), create: vi.fn(), delete: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
  transactionMock: vi.fn(),
}));

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: "30000000-0000-4000-8000-000000000001", email: "actor@example.com", role: authState.role as "ADMIN" | "OPERATOR" | "REVIEWER" };
    next();
  },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: { ...mocks, $transaction: transactionMock } }));
vi.mock("../src/lib/audit.js", () => ({ audit: auditMock }));

import { errorHandler } from "../src/lib/errors.js";
import { workspacesRouter } from "../src/modules/workspaces/workspaces.routes.js";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const creatorId = "30000000-0000-4000-8000-000000000001";
const memberId = "30000000-0000-4000-8000-000000000002";

function app() {
  const application = express();
  application.use(express.json());
  application.use("/workspaces", workspacesRouter);
  application.use(errorHandler);
  return application;
}

describe("workspace RBAC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = "OPERATOR";
    transactionMock.mockImplementation((work) => work(mocks));
  });

  it("always makes a workspace creator its workspace administrator", async () => {
    mocks.workspace.create.mockResolvedValue({ id: workspaceId, name: "Operations" });

    const response = await request(app()).post("/workspaces").send({ name: "Operations" });

    expect(response.status).toBe(201);
    expect(mocks.workspace.create).toHaveBeenCalledWith({ data: expect.objectContaining({ members: { create: { userId: creatorId, role: "ADMIN" } } }) });
  });

  it("denies member administration to workspace operators", async () => {
    mocks.workspaceMember.findUnique.mockResolvedValue({ workspaceId, userId: creatorId, role: "OPERATOR" });

    const response = await request(app()).post(`/workspaces/${workspaceId}/members`).send({ userId: memberId, role: "REVIEWER" });

    expect(response.status).toBe(403);
    expect(mocks.workspaceMember.create).not.toHaveBeenCalled();
  });

  it("preserves the current global ADMIN bypass", async () => {
    authState.role = "ADMIN";
    mocks.user.findFirst.mockResolvedValue({ id: memberId });
    mocks.workspaceMember.create.mockResolvedValue({ workspaceId, userId: memberId, role: "REVIEWER", user: { id: memberId, email: "reviewer@example.com" } });

    const response = await request(app()).post(`/workspaces/${workspaceId}/members`).send({ userId: memberId, role: "REVIEWER" });

    expect(response.status).toBe(201);
    expect(mocks.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("does not remove the workspace creator", async () => {
    mocks.workspaceMember.findUnique.mockResolvedValue({ workspaceId, userId: creatorId, role: "ADMIN" });
    mocks.workspace.findUnique.mockResolvedValue({ createdBy: memberId });

    const response = await request(app()).delete(`/workspaces/${workspaceId}/members/${memberId}`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CREATOR_MEMBERSHIP_REQUIRED");
    expect(mocks.workspaceMember.delete).not.toHaveBeenCalled();
  });

  it("does not demote the last workspace administrator", async () => {
    mocks.workspaceMember.findUnique
      .mockResolvedValueOnce({ workspaceId, userId: creatorId, role: "ADMIN" })
      .mockResolvedValueOnce({ workspaceId, userId: memberId, role: "ADMIN" });
    mocks.workspace.findUnique.mockResolvedValue({ createdBy: creatorId });
    mocks.workspaceMember.count.mockResolvedValue(1);

    const response = await request(app()).patch(`/workspaces/${workspaceId}/members/${memberId}`).send({ role: "OPERATOR" });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("LAST_WORKSPACE_ADMIN_REQUIRED");
    expect(mocks.workspaceMember.update).not.toHaveBeenCalled();
  });
});
