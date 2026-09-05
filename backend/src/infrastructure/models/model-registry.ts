import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { EmbeddingProfile } from "../embeddings/embedding-provider.js";

export const modelCapabilities = ["general", "document", "vision", "code", "embedding", "reranking"] as const;
export type ModelCapability = typeof modelCapabilities[number];
export type TaskCapability = Extract<ModelCapability, "general" | "document" | "vision" | "code">;
export type ProviderLocation = "local" | "remote";
export type ProviderConfiguration = {
  id: string;
  location: ProviderLocation;
  baseUrl: string;
  apiKeyEnv?: string;
};
export type ModelPricing = {
  version: string;
  currency: "USD";
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
};
export const embeddingInputModalities = ["TEXT", "IMAGE"] as const;
export type EmbeddingInputModality = typeof embeddingInputModalities[number];
export const embeddingDistances = ["cosine", "euclid", "dot", "manhattan"] as const;
export type EmbeddingDistance = typeof embeddingDistances[number];

export type ModelProfile = {
  id: string;
  providerId: string;
  location: ProviderLocation;
  baseUrl: string;
  apiKeyEnv?: string;
  modelId: string;
  capabilities: ModelCapability[];
  /** Whether the profile can be given tools. Absent means unknown. */
  supportsTools?: boolean;
  priority: number;
  enabled: boolean;
  sovereign: boolean;
  maxOutputTokens: number;
  revision?: string;
  dimensions?: number;
  distance?: EmbeddingDistance;
  maxBatchInputs?: number;
  maxBatchCharacters?: number;
  maxInputCharacters?: number;
  inputModalities?: EmbeddingInputModality[];
  maxDocuments?: number;
  maxDocumentCharacters?: number;
  maxQueryCharacters?: number;
  pricing?: ModelPricing;
};

export type EmbeddingModelProfile = ModelProfile & EmbeddingProfile & {
  revision: string;
  distance: EmbeddingDistance;
  inputModalities: EmbeddingInputModality[];
};

export type RerankingModelProfile = ModelProfile & {
  revision: string;
  maxDocuments: number;
  maxDocumentCharacters: number;
  maxQueryCharacters: number;
  maxBatchCharacters: number;
};

export type ModelConfiguration = { providers: ProviderConfiguration[]; profiles: ModelProfile[] };

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeFiniteNumber = z.number().finite().nonnegative().max(10_000);

const providerSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  location: z.enum(["local", "remote"]),
  baseUrl: z.string().url().optional(),
  baseUrlEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
}).refine((provider) => Boolean(provider.baseUrl) !== Boolean(provider.baseUrlEnv), { message: "Exactly one of baseUrl or baseUrlEnv is required" });

const modelSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  capabilities: z.array(z.enum(modelCapabilities)).min(1),
  supportsTools: z.boolean().default(false),
  priority: z.number().int().min(0).default(100),
  enabled: z.boolean().default(true),
  maxOutputTokens: z.number().int().min(1).max(32_768).default(2_048),
  revision: z.string().min(1).optional(),
  dimensions: positiveSafeInteger.optional(),
  distance: z.enum(embeddingDistances).optional(),
  maxBatchInputs: positiveSafeInteger.optional(),
  maxBatchCharacters: positiveSafeInteger.optional(),
  maxInputCharacters: positiveSafeInteger.optional(),
  inputModalities: z.array(z.enum(embeddingInputModalities)).min(1)
    .refine((modalities) => new Set(modalities).size === modalities.length, "Input modalities must be unique")
    .optional(),
  maxDocuments: positiveSafeInteger.optional(),
  maxDocumentCharacters: positiveSafeInteger.optional(),
  maxQueryCharacters: positiveSafeInteger.optional(),
  pricing: z.object({
    version: z.string().min(1),
    currency: z.literal("USD"),
    inputPerMillionTokens: nonnegativeFiniteNumber,
    outputPerMillionTokens: nonnegativeFiniteNumber,
  }).strict().optional(),
}).superRefine((model, context) => {
  if (model.capabilities.includes("embedding")) {
    const requiredFields = ["revision", "dimensions", "distance", "maxBatchInputs", "maxBatchCharacters", "maxInputCharacters", "inputModalities"] as const;
    for (const field of requiredFields) {
      if (model[field] === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Embedding profile requires '${field}'`, path: [field] });
      }
    }
    if (model.maxInputCharacters !== undefined && model.maxBatchCharacters !== undefined && model.maxInputCharacters > model.maxBatchCharacters) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "maxInputCharacters cannot exceed maxBatchCharacters", path: ["maxInputCharacters"] });
    }
  }

  if (model.capabilities.includes("reranking")) {
    const requiredFields = ["revision", "maxDocuments", "maxDocumentCharacters", "maxQueryCharacters", "maxBatchCharacters"] as const;
    for (const field of requiredFields) {
      if (model[field] === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Reranking profile requires '${field}'`, path: [field] });
      }
    }
    if (model.maxDocumentCharacters !== undefined && model.maxBatchCharacters !== undefined && model.maxDocumentCharacters > model.maxBatchCharacters) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "maxDocumentCharacters cannot exceed maxBatchCharacters", path: ["maxDocumentCharacters"] });
    }
  }

  if (model.modelId.endsWith(":free") || model.modelId === "openrouter/free") {
    if (!model.pricing) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Free model profiles require versioned zero pricing", path: ["pricing"] });
    } else if (model.pricing.inputPerMillionTokens !== 0 || model.pricing.outputPerMillionTokens !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Free model profile pricing must be zero", path: ["pricing"] });
    }
  }
});

const configurationSchema = z.object({
  providers: z.array(providerSchema).min(1),
  models: z.array(modelSchema).min(1),
}).superRefine((configuration, context) => {
  const providerIds = new Set<string>();
  for (const [index, provider] of configuration.providers.entries()) {
    if (providerIds.has(provider.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate provider '${provider.id}'`, path: ["providers", index, "id"] });
    providerIds.add(provider.id);
  }
  const modelIds = new Set<string>();
  for (const [index, model] of configuration.models.entries()) {
    if (modelIds.has(model.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate model profile '${model.id}'`, path: ["models", index, "id"] });
    if (!providerIds.has(model.providerId)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown provider '${model.providerId}'`, path: ["models", index, "providerId"] });
    modelIds.add(model.id);
  }
});

export function parseModelRegistry(input: string): ModelConfiguration {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("Model configuration must contain valid JSON");
  }
  const configuration = configurationSchema.parse(value);
  const resolvedProviders = configuration.providers.map((provider) => ({
    id: provider.id,
    location: provider.location,
    baseUrl: (provider.baseUrl ?? (provider.baseUrlEnv ? process.env[provider.baseUrlEnv] : undefined) ?? "").replace(/\/$/, ""),
    apiKeyEnv: provider.apiKeyEnv,
  }));
  const resolvedById = new Map(resolvedProviders.map((provider) => [provider.id, provider]));
  const profiles = configuration.models.map((model) => {
    const provider = resolvedById.get(model.providerId)!;
    return { ...model, location: provider.location, baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv, sovereign: provider.location === "local" };
  });
  return { providers: resolvedProviders, profiles };
}

export function parseModelConfiguration(input: string): ModelProfile[] {
  return parseModelRegistry(input).profiles;
}

export function modelConfiguration(): ModelConfiguration {
  return parseModelRegistry(readFileSync(resolve(env.MODEL_CONFIG_PATH), "utf8"));
}

export function modelProfiles(): ModelProfile[] {
  const profiles = modelConfiguration().profiles
    .filter((profile) => profile.enabled && (profile.location === "local" || env.ALLOW_REMOTE_INFERENCE))
    .filter((profile) => Boolean(profile.baseUrl) && (!profile.apiKeyEnv || Boolean(process.env[profile.apiKeyEnv])))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  if (profiles.length === 0) throw new Error("No enabled model profiles are available under the current inference policy");
  return profiles;
}
