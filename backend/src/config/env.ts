import { z } from "zod";

const booleanString = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  SEED_ADMIN_EMAIL: z.string().email(),
  SEED_ADMIN_PASSWORD: z.string().min(12),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(3),
  QDRANT_URL: z.string().url(),
  SANDBOX_RUNNER_URL: z.string().url(),
  AMQP_URL: z.string().url(),
  AGENT_QUEUE_PREFIX: z.string().regex(/^[a-z0-9._-]+$/i).default("workbench.agent"),
  QUEUE_PREFETCH: z.coerce.number().int().min(1).max(32).default(1),
  QUEUE_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  QUEUE_RETRY_DELAY_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15_000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(25),
  OUTBOX_MAX_BACKOFF_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  RUN_LEASE_DURATION_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  RUN_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
  RUN_RECOVERY_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
  APP_MODE: z.enum(["development", "sovereign"]).default("development"),
  MODEL_CONFIG_PATH: z.string().min(1).default("config/models.json"),
  ALLOW_REMOTE_INFERENCE: booleanString.default(false),
  MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  REMOTE_MODEL_API_KEY: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.APP_MODE === "sovereign" && value.ALLOW_REMOTE_INFERENCE) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Sovereign mode cannot allow remote inference" });
  }
  if (value.RUN_HEARTBEAT_INTERVAL_MS >= value.RUN_LEASE_DURATION_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RUN_HEARTBEAT_INTERVAL_MS must be shorter than RUN_LEASE_DURATION_MS" });
  }
});

export const env = schema.parse(process.env);
