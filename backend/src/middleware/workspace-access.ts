import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";

export async function requireWorkspaceAccess(request: Request, _response: Response, next: NextFunction) {
  try {
    if (!request.user) throw new AppError(400, "Workspace context is required");
    const workspaceId = z.string().uuid().parse(request.params.workspaceId);
    if (request.user.role === "ADMIN") return next();
    const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: request.user.id } } });
    if (!membership) throw new AppError(403, "Workspace access denied", "FORBIDDEN");
    next();
  } catch (error) { next(error); }
}
