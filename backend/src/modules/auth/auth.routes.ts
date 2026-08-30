import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authenticate, type AuthUser } from "../../middleware/auth.js";
import { usersRouter } from "../users/users.routes.js";
import { createSession, revokeAllSessions, revokeSession, rotateSession } from "./auth.service.js";

export const authRouter = Router();

authRouter.post("/login", async (request, response, next) => {
  try {
    const input = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) }).strict().parse(request.body);
    const email = input.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    const passwordMatches = user ? await bcrypt.compare(input.password, user.passwordHash) : false;
    if (!user || !passwordMatches) {
      await audit({ actorId: user?.id, eventType: "LOGIN_FAILED", metadata: { email, reason: "INVALID_CREDENTIALS" } });
      throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
    }
    if (user.disabledAt) {
      await audit({ actorId: user.id, eventType: "LOGIN_FAILED", metadata: { email, reason: "USER_DISABLED" } });
      throw new AppError(403, "User account is disabled", "USER_DISABLED");
    }
    const identity: AuthUser = { id: user.id, email: user.email, role: user.role };
    const session = await createSession(identity);
    await audit({ actorId: user.id, eventType: "LOGIN_SUCCEEDED" });
    response.json({ ...session, token: session.accessToken, user: identity });
  } catch (error) { next(error); }
});

authRouter.get("/me", authenticate, (request, response) => response.json({ user: request.user }));

authRouter.post("/refresh", async (request, response, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string().min(32).max(512) }).strict().parse(request.body);
    response.json(await rotateSession(refreshToken));
  } catch (error) { next(error); }
});

authRouter.post("/logout", async (request, response, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string().min(32).max(512) }).strict().parse(request.body);
    await revokeSession(refreshToken);
    response.status(204).send();
  } catch (error) { next(error); }
});

authRouter.post("/revoke", authenticate, async (request, response, next) => {
  try {
    await revokeAllSessions(request.user!.id);
    response.status(204).send();
  } catch (error) { next(error); }
});

authRouter.use("/users", usersRouter);
