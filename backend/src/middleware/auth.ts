import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

export type Role = "ADMIN" | "OPERATOR" | "REVIEWER";
export type AuthUser = { id: string; email: string; role: Role };

declare global {
  namespace Express { interface Request { user?: AuthUser } }
}

export function authenticate(request: Request, _response: Response, next: NextFunction) {
  const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return next(new AppError(401, "Authentication required", "UNAUTHENTICATED"));
  try {
    request.user = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    next();
  } catch {
    next(new AppError(401, "Invalid or expired access token", "UNAUTHENTICATED"));
  }
}

export function requireRole(...roles: Role[]) {
  return (request: Request, _response: Response, next: NextFunction) => {
    if (!request.user || !roles.includes(request.user.role)) return next(new AppError(403, "Insufficient role", "FORBIDDEN"));
    next();
  };
}
