import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from "../modules/auth/auth.service.js";

export type Role = "ADMIN" | "OPERATOR" | "REVIEWER";
export type AuthUser = { id: string; email: string; role: Role };

declare global {
  namespace Express { interface Request { user?: AuthUser } }
}

export async function authenticate(request: Request, _response: Response, next: NextFunction) {
  const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return next(new AppError(401, "Authentication required", "UNAUTHENTICATED"));
  let payload: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
      audience: ACCESS_TOKEN_AUDIENCE,
      issuer: ACCESS_TOKEN_ISSUER,
    });
    if (typeof verified === "string" || typeof verified.sub !== "string" || typeof verified.jti !== "string") throw new Error("Invalid token claims");
    payload = verified;
  } catch {
    return next(new AppError(401, "Invalid or expired access token", "UNAUTHENTICATED"));
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, email: true, role: true, disabledAt: true } });
    if (!user || user.disabledAt) return next(new AppError(401, "Invalid or expired access token", "UNAUTHENTICATED"));
    request.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (error) { next(error); }
}

export function requireRole(...roles: Role[]) {
  return (request: Request, _response: Response, next: NextFunction) => {
    if (!request.user || !roles.includes(request.user.role)) return next(new AppError(403, "Insufficient role", "FORBIDDEN"));
    next();
  };
}
