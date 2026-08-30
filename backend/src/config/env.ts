import { z } from "zod";

const booleanString = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const corsAllowedOrigins = z.string().default("http://localhost:3000").transform((value, ctx) => {
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error();
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid CORS origin: ${origin}` });
    }
  }
  return origins;
});

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CORS_ALLOWED_ORIGINS: corsAllowedOrigins,
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(1_000),
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(900_000),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000).default(10),
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),
  DOCLING_REQUIRED: booleanString.default(false),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  SEED_ADMIN_EMAIL: z.string().email(),
  SEED_ADMIN_PASSWORD: z.string().min(12),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(3),
  QDRANT_URL: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "QDRANT_URL must use HTTP or HTTPS").transform((value) => value.replace(/\/+$/, "")),
  QDRANT_API_KEY: z.string().min(16),
  SANDBOX_RUNNER_URL: z.string().url(),
  SANDBOX_API_TOKEN: z.string().min(32),
  PDF_RENDERER_URL: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "PDF_RENDERER_URL must use HTTP or HTTPS").transform((value) => value.replace(/\/+$/, "")),
  PDF_RENDERER_API_TOKEN: z.string().min(32),
  PDF_RENDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  PDF_RENDER_MAX_SOURCE_BYTES: z.coerce.number().int().min(1).max(25 * 1024 * 1024).default(25 * 1024 * 1024),
  PDF_RENDER_MAX_PAGES: z.coerce.number().int().min(1).max(8).default(3),
  PDF_RENDER_DPI: z.coerce.number().int().min(72).max(200).default(144),
  PDF_RENDER_MAX_PIXELS_PER_PAGE: z.coerce.number().int().min(100_000).max(16_000_000).default(4_000_000),
  PDF_RENDER_MAX_TOTAL_BYTES: z.coerce.number().int().min(1).max(25 * 1024 * 1024).default(10 * 1024 * 1024),
  DOCLING_BASE_URL: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "DOCLING_BASE_URL must use HTTP or HTTPS").transform((value) => value.replace(/\/+$/, "")),
  DOCLING_API_KEY: z.string().min(16),
  DOCLING_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(310_000),
  EXTRACTION_STALE_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(360_000),
  AMQP_URL: z.string().url(),
  AGENT_QUEUE_PREFIX: z.string().regex(/^[a-z0-9._-]+$/i).default("workbench.agent"),
  QUEUE_PREFETCH: z.coerce.number().int().min(1).max(32).default(1),
  QUEUE_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  QUEUE_RETRY_DELAY_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15_000),
  KNOWLEDGE_QUEUE_PREFETCH: z.coerce.number().int().min(1).max(32).default(1),
  KNOWLEDGE_QUEUE_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  KNOWLEDGE_QUEUE_RETRY_DELAY_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15_000),
  KNOWLEDGE_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(5_000).max(86_400_000).default(300_000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(25),
  OUTBOX_MAX_BACKOFF_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  RUN_LEASE_DURATION_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  RUN_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
  RUN_RECOVERY_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
  AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(32).default(4),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(64).default(5),
  AGENT_MAX_INPUT_TOKENS: z.coerce.number().int().min(1).max(10_000_000).default(32_768),
  AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(10_000_000).default(8_192),
  AGENT_MAX_TOTAL_TOKENS: z.coerce.number().int().min(1).max(10_000_000).default(40_960),
  AGENT_MAX_CONCURRENT_RUNS_PER_USER: z.coerce.number().int().min(1).max(100).default(2),
  AGENT_RUN_DEADLINE_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(900_000),
  APP_MODE: z.enum(["development", "sovereign"]).default("development"),
  MODEL_CONFIG_PATH: z.string().min(1).default("config/models.json"),
  ALLOW_REMOTE_INFERENCE: booleanString.default(false),
  MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  VISION_MAX_IMAGE_BYTES: z.coerce.number().int().min(1).max(25 * 1024 * 1024).default(10 * 1024 * 1024),
  REMOTE_MODEL_API_KEY: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.APP_MODE === "sovereign" && value.ALLOW_REMOTE_INFERENCE) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Sovereign mode cannot allow remote inference" });
  }
  if (value.RUN_HEARTBEAT_INTERVAL_MS >= value.RUN_LEASE_DURATION_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RUN_HEARTBEAT_INTERVAL_MS must be shorter than RUN_LEASE_DURATION_MS" });
  }
  if (value.EXTRACTION_STALE_TIMEOUT_MS <= value.DOCLING_REQUEST_TIMEOUT_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "EXTRACTION_STALE_TIMEOUT_MS must be longer than DOCLING_REQUEST_TIMEOUT_MS" });
  }
  if (value.PDF_RENDER_MAX_TOTAL_BYTES > value.VISION_MAX_IMAGE_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PDF_RENDER_MAX_TOTAL_BYTES cannot exceed VISION_MAX_IMAGE_BYTES" });
  }
});

export const env = schema.parse(process.env);
