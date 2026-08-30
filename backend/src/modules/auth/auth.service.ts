import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../middleware/auth.js";

export const ACCESS_TOKEN_ISSUER = "sih-2026-backend";
export const ACCESS_TOKEN_AUDIENCE = "sih-2026-api";
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export function hashRefreshToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newRefreshToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function createAccessToken(user: AuthUser) {
  return jwt.sign({ email: user.email, role: user.role }, env.JWT_SECRET, {
    algorithm: "HS256",
    audience: ACCESS_TOKEN_AUDIENCE,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    issuer: ACCESS_TOKEN_ISSUER,
    jwtid: crypto.randomUUID(),
    subject: user.id,
  });
}

export async function createSession(user: AuthUser) {
  const refreshToken = newRefreshToken();
  await prisma.refreshSession.create({
    data: {
      userId: user.id,
      familyId: crypto.randomUUID(),
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });
  return { accessToken: createAccessToken(user), refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

export async function rotateSession(refreshToken: string) {
  const tokenHash = hashRefreshToken(refreshToken);
  const session = await prisma.refreshSession.findUnique({ where: { tokenHash } });
  if (!session) throw new AppError(401, "Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");

  const now = new Date();
  if (session.revokedAt || session.expiresAt <= now) {
    await prisma.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: now } });
    throw new AppError(401, "Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");
  }

  const nextRefreshToken = newRefreshToken();
  const user = await prisma.$transaction(async (transaction) => {
    const currentUser = await transaction.user.findFirst({
      where: { id: session.userId, disabledAt: null },
      select: { id: true, email: true, role: true },
    });
    if (!currentUser) {
      await transaction.refreshSession.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: now } });
      throw new AppError(401, "Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");
    }
    const rotated = await transaction.refreshSession.updateMany({
      where: { id: session.id, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    if (rotated.count !== 1) throw new AppError(401, "Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");
    await transaction.refreshSession.create({
      data: {
        userId: currentUser.id,
        familyId: session.familyId,
        tokenHash: hashRefreshToken(nextRefreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });
    return currentUser;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  return {
    accessToken: createAccessToken(user),
    refreshToken: nextRefreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    user,
  };
}

export async function revokeSession(refreshToken: string) {
  await prisma.refreshSession.updateMany({
    where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(userId: string) {
  await prisma.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
