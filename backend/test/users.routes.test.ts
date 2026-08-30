import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, authState, refreshSessionMock, transactionMock, userMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  authState: { role: "ADMIN" },
  refreshSessionMock: { updateMany: vi.fn() },
  transactionMock: vi.fn(),
  userMock: { count: vi.fn(), create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/middleware/auth.js")>();
  return {
    ...actual,
    authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: "30000000-0000-4000-8000-000000000001", email: "admin@example.com", role: authState.role as "ADMIN" | "OPERATOR" };
      next();
    },
  };
});
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { refreshSession: refreshSessionMock, user: userMock, $transaction: transactionMock },
}));
vi.mock("../src/lib/audit.js", () => ({ audit: auditMock }));

import { errorHandler } from "../src/lib/errors.js";
import { usersRouter } from "../src/modules/users/users.routes.js";

const targetId = "30000000-0000-4000-8000-000000000002";
const safeUser = { id: targetId, email: "new@example.com", role: "OPERATOR", disabledAt: null, createdAt: new Date(), updatedAt: new Date() };

function app() {
  const application = express();
  application.use(express.json());
  application.use("/users", usersRouter);
  application.use(errorHandler);
  return application;
}

describe("user administration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = "ADMIN";
    transactionMock.mockImplementation((work) => work({ refreshSession: refreshSessionMock, user: userMock }));
  });

  it("creates users without exposing password hashes", async () => {
    userMock.create.mockResolvedValue(safeUser);

    const response = await request(app()).post("/users").send({ email: "NEW@example.com", password: "long-password-123", role: "OPERATOR" });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe("new@example.com");
    expect(response.text).not.toContain("passwordHash");
    expect(userMock.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: "new@example.com", passwordHash: expect.any(String) }),
    }));
  });

  it("requires a current global administrator", async () => {
    authState.role = "OPERATOR";

    const response = await request(app()).get("/users");

    expect(response.status).toBe(403);
    expect(userMock.findMany).not.toHaveBeenCalled();
  });

  it("protects the last active global administrator", async () => {
    userMock.findUnique.mockResolvedValue({ ...safeUser, role: "ADMIN" });
    userMock.count.mockResolvedValue(1);

    const response = await request(app()).post(`/users/${targetId}/disable`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("LAST_ADMIN_REQUIRED");
    expect(userMock.update).not.toHaveBeenCalled();
  });
});
