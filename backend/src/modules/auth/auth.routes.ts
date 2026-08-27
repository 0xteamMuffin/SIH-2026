import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authenticate, type AuthUser } from "../../middleware/auth.js";

export const authRouter = Router();

authRouter.post("/login", async (request, response, next) => {
  try {
    const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
    const identity: AuthUser = { id: user.id, email: user.email, role: user.role };
    const token = jwt.sign(identity, env.JWT_SECRET, { expiresIn: "8h" });
    await audit({ actorId: user.id, eventType: "LOGIN_SUCCEEDED" });
    response.json({ token, user: identity });
  } catch (error) { next(error); }
});

authRouter.get("/me", authenticate, (request, response) => response.json({ user: request.user }));
