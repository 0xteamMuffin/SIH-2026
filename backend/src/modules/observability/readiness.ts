import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { connect } from "amqplib";
import { env } from "../../config/env.js";
import { getQdrantVectorStore } from "../../infrastructure/vector-store/qdrant-vector-store.js";
import { prisma } from "../../lib/prisma.js";

export type DependencyName = "postgresql" | "minio" | "rabbitmq" | "qdrant" | "sandbox" | "docling";
export type DependencyStatus = "ready" | "unavailable" | "optional_unavailable";
export type ReadinessResult = { status: "ready" | "not_ready"; dependencies: Record<DependencyName, DependencyStatus> };
export type ReadinessCheck = (signal: AbortSignal) => Promise<boolean>;

const storageClient = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
});

async function fetchReady(url: string, signal: AbortSignal, headers?: HeadersInit) {
  const response = await fetch(url, { signal, headers });
  return response.ok;
}

export const defaultReadinessChecks: Record<DependencyName, ReadinessCheck> = {
  postgresql: async () => {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  },
  minio: async (signal) => {
    await storageClient.send(new HeadBucketCommand({ Bucket: env.MINIO_BUCKET }), { abortSignal: signal });
    return true;
  },
  rabbitmq: async () => {
    const connection = await connect(env.AMQP_URL, { timeout: env.READINESS_TIMEOUT_MS });
    await connection.close();
    return true;
  },
  qdrant: () => getQdrantVectorStore().isReady(),
  sandbox: (signal) => fetchReady(`${env.SANDBOX_RUNNER_URL}/ready`, signal),
  docling: (signal) => fetchReady(`${env.DOCLING_BASE_URL}/ready`, signal, { "x-api-key": env.DOCLING_API_KEY }),
};

async function boundedCheck(check: ReadinessCheck, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([
      check(controller.signal),
      new Promise<boolean>((resolve) => controller.signal.addEventListener("abort", () => resolve(false), { once: true })),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function checkReadiness(
  checks: Record<DependencyName, ReadinessCheck> = defaultReadinessChecks,
  options: { timeoutMs?: number; doclingRequired?: boolean } = {},
): Promise<ReadinessResult> {
  const timeoutMs = options.timeoutMs ?? env.READINESS_TIMEOUT_MS;
  const doclingRequired = options.doclingRequired ?? env.DOCLING_REQUIRED;
  const names = Object.keys(checks) as DependencyName[];
  const results = await Promise.all(names.map(async (name) => [name, await boundedCheck(checks[name], timeoutMs)] as const));
  const availability = Object.fromEntries(results) as Record<DependencyName, boolean>;
  const dependencies = Object.fromEntries(results.map(([name, ready]) => [
    name,
    ready ? "ready" : name === "docling" && !doclingRequired ? "optional_unavailable" : "unavailable",
  ])) as Record<DependencyName, DependencyStatus>;
  const requiredReady = names.every((name) => availability[name] || (name === "docling" && !doclingRequired));
  return { status: requiredReady ? "ready" : "not_ready", dependencies };
}
