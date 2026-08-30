import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const source = await readFile(envPath, "utf8");
const values = new Map();
for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match) values.set(match[1], match[2]);
}

const randomSecret = () => crypto.randomBytes(36).toString("base64url");
const next = {
  POSTGRES_PASSWORD: randomSecret(),
  JWT_SECRET: randomSecret(),
  SEED_ADMIN_PASSWORD: randomSecret(),
  MINIO_ROOT_PASSWORD: randomSecret(),
  QDRANT_API_KEY: randomSecret(),
  SANDBOX_API_TOKEN: randomSecret(),
  PDF_RENDERER_API_TOKEN: randomSecret(),
  DOCLING_API_KEY: randomSecret(),
  RABBITMQ_DEFAULT_PASS: randomSecret(),
};

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} failed`);
  return result.stdout.trim();
}

const compose = ["compose", "--env-file", ".env"];
const backendId = run("docker", [...compose, "ps", "-q", "backend"]);
const postgresId = run("docker", [...compose, "ps", "-q", "postgres"]);
const rabbitId = run("docker", [...compose, "ps", "-q", "rabbitmq"]);
if (!backendId || !postgresId || !rabbitId) throw new Error("Backend, PostgreSQL, and RabbitMQ must be running before rotating persisted credentials");

run("docker", [
  "exec", "-e", `NEXT_ADMIN_PASSWORD=${next.SEED_ADMIN_PASSWORD}`, "-e", `ADMIN_EMAIL=${values.get("SEED_ADMIN_EMAIL")}`,
  backendId, "node", "-e",
  "const bcrypt=require('bcryptjs');const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();bcrypt.hash(process.env.NEXT_ADMIN_PASSWORD,12).then(passwordHash=>p.user.update({where:{email:process.env.ADMIN_EMAIL.toLowerCase()},data:{passwordHash}})).finally(()=>p.$disconnect())",
]);

const databaseUser = values.get("POSTGRES_USER") ?? "sih";
const databaseName = values.get("POSTGRES_DB") ?? "sih_workbench";
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseUser)) throw new Error("POSTGRES_USER cannot be safely rotated");
run("docker", ["exec", postgresId, "psql", "-U", databaseUser, "-d", databaseName, "-v", "ON_ERROR_STOP=1", "-c", `ALTER ROLE "${databaseUser}" PASSWORD '${next.POSTGRES_PASSWORD}';`]);

const rabbitUser = values.get("RABBITMQ_DEFAULT_USER") ?? "sih";
run("docker", ["exec", rabbitId, "rabbitmqctl", "change_password", rabbitUser, next.RABBITMQ_DEFAULT_PASS]);

next.DATABASE_URL = `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(next.POSTGRES_PASSWORD)}@postgres:5432/${encodeURIComponent(databaseName)}`;
next.S3_SECRET_KEY = next.MINIO_ROOT_PASSWORD;
next.AMQP_URL = `amqp://${encodeURIComponent(rabbitUser)}:${encodeURIComponent(next.RABBITMQ_DEFAULT_PASS)}@rabbitmq:5672`;

const replaced = new Set();
const lines = source.split(/\r?\n/).map((line) => {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (!match || !Object.hasOwn(next, match[1])) return line;
  replaced.add(match[1]);
  return `${match[1]}=${next[match[1]]}`;
});
for (const [key, value] of Object.entries(next)) {
  if (!replaced.has(key)) lines.push(`${key}=${value}`);
}
const updated = lines.join("\n");
const temporaryPath = `${envPath}.tmp`;
await writeFile(temporaryPath, updated, { encoding: "utf8", mode: 0o600 });
await rename(temporaryPath, envPath);
console.log(`Rotated ${Object.keys(next).length} local credentials without printing their values.`);
