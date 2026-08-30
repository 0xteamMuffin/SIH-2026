import bcrypt from "bcryptjs";
import { Prisma, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { authenticate, requireRole } from "../../middleware/auth.js";

export const usersRouter = Router();
usersRouter.use(authenticate, requireRole("ADMIN"));

const userSelect = {
  id: true,
  email: true,
  role: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

usersRouter.get("/", async (_request, response, next) => {
  try {
    const users = await prisma.user.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: userSelect });
    response.json({ users });
  } catch (error) { next(error); }
});

usersRouter.post("/", async (request, response, next) => {
  try {
    const input = z.object({
      email: z.string().trim().email(),
      password: z.string().min(12).max(200),
      role: z.nativeEnum(UserRole).default(UserRole.OPERATOR),
    }).strict().parse(request.body);
    const user = await prisma.user.create({
      data: { email: input.email.toLowerCase(), passwordHash: await bcrypt.hash(input.password, 12), role: input.role },
      select: userSelect,
    });
    await audit({ actorId: request.user!.id, eventType: "USER_CREATED", metadata: { userId: user.id, role: user.role } });
    response.status(201).json({ user });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return next(new AppError(409, "Email is already in use", "EMAIL_IN_USE"));
    next(error);
  }
});

usersRouter.post("/:userId/disable", async (request, response, next) => {
  try {
    const userId = z.string().uuid().parse(request.params.userId);
    if (userId === request.user!.id) throw new AppError(409, "Administrators cannot disable their own account", "CANNOT_DISABLE_SELF");
    const user = await prisma.$transaction(async (transaction) => {
      const target = await transaction.user.findUnique({ where: { id: userId }, select: userSelect });
      if (!target) throw new AppError(404, "User not found", "NOT_FOUND");
      if (target.disabledAt) return target;
      if (target.role === UserRole.ADMIN) {
        const activeAdmins = await transaction.user.count({ where: { role: UserRole.ADMIN, disabledAt: null } });
        if (activeAdmins <= 1) throw new AppError(409, "The last active administrator cannot be disabled", "LAST_ADMIN_REQUIRED");
      }
      const disabled = await transaction.user.update({ where: { id: userId }, data: { disabledAt: new Date() }, select: userSelect });
      await transaction.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      return disabled;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await audit({ actorId: request.user!.id, eventType: "USER_DISABLED", metadata: { userId } });
    response.json({ user });
  } catch (error) { next(error); }
});
