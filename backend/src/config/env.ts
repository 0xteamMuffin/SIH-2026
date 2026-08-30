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
  APP_MODE: z.enum(["development", "sovereign"]).default("development"),
  MODEL_CONFIG_PATH: z.string().min(1).default("config/models.json"),
  ALLOW_REMOTE_INFERENCE: booleanString.default(false),
  MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  REMOTE_MODEL_API_KEY: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.APP_MODE === "sovereign" && value.ALLOW_REMOTE_INFERENCE) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Sovereign mode cannot allow remote inference" });
  }
});

export const env = schema.parse(process.env);
