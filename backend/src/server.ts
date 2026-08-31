import bcrypt from "bcryptjs";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";

async function main() {
  const passwordHash = await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 12);
  await prisma.user.upsert({ where: { email: env.SEED_ADMIN_EMAIL.toLowerCase() }, update: { passwordHash, role: "ADMIN" }, create: { email: env.SEED_ADMIN_EMAIL.toLowerCase(), passwordHash, role: "ADMIN" } });
  const server = app.listen(env.API_PORT, () => logger.info({ port: env.API_PORT, mode: env.APP_MODE }, "SIH-2026 API listening"));
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "API shutting down");
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  };
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
}
main().catch((error) => { logger.fatal({ error }, "API failed to start"); process.exit(1); });
