import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import express from "express";

const exec = promisify(execFile);
const MANAGED_LABEL = "com.sih.sandbox.managed=true";
const RUNTIMES = Object.freeze({
  javascript: Object.freeze({ image: "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32", command: Object.freeze(["node", "-"]) }),
  python: Object.freeze({ image: "python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d", command: Object.freeze(["python", "-I", "-"]) }),
});

function integerEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function loadConfig() {
  const token = process.env.SANDBOX_API_TOKEN ?? "";
  if (Buffer.byteLength(token) < 32) throw new Error("SANDBOX_API_TOKEN must contain at least 32 bytes");
  return Object.freeze({
    token,
    port: integerEnv("SANDBOX_PORT", 4100, 1, 65_535),
    concurrency: integerEnv("SANDBOX_CONCURRENCY", 2, 1, 16),
    queueLimit: integerEnv("SANDBOX_QUEUE_LIMIT", 32, 1, 1_000),
    sourceLimitBytes: integerEnv("SANDBOX_SOURCE_LIMIT_BYTES", 256 * 1024, 1, 1024 * 1024),
    outputLimitBytes: integerEnv("SANDBOX_OUTPUT_LIMIT_BYTES", 256 * 1024, 1, 4 * 1024 * 1024),
    timeoutMs: integerEnv("SANDBOX_TIMEOUT_MS", 30_000, 100, 120_000),
    retentionMs: integerEnv("SANDBOX_JOB_RETENTION_MS", 15 * 60_000, 1_000, 24 * 60 * 60_000),
  });
}

export function buildDockerArgs(job, config) {
  const runtime = RUNTIMES[job.language];
  if (!runtime) throw new Error("Unsupported sandbox language");
  return [
    "run", "--rm", "--interactive", "--pull", "never",
    "--name", `sih-sandbox-${job.id}`,
    "--label", MANAGED_LABEL,
    "--label", `com.sih.sandbox.job=${job.id}`,
    "--network", "none",
    "--read-only",
    "--user", "65534:65534",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--memory", "256m",
    "--memory-swap", "256m",
    "--cpus", "0.5",
    "--ulimit", "nofile=64:64",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
    runtime.image,
    ...runtime.command,
  ];
}

async function forceRemoveContainer(name) {
  try {
    await exec("docker", ["rm", "--force", name], { timeout: 5_000, windowsHide: true });
  } catch {
    // The container may not have been created yet or may already be gone.
  }
}

export function executeDockerJob(job, signal, config, spawnProcess = spawn, removeContainer = forceRemoveContainer) {
  return new Promise((resolve, reject) => {
    const containerName = `sih-sandbox-${job.id}`;
    const child = spawnProcess("docker", buildDockerArgs(job, config), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;

    const terminate = () => {
      child.kill("SIGKILL");
      void removeContainer(containerName);
    };
    const append = (target, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = config.outputLimitBytes - outputBytes;
      if (remaining > 0) target.push(bytes.subarray(0, remaining));
      outputBytes += Math.min(bytes.length, Math.max(remaining, 0));
      if (bytes.length > remaining) {
        outputTruncated = true;
        terminate();
      }
    };
    const onAbort = () => terminate();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    let timer;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: timedOut ? 124 : (typeof code === "number" ? code : 1),
        timedOut,
        outputTruncated,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(job.source, "utf8");
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, config.timeoutMs);
    timer.unref?.();
  });
}

export async function cleanupStaleContainers() {
  const { stdout } = await exec("docker", ["ps", "--all", "--quiet", "--filter", `label=${MANAGED_LABEL}`], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length) await exec("docker", ["rm", "--force", ...ids], { timeout: 15_000, windowsHide: true });
}

export async function dockerReady() {
  await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 3_000, windowsHide: true });
  await exec("docker", ["image", "inspect", ...Object.values(RUNTIMES).map(({ image }) => image)], { timeout: 3_000, windowsHide: true });
  return true;
}

function publicJob(job) {
  const value = {
    id: job.id,
    status: job.status,
    language: job.language,
    createdAt: job.createdAt,
  };
  if (job.startedAt) value.startedAt = job.startedAt;
  if (job.completedAt) value.completedAt = job.completedAt;
  if (job.result) value.result = job.result;
  if (job.error) value.error = job.error;
  return value;
}

export class SandboxJobService {
  constructor(config, options = {}) {
    this.config = config;
    this.execute = options.execute ?? ((job, signal) => executeDockerJob(job, signal, config));
    this.checkReady = options.checkReady ?? dockerReady;
    this.jobs = new Map();
    this.idempotency = new Map();
    this.queue = [];
    this.active = 0;
    this.shuttingDown = false;
    this.cleanupTimer = setInterval(() => this.removeExpiredJobs(), Math.min(config.retentionMs, 60_000));
    this.cleanupTimer.unref?.();
  }

