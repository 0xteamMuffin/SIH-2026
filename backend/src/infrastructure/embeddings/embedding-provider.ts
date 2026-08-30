import { DataClassification } from "@prisma/client";
import { z } from "zod";
import { env } from "../../config/env.js";
import { allowsExternalInference } from "../../lib/data-classification.js";
import { AppError } from "../../lib/errors.js";

export type EmbeddingProfile = {
  providerId: string;
  location: "local" | "remote";
  baseUrl: string;
  apiKeyEnv?: string;
  modelId: string;
  dimensions: number;
  maxBatchInputs: number;
  maxBatchCharacters: number;
  maxInputCharacters: number;
};

export type EmbeddingVector = number[];

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const embeddingProfileSchema = z.object({
  providerId: z.string().min(1),
  location: z.enum(["local", "remote"]),
  baseUrl: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  modelId: z.string().min(1),
  dimensions: positiveSafeInteger,
  maxBatchInputs: positiveSafeInteger,
  maxBatchCharacters: positiveSafeInteger,
  maxInputCharacters: positiveSafeInteger,
}).strict().refine((profile) => profile.maxInputCharacters <= profile.maxBatchCharacters);

const embeddingResponseSchema = z.object({
  data: z.array(z.object({
    embedding: z.array(z.number().finite()),
    index: z.number().int().nonnegative(),
  })),
});

function invalidResponse(): AppError {
  return new AppError(502, "Embedding provider returned an invalid response", "EMBEDDING_RESPONSE_INVALID");
}

function cancelledRequest(): AppError {
  return new AppError(503, "Embedding request was cancelled", "EMBEDDING_REQUEST_CANCELLED");
}

function validateInputs(inputs: readonly string[], profile: EmbeddingProfile): void {
  for (const [index, input] of inputs.entries()) {
    if (typeof input !== "string" || input.length === 0) {
      throw new AppError(422, `Embedding input at index ${index} must be a non-empty string`, "EMBEDDING_INPUT_INVALID");
    }
    if (input.length > profile.maxInputCharacters) {
      throw new AppError(413, `Embedding input at index ${index} exceeds the configured character limit`, "EMBEDDING_INPUT_TOO_LARGE");
    }
  }
}

function splitInputs(inputs: readonly string[], profile: EmbeddingProfile): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let characters = 0;

  for (const input of inputs) {
    if (batch.length === profile.maxBatchInputs || characters + input.length > profile.maxBatchCharacters) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(input);
    characters += input.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function requestBatch(profile: EmbeddingProfile, inputs: string[], apiKey: string | undefined, signal?: AbortSignal): Promise<EmbeddingVector[]> {
  if (signal?.aborted) throw cancelledRequest();

  const timeoutSignal = AbortSignal.timeout(env.MODEL_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(`${profile.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: profile.modelId, input: inputs, dimensions: profile.dimensions }),
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw cancelledRequest();
    if (requestSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
      throw new AppError(504, "Embedding provider request timed out", "EMBEDDING_TIMEOUT");
    }
    throw new AppError(502, "Embedding provider is unavailable", "EMBEDDING_PROVIDER_UNAVAILABLE");
  }

  if (!response.ok) {
    if (response.status === 429) throw new AppError(503, "Embedding provider rate limit exceeded", "EMBEDDING_RATE_LIMITED");
    throw new AppError(502, `Embedding provider request failed with status ${response.status}`, "EMBEDDING_PROVIDER_ERROR");
  }

  let data: z.infer<typeof embeddingResponseSchema>;
  try {
    data = embeddingResponseSchema.parse(await response.json());
  } catch (error) {
    if (signal?.aborted) throw cancelledRequest();
    if (requestSignal.aborted) throw new AppError(504, "Embedding provider request timed out", "EMBEDDING_TIMEOUT");
    throw invalidResponse();
  }

  if (data.data.length !== inputs.length) throw invalidResponse();
  for (const [index, item] of data.data.entries()) {
    if (item.index !== index || item.embedding.length !== profile.dimensions) throw invalidResponse();
  }
  return data.data.map((item) => item.embedding);
}

export async function embedTexts(
  profileInput: EmbeddingProfile,
  classification: DataClassification,
  inputs: readonly string[],
  signal?: AbortSignal,
): Promise<EmbeddingVector[]> {
  const parsedProfile = embeddingProfileSchema.safeParse(profileInput);
  if (!parsedProfile.success) throw new AppError(500, "Embedding profile is invalid", "EMBEDDING_PROFILE_INVALID");
  const profile = parsedProfile.data;
  validateInputs(inputs, profile);
  if (inputs.length === 0) return [];

  if (profile.location === "remote" && !allowsExternalInference(classification)) {
    throw new AppError(422, "External inference is restricted to public or synthetic data", "EXTERNAL_INFERENCE_BLOCKED");
  }
  if (profile.location === "remote" && !env.ALLOW_REMOTE_INFERENCE) {
    throw new AppError(503, "Remote inference is disabled", "REMOTE_INFERENCE_DISABLED");
  }

  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv && !apiKey) {
    throw new AppError(503, "Embedding provider credential is not configured", "EMBEDDING_PROVIDER_NOT_CONFIGURED");
  }

  const vectors: EmbeddingVector[] = [];
  for (const batch of splitInputs(inputs, profile)) {
    vectors.push(...await requestBatch(profile, batch, apiKey, signal));
  }
  return vectors;
}
