import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import type { Role } from "./auth.js";

declare global {
  namespace Express { interface Request { workspaceRole?: Role } }
}

function workspaceAccess(roles?: Role[]) {
  return async (request: Request, _response: Response, next: NextFunction) => {
    try {
      if (!request.user) throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
      const workspaceId = z.string().uuid().parse(request.params.workspaceId);
      if (request.user.role === "ADMIN") {
        request.workspaceRole = "ADMIN";
        return next();
      }
      const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: request.user.id } } });
      if (!membership || (roles && !roles.includes(membership.role))) throw new AppError(403, "Workspace access denied", "FORBIDDEN");
      request.workspaceRole = membership.role;
      next();
    } catch (error) { next(error); }
  };
}

export const requireWorkspaceAccess = workspaceAccess();

export function requireWorkspaceRole(...roles: Role[]) {
  return workspaceAccess(roles);
}
