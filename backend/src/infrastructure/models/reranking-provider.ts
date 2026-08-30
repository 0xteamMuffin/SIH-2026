import { DataClassification } from "@prisma/client";
import { z } from "zod";
import { env } from "../../config/env.js";
import { allowsExternalInference } from "../../lib/data-classification.js";
import { AppError } from "../../lib/errors.js";
import { modelConfiguration, type ModelProfile, type RerankingModelProfile } from "./model-registry.js";

const rerankingResponseSchema = z.object({
  results: z.array(z.object({
    index: z.number().int().nonnegative(),
    relevance_score: z.number().finite(),
  })).min(1),
});

export type RerankingResult = { index: number; score: number };

function isRerankingProfile(profile: ModelProfile): profile is RerankingModelProfile {
  return profile.capabilities.includes("reranking")
    && profile.revision !== undefined
    && profile.maxDocuments !== undefined
    && profile.maxDocumentCharacters !== undefined
    && profile.maxQueryCharacters !== undefined
    && profile.maxBatchCharacters !== undefined;
}

export function selectRerankingProfile(
  classification: DataClassification,
  profiles: ModelProfile[] = modelConfiguration().profiles,
): RerankingModelProfile | undefined {
  return profiles
    .filter(isRerankingProfile)
    .filter((profile) => profile.enabled)
    .filter((profile) => Boolean(profile.baseUrl) && (!profile.apiKeyEnv || Boolean(process.env[profile.apiKeyEnv])))
    .filter((profile) => profile.location === "local" || env.ALLOW_REMOTE_INFERENCE)
    .filter((profile) => profile.location === "local" || allowsExternalInference(classification))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0];
}

export async function rerankDocuments(
  profile: RerankingModelProfile,
  classification: DataClassification,
  query: string,
  documents: readonly string[],
  signal?: AbortSignal,
): Promise<RerankingResult[]> {
  if (documents.length === 0) return [];
  if (profile.location === "remote" && !allowsExternalInference(classification)) {
    throw new AppError(422, "External inference is restricted to public or synthetic data", "EXTERNAL_INFERENCE_BLOCKED");
  }
  if (profile.location === "remote" && !env.ALLOW_REMOTE_INFERENCE) {
    throw new AppError(503, "Remote inference is disabled", "REMOTE_INFERENCE_DISABLED");
  }
  if (!query || query.length > profile.maxQueryCharacters || documents.length > profile.maxDocuments
    || documents.some((document) => !document || document.length > profile.maxDocumentCharacters)
    || documents.reduce((total, document) => total + document.length, 0) > profile.maxBatchCharacters) {
    throw new AppError(422, "Reranking input exceeds the configured profile limits", "RERANKING_INPUT_INVALID");
  }

  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv && !apiKey) throw new AppError(503, "Reranking provider credential is not configured", "RERANKING_PROVIDER_NOT_CONFIGURED");
  const timeoutSignal = AbortSignal.timeout(env.MODEL_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(`${profile.baseUrl}/rerank`, {
      method: "POST",
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), "content-type": "application/json" },
      body: JSON.stringify({ model: profile.modelId, query, documents, top_n: documents.length }),
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw new AppError(503, "Reranking request was cancelled", "RERANKING_REQUEST_CANCELLED");
    if (requestSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) throw new AppError(504, "Reranking provider request timed out", "RERANKING_TIMEOUT");
    throw new AppError(502, "Reranking provider is unavailable", "RERANKING_PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) {
    if (response.status === 429) throw new AppError(503, "Reranking provider rate limit exceeded", "RERANKING_RATE_LIMITED");
    throw new AppError(502, `Reranking provider request failed with status ${response.status}`, "RERANKING_PROVIDER_ERROR");
  }

  const parsed = rerankingResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success || parsed.data.results.length !== documents.length) {
    throw new AppError(502, "Reranking provider returned an invalid response", "RERANKING_RESPONSE_INVALID");
  }
  const indexes = new Set(parsed.data.results.map((result) => result.index));
  if (indexes.size !== documents.length || [...indexes].some((index) => index >= documents.length)) {
    throw new AppError(502, "Reranking provider returned an invalid response", "RERANKING_RESPONSE_INVALID");
  }
  return parsed.data.results.map((result) => ({ index: result.index, score: result.relevance_score }));
}

export type OptionalReranker = <T>(input: {
  classification: DataClassification;
  query: string;
  items: readonly T[];
  text: (item: T) => string;
  signal?: AbortSignal;
}) => Promise<T[]>;

export const rerankIfConfigured: OptionalReranker = async <T>(input: {
  classification: DataClassification;
  query: string;
  items: readonly T[];
  text: (item: T) => string;
  signal?: AbortSignal;
}): Promise<T[]> => {
  if (input.items.length < 2) return [...input.items];
  const profile = selectRerankingProfile(input.classification);
  if (!profile) return [...input.items];
  const ranking = await rerankDocuments(profile, input.classification, input.query, input.items.map(input.text), input.signal);
  return ranking.map((result) => input.items[result.index]);
};
