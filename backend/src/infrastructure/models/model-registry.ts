import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { env } from "../../config/env.js";

export const modelCapabilities = ["general", "document", "vision", "code", "embedding", "reranking"] as const;
export type ModelCapability = typeof modelCapabilities[number];
export type TaskCapability = Extract<ModelCapability, "general" | "document" | "vision" | "code">;
export type ProviderLocation = "local" | "remote";

export type ModelProfile = {
  id: string;
  providerId: string;
  location: ProviderLocation;
  baseUrl: string;
  apiKeyEnv?: string;
  modelId: string;
  capabilities: ModelCapability[];
  priority: number;
  enabled: boolean;
  sovereign: boolean;
  maxOutputTokens: number;
};

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
  priority: z.number().int().min(0).default(100),
  enabled: z.boolean().default(true),
  maxOutputTokens: z.number().int().min(1).max(32_768).default(2_048),
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

export function parseModelConfiguration(input: string): ModelProfile[] {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("Model configuration must contain valid JSON");
  }
  const configuration = configurationSchema.parse(value);
  const providers = new Map(configuration.providers.map((provider) => [provider.id, provider]));
  return configuration.models.map((model) => {
    const provider = providers.get(model.providerId)!;
    const baseUrl = provider.baseUrl ?? (provider.baseUrlEnv ? process.env[provider.baseUrlEnv] : undefined) ?? "";
    return { ...model, location: provider.location, baseUrl: baseUrl.replace(/\/$/, ""), apiKeyEnv: provider.apiKeyEnv, sovereign: provider.location === "local" };
  });
}

export function modelProfiles(): ModelProfile[] {
  const path = resolve(env.MODEL_CONFIG_PATH);
  const profiles = parseModelConfiguration(readFileSync(path, "utf8"))
    .filter((profile) => profile.enabled && (profile.location === "local" || env.ALLOW_REMOTE_INFERENCE))
    .filter((profile) => Boolean(profile.baseUrl) && (!profile.apiKeyEnv || Boolean(process.env[profile.apiKeyEnv])))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  if (profiles.length === 0) throw new Error("No enabled model profiles are available under the current inference policy");
  return profiles;
}
