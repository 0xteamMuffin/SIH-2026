import { z } from "zod";

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
  MODEL_PROVIDER: z.enum(["openrouter", "local"]),
  MODEL_REGISTRY_JSON: z.string().optional(),
  MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("meta-llama/llama-3.3-70b-instruct"),
  LOCAL_MODEL_BASE_URL: z.string().url().optional(),
  LOCAL_MODEL_API_KEY: z.string().default("local-no-key"),
  LOCAL_GENERAL_MODEL: z.string().default("llama3.2"),
  LOCAL_VISION_MODEL: z.string().default("llama3.2-vision"),
  LOCAL_CODE_MODEL: z.string().default("qwen2.5-coder:7b")
}).superRefine((value, ctx) => {
  if (value.APP_MODE === "sovereign" && value.MODEL_PROVIDER !== "local") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Sovereign mode requires MODEL_PROVIDER=local" });
  }
  if (value.MODEL_PROVIDER === "local" && !value.LOCAL_MODEL_BASE_URL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "LOCAL_MODEL_BASE_URL is required for local provider mode" });
  }
});

export const env = schema.parse(process.env);
