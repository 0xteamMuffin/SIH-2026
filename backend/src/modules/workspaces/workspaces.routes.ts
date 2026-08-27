import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authenticate } from "../../middleware/auth.js";

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
    const workspace = await prisma.workspace.create({ data: { name: input.name, createdBy: request.user!.id, members: { create: { userId: request.user!.id, role: request.user!.role } } } });
    await audit({ actorId: request.user!.id, workspaceId: workspace.id, eventType: "WORKSPACE_CREATED" });
    response.status(201).json({ workspace });
  } catch (error) { next(error); }
});
