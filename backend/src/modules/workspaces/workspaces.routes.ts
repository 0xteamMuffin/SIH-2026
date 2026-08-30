import { Router } from "express";
import { Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authenticate } from "../../middleware/auth.js";
import { requireWorkspaceAccess, requireWorkspaceRole } from "../../middleware/workspace-access.js";

export const workspacesRouter = Router();
workspacesRouter.use(authenticate);

workspacesRouter.get("/", async (request, response, next) => {
  try {
    const workspaces = await prisma.workspace.findMany({ where: request.user!.role === "ADMIN" ? {} : { members: { some: { userId: request.user!.id } } }, orderBy: { createdAt: "desc" } });
    response.json({ workspaces });
  } catch (error) { next(error); }
});

workspacesRouter.post("/", async (request, response, next) => {
  try {
    const input = z.object({ name: z.string().min(3).max(120) }).parse(request.body);
    const workspace = await prisma.workspace.create({ data: { name: input.name, createdBy: request.user!.id, members: { create: { userId: request.user!.id, role: UserRole.ADMIN } } } });
    await audit({ actorId: request.user!.id, workspaceId: workspace.id, eventType: "WORKSPACE_CREATED" });
    response.status(201).json({ workspace });
  } catch (error) { next(error); }
});

const memberSelect = {
  workspaceId: true,
  userId: true,
  role: true,
  user: { select: { id: true, email: true, role: true, disabledAt: true, createdAt: true } },
} satisfies Prisma.WorkspaceMemberSelect;

workspacesRouter.get("/:workspaceId/members", requireWorkspaceAccess, async (request, response, next) => {
  try {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: String(request.params.workspaceId) },
      orderBy: [{ role: "asc" }, { user: { email: "asc" } }],
      select: memberSelect,
    });
    response.json({ members });
  } catch (error) { next(error); }
});

workspacesRouter.post("/:workspaceId/members", requireWorkspaceRole("ADMIN"), async (request, response, next) => {
  try {
    const workspaceId = String(request.params.workspaceId);
    const input = z.object({ userId: z.string().uuid(), role: z.nativeEnum(UserRole).default(UserRole.OPERATOR) }).strict().parse(request.body);
    const user = await prisma.user.findFirst({ where: { id: input.userId, disabledAt: null }, select: { id: true } });
    if (!user) throw new AppError(404, "Active user not found", "NOT_FOUND");
    const member = await prisma.workspaceMember.create({ data: { workspaceId, userId: input.userId, role: input.role }, select: memberSelect });
    await audit({ actorId: request.user!.id, workspaceId, eventType: "WORKSPACE_MEMBER_ADDED", metadata: { userId: input.userId, role: input.role } });
    response.status(201).json({ member });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return next(new AppError(409, "User is already a workspace member", "MEMBERSHIP_EXISTS"));
    next(error);
  }
});

workspacesRouter.patch("/:workspaceId/members/:userId", requireWorkspaceRole("ADMIN"), async (request, response, next) => {
  try {
    const workspaceId = String(request.params.workspaceId);
    const userId = z.string().uuid().parse(request.params.userId);
    const { role } = z.object({ role: z.nativeEnum(UserRole) }).strict().parse(request.body);
    const member = await prisma.$transaction(async (transaction) => {
      const workspace = await transaction.workspace.findUnique({ where: { id: workspaceId }, select: { createdBy: true } });
      const current = await transaction.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (!workspace || !current) throw new AppError(404, "Workspace member not found", "NOT_FOUND");
      if (workspace.createdBy === userId && role !== UserRole.ADMIN) throw new AppError(409, "The workspace creator must remain an administrator", "CREATOR_ADMIN_REQUIRED");
      if (current.role === UserRole.ADMIN && role !== UserRole.ADMIN) {
        const adminCount = await transaction.workspaceMember.count({ where: { workspaceId, role: UserRole.ADMIN } });
        if (adminCount <= 1) throw new AppError(409, "The last workspace administrator cannot be demoted", "LAST_WORKSPACE_ADMIN_REQUIRED");
      }
      return transaction.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { role }, select: memberSelect });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await audit({ actorId: request.user!.id, workspaceId, eventType: "WORKSPACE_MEMBER_ROLE_UPDATED", metadata: { userId, role } });
    response.json({ member });
  } catch (error) { next(error); }
});

workspacesRouter.delete("/:workspaceId/members/:userId", requireWorkspaceRole("ADMIN"), async (request, response, next) => {
  try {
    const workspaceId = String(request.params.workspaceId);
    const userId = z.string().uuid().parse(request.params.userId);
    await prisma.$transaction(async (transaction) => {
      const workspace = await transaction.workspace.findUnique({ where: { id: workspaceId }, select: { createdBy: true } });
      const member = await transaction.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (!workspace || !member) throw new AppError(404, "Workspace member not found", "NOT_FOUND");
      if (workspace.createdBy === userId) throw new AppError(409, "The workspace creator cannot be removed", "CREATOR_MEMBERSHIP_REQUIRED");
      if (member.role === UserRole.ADMIN) {
        const adminCount = await transaction.workspaceMember.count({ where: { workspaceId, role: UserRole.ADMIN } });
        if (adminCount <= 1) throw new AppError(409, "The last workspace administrator cannot be removed", "LAST_WORKSPACE_ADMIN_REQUIRED");
      }
      await transaction.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await audit({ actorId: request.user!.id, workspaceId, eventType: "WORKSPACE_MEMBER_REMOVED", metadata: { userId } });
    response.status(204).send();
  } catch (error) { next(error); }
});
