import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, refreshSessionMock, transactionMock, userMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  refreshSessionMock: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  transactionMock: vi.fn(),
  userMock: { findFirst: vi.fn(), findUnique: vi.fn() },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { refreshSession: refreshSessionMock, user: userMock, $transaction: transactionMock },
}));
vi.mock("../src/lib/audit.js", () => ({ audit: auditMock }));

import { env } from "../src/config/env.js";
import { errorHandler } from "../src/lib/errors.js";
import { authenticate } from "../src/middleware/auth.js";
import { authRouter } from "../src/modules/auth/auth.routes.js";
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  createAccessToken,
  createSession,
  hashRefreshToken,
  rotateSession,
} from "../src/modules/auth/auth.service.js";

const user = { id: "30000000-0000-4000-8000-000000000001", email: "operator@example.com", role: "OPERATOR" as const };

function authenticatedApp() {
  const app = express();
  app.get("/private", authenticate, (req, res) => res.json({ user: req.user }));
  app.use(errorHandler);
  return app;
}

function authApp() {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRouter);
  app.use(errorHandler);
  return app;
}

describe("local identity sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((work) => work({ refreshSession: refreshSessionMock, user: userMock }));
  });

  it("issues short-lived access JWTs with issuer, audience, subject, and jti", () => {
    const token = createAccessToken(user);
    const payload = jwt.verify(token, env.JWT_SECRET, { issuer: ACCESS_TOKEN_ISSUER, audience: ACCESS_TOKEN_AUDIENCE }) as jwt.JwtPayload;

    expect(payload.sub).toBe(user.id);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload.exp! - payload.iat!).toBe(900);
  });

  it("uses the current database role and rejects disabled users", async () => {
    const token = createAccessToken(user);
    userMock.findUnique.mockResolvedValueOnce({ ...user, role: "ADMIN", disabledAt: null }).mockResolvedValueOnce({ ...user, disabledAt: new Date() });

    const current = await request(authenticatedApp()).get("/private").set("Authorization", `Bearer ${token}`);
    const disabled = await request(authenticatedApp()).get("/private").set("Authorization", `Bearer ${token}`);

    expect(current.status).toBe(200);
    expect(current.body.user.role).toBe("ADMIN");
    expect(disabled.status).toBe(401);
  });

  it("stores only a refresh-token hash and rotates it atomically", async () => {
    refreshSessionMock.create.mockResolvedValue({});
    const issued = await createSession(user);
    const stored = refreshSessionMock.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(hashRefreshToken(issued.refreshToken));
    expect(JSON.stringify(stored)).not.toContain(issued.refreshToken);

    refreshSessionMock.findUnique.mockResolvedValue({ id: "session-1", userId: user.id, familyId: "40000000-0000-4000-8000-000000000001", expiresAt: new Date(Date.now() + 60_000), revokedAt: null });
    userMock.findFirst.mockResolvedValue(user);
    refreshSessionMock.updateMany.mockResolvedValue({ count: 1 });
    const rotated = await rotateSession(issued.refreshToken);

    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(refreshSessionMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "session-1", revokedAt: null }) }));
  });

  it("revokes a token family when a rotated token is replayed", async () => {
    refreshSessionMock.findUnique.mockResolvedValue({ id: "session-1", userId: user.id, familyId: "40000000-0000-4000-8000-000000000001", expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() });

    await expect(rotateSession("old-refresh-token-that-is-long-enough")).rejects.toMatchObject({ status: 401, code: "INVALID_REFRESH_TOKEN" });
    expect(refreshSessionMock.updateMany).toHaveBeenCalledWith({ where: { familyId: "40000000-0000-4000-8000-000000000001", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });

  it("audits failed login attempts without returning credentials", async () => {
    userMock.findUnique.mockResolvedValue(null);

    const response = await request(authApp()).post("/auth/login").send({ email: "missing@example.com", password: "wrong" });

    expect(response.status).toBe(401);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: "LOGIN_FAILED", metadata: expect.objectContaining({ reason: "INVALID_CREDENTIALS" }) }));
    expect(response.text).not.toContain("passwordHash");
    expect(response.text).not.toContain("tokenHash");
  });

  it("audits successful login and returns opaque session credentials", async () => {
    userMock.findUnique.mockResolvedValue({ ...user, passwordHash: await bcrypt.hash("correct-password", 4), disabledAt: null });
    refreshSessionMock.create.mockResolvedValue({});

    const response = await request(authApp()).post("/auth/login").send({ email: user.email, password: "correct-password" });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBe(response.body.token);
    expect(response.body.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(response.body.expiresIn).toBe(900);
    expect(auditMock).toHaveBeenCalledWith({ actorId: user.id, eventType: "LOGIN_SUCCEEDED" });
    expect(response.text).not.toContain("passwordHash");
    expect(response.text).not.toContain("tokenHash");
  });
});
