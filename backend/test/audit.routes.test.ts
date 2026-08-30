import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditEventMock, authState, membershipMock } = vi.hoisted(() => ({
  auditEventMock: { findMany: vi.fn() },
  authState: { role: "OPERATOR" },
  membershipMock: { findUnique: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: "30000000-0000-4000-8000-000000000001", email: "actor@example.com", role: authState.role as "ADMIN" | "OPERATOR" };
    next();
  },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: { auditEvent: auditEventMock, workspaceMember: membershipMock } }));

import { errorHandler } from "../src/lib/errors.js";
import { auditRouter } from "../src/modules/audit/audit.routes.js";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const actorId = "30000000-0000-4000-8000-000000000001";
const runId = "40000000-0000-4000-8000-000000000001";
const events = [
  { id: "50000000-0000-4000-8000-000000000002", actorId, workspaceId, runId, eventType: "AGENT_RUN_COMPLETED", metadata: { sovereign: true }, createdAt: new Date("2026-08-30T12:00:00.000Z") },
  { id: "50000000-0000-4000-8000-000000000001", actorId, workspaceId, runId: null, eventType: "ARTIFACT_UPLOADED", metadata: { artifactId: "safe-id" }, createdAt: new Date("2026-08-30T11:00:00.000Z") },
];

function app() {
  const application = express();
  application.use("/api", auditRouter);
  application.use(errorHandler);
  return application;
}

describe("workspace audit events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = "OPERATOR";
    membershipMock.findUnique.mockResolvedValue({ workspaceId, userId: actorId, role: "OPERATOR" });
  });

  it("paginates and filters inside the requested workspace", async () => {
    auditEventMock.findMany.mockResolvedValueOnce(events).mockResolvedValueOnce([]);
    const response = await request(app()).get(`/api/workspaces/${workspaceId}/audit-events?limit=1&eventType=AGENT_RUN_COMPLETED&actorId=${actorId}&runId=${runId}&from=2026-08-01T00:00:00.000Z&to=2026-08-31T00:00:00.000Z`);

    expect(response.status).toBe(200);
    expect(response.body.auditEvents).toEqual([expect.objectContaining({ eventType: "AGENT_RUN_COMPLETED", metadata: { sovereign: true } })]);
    expect(response.body.pagination.nextCursor).toEqual(expect.any(String));
    expect(auditEventMock.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId, eventType: "AGENT_RUN_COMPLETED", actorId, runId }),
      take: 2,
      select: { id: true, actorId: true, workspaceId: true, runId: true, eventType: true, metadata: true, createdAt: true },
    }));

    await request(app()).get(`/api/workspaces/${workspaceId}/audit-events?limit=1&cursor=${response.body.pagination.nextCursor}`);
    expect(auditEventMock.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId,
        OR: [
          { createdAt: { lt: events[0].createdAt } },
          { createdAt: events[0].createdAt, id: { lt: events[0].id } },
        ],
      }),
    }));
  });

  it("rejects invalid date ranges before querying", async () => {
    const response = await request(app()).get(`/api/workspaces/${workspaceId}/audit-events?from=2026-09-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z`);

    expect(response.status).toBe(400);
    expect(auditEventMock.findMany).not.toHaveBeenCalled();
  });

  it("allows workspace administrators to export NDJSON", async () => {
    membershipMock.findUnique.mockResolvedValue({ workspaceId, userId: actorId, role: "ADMIN" });
    auditEventMock.findMany.mockResolvedValue(events);
    const response = await request(app()).get(`/api/workspaces/${workspaceId}/audit-events/export?format=ndjson`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(response.text.trim().split("\n")).toHaveLength(2);
    expect(response.text).not.toContain("task");
  });

  it("denies export to non-admin workspace members", async () => {
    const response = await request(app()).get(`/api/workspaces/${workspaceId}/audit-events/export`);

    expect(response.status).toBe(403);
    expect(auditEventMock.findMany).not.toHaveBeenCalled();
  });
});
