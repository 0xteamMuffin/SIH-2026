import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(root, "backend");
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
assert(databaseUrl, "MIGRATION_TEST_DATABASE_URL is required and must point to a disposable empty PostgreSQL database");
process.env.DATABASE_URL = databaseUrl;

const requireFromBackend = createRequire(path.join(backend, "package.json"));
const { PrismaClient } = requireFromBackend("@prisma/client");
const prisma = new PrismaClient();

try {
  const initialTables = await prisma.$queryRawUnsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  assert.deepEqual(initialTables, [], "Migration verification refuses to run unless the public schema is empty");
} finally {
  await prisma.$disconnect();
}

const prismaCli = requireFromBackend.resolve("prisma/build/index.js");
for (const args of [["migrate", "deploy"], ["migrate", "status"]]) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: backend,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const migrationDirectories = (await readdir(path.join(backend, "prisma", "migrations"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const verified = new PrismaClient();
try {
  const applied = await verified.$queryRawUnsafe(
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
  );
  assert.deepEqual(applied.map(({ migration_name }) => migration_name), migrationDirectories, "Applied migration ledger differs from migration files");
  const userTables = await verified.$queryRawUnsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'",
  );
  assert(userTables.length > 0, "Migrations created no application tables");
} finally {
  await verified.$disconnect();
}

console.log(`Empty PostgreSQL migration verification passed (${migrationDirectories.length} migrations).`);
