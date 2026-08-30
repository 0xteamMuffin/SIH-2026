import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.platform === "win32" ? "docker.exe" : "docker";
const rendered = spawnSync(command, [
  "compose",
  "--env-file", ".env.example",
  "-f", "docker-compose.yml",
  "-f", "docker-compose.sovereign.yml",
  "config", "--format", "json",
], { cwd: root, encoding: "utf8" });

if (rendered.status !== 0) {
  process.stderr.write(rendered.stderr || rendered.stdout);
  process.exit(rendered.status ?? 1);
}

const config = JSON.parse(rendered.stdout);
const services = config.services ?? {};
const remoteCredentialKeys = [
  "REMOTE_MODEL_API_KEY",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_AI_BASE_URL",
];

for (const serviceName of ["backend", "worker"]) {
  const service = services[serviceName];
  assert(service, `Rendered Compose is missing ${serviceName}`);
  assert.deepEqual(Object.keys(service.networks ?? {}), ["internal"], `${serviceName} must attach only to the internal network`);
  assert.equal(config.networks?.internal?.internal, true, "The backend network must be Docker-internal");
  assert.equal(service.network_mode, undefined, `${serviceName} must not override network isolation`);
  assert.deepEqual(service.extra_hosts ?? [], [], `${serviceName} must not map host gateways`);
  assert.equal(service.environment?.APP_MODE, "sovereign", `${serviceName} must run in sovereign mode`);
  assert.equal(service.environment?.ALLOW_REMOTE_INFERENCE, "false", `${serviceName} must disable remote inference`);
  for (const key of remoteCredentialKeys) {
    assert.equal(Object.hasOwn(service.environment ?? {}, key), false, `${serviceName} must not receive ${key}`);
  }
}

for (const serviceName of ["postgres", "minio", "minio-init", "qdrant", "rabbitmq", "docling", "sandbox-runner", "worker"]) {
  const service = services[serviceName];
  assert(service, `Rendered Compose is missing ${serviceName}`);
  assert.equal((service.ports ?? []).length, 0, `${serviceName} must not publish host ports in sovereign mode`);
}

assert.equal(Object.hasOwn(config, "x-backend-env"), false, "Rendered Compose must not retain the development environment extension");
for (const key of remoteCredentialKeys) {
  assert.equal(JSON.stringify(config).includes(`\"${key}\"`), false, `Rendered Compose must not contain ${key}`);
}

console.log("Sovereign Compose verification passed: backend/worker egress blocked, remote credentials absent, internal services unexposed.");
