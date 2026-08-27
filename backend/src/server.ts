import bcrypt from "bcryptjs";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";

async function main() {
  const passwordHash = await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 12);
  await prisma.user.upsert({ where: { email: env.SEED_ADMIN_EMAIL.toLowerCase() }, update: {}, create: { email: env.SEED_ADMIN_EMAIL.toLowerCase(), passwordHash, role: "ADMIN" } });
  const server = app.listen(env.API_PORT, () => logger.info({ port: env.API_PORT, mode: env.APP_MODE }, "SIH-2026 API listening"));
  const shutdown = async () => { server.close(); await prisma.$disconnect(); process.exit(0); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
main().catch((error) => { logger.fatal({ error }, "API failed to start"); process.exit(1); });