  submit({ source, language, idempotencyKey }) {
    this.removeExpiredJobs();
    const fingerprint = crypto.createHash("sha256").update(language).update("\0").update(source).digest("hex");
    const previous = this.idempotency.get(idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { conflict: true };
      const existing = this.jobs.get(previous.jobId);
      if (existing) return { job: publicJob(existing), existing: true };
      this.idempotency.delete(idempotencyKey);
    }
    if (this.shuttingDown || this.queue.length >= this.config.queueLimit) return { full: true };

    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(), source, language, status: "queued", createdAt: now,
      idempotencyKey, fingerprint, controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.idempotency.set(idempotencyKey, { jobId: job.id, fingerprint });
    this.queue.push(job.id);
    this.pump();
    return { job: publicJob(job), existing: false };
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? publicJob(job) : undefined;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "queued") {
      job.status = "cancelled";
      job.completedAt = new Date().toISOString();
      this.queue = this.queue.filter((queuedId) => queuedId !== id);
      this.pump();
    } else if (job.status === "running") {
      job.controller.abort(new Error("Job cancelled"));
    }
    return publicJob(job);
  }

  async ready() {
    if (this.shuttingDown) return false;
    try {
      return await this.checkReady();
    } catch {
      return false;
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    clearInterval(this.cleanupTimer);
    for (const job of this.jobs.values()) {
      if (job.status === "queued") {
        job.status = "cancelled";
        job.completedAt = new Date().toISOString();
      } else if (job.status === "running") job.controller.abort(new Error("Runner shutting down"));
    }
  }

  pump() {
    while (!this.shuttingDown && this.active < this.config.concurrency && this.queue.length) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      this.active += 1;
      job.status = "running";
      job.startedAt = new Date().toISOString();
      void this.run(job);
    }
  }

  async run(job) {
    try {
      const result = await this.execute(job, job.controller.signal);
      if (job.controller.signal.aborted) {
        job.status = "cancelled";
      } else {
        job.result = result;
        job.status = result.exitCode === 0 ? "succeeded" : "failed";
      }
    } catch {
      if (job.controller.signal.aborted) job.status = "cancelled";
      else {
        job.status = "failed";
        job.error = "Sandbox execution infrastructure failed";
      }
    } finally {
      job.completedAt = new Date().toISOString();
      job.source = "";
      this.active -= 1;
      this.pump();
    }
  }

  removeExpiredJobs(now = Date.now()) {
    for (const [id, job] of this.jobs) {
      if (!job.completedAt || now - Date.parse(job.completedAt) < this.config.retentionMs) continue;
      this.jobs.delete(id);
      const entry = this.idempotency.get(job.idempotencyKey);
      if (entry?.jobId === id) this.idempotency.delete(job.idempotencyKey);
    }
  }
}

function tokenMatches(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actualHash = crypto.createHash("sha256").update(header.slice(7)).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

export function createApp(config, service) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.sourceLimitBytes + 1024, strict: true }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", async (_req, res) => {
    const ready = await service.ready();
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready" });
  });
  app.use("/v1/jobs", (req, res, next) => {
    if (!tokenMatches(req.headers.authorization, config.token)) return res.status(401).json({ error: "Unauthorized" });
    res.set("Cache-Control", "no-store");
    next();
  });
  app.post("/v1/jobs", (req, res) => {
    const source = req.body?.source;
    const language = req.body?.language;
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      return res.status(400).json({ error: "A valid Idempotency-Key header is required" });
    }
    if (typeof source !== "string" || Buffer.byteLength(source) > config.sourceLimitBytes) {
      return res.status(400).json({ error: `source must be a string no larger than ${config.sourceLimitBytes} bytes` });
    }
    if (!Object.hasOwn(RUNTIMES, language)) return res.status(400).json({ error: "language must be javascript or python" });
    const result = service.submit({ source, language, idempotencyKey });
    if (result.conflict) return res.status(409).json({ error: "Idempotency-Key was already used for a different request" });
    if (result.full) return res.status(429).set("Retry-After", "1").json({ error: "Sandbox queue is full" });
    return res.status(result.existing ? 200 : 202)
      .location(`/v1/jobs/${result.job.id}`)
      .json(result.job);
  });
  app.get("/v1/jobs/:id", (req, res) => {
    const job = service.get(req.params.id);
    return job ? res.json(job) : res.status(404).json({ error: "Job not found" });
  });
  app.post("/v1/jobs/:id/cancel", (req, res) => {
    const job = service.cancel(req.params.id);
    return job ? res.status(["queued", "running"].includes(job.status) ? 202 : 200).json(job) : res.status(404).json({ error: "Job not found" });
  });
  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "Request body is too large" });
    if (error instanceof SyntaxError) return res.status(400).json({ error: "Invalid JSON body" });
    console.error("Sandbox API request failed", error);
    return res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

export async function startServer() {
  const config = loadConfig();
  await cleanupStaleContainers();
  const service = new SandboxJobService(config);
  const server = createApp(config, service).listen(config.port, "0.0.0.0");
  const stop = () => {
    server.close();
    void service.shutdown();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return { server, service };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error) => {
    console.error("Sandbox runner failed to start", error);
    process.exitCode = 1;
  });
}
