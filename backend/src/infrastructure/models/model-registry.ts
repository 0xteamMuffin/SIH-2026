import { z } from "zod";
import { env } from "../../config/env.js";

export const modelCapabilities = ["general", "document", "vision", "code", "embedding", "reranking"] as const;
export type ModelCapability = typeof modelCapabilities[number];
export type TaskCapability = Extract<ModelCapability, "general" | "document" | "vision" | "code">;
export type ModelProvider = "openrouter" | "local";

export type ModelProfile = {
  id: string;
  provider: ModelProvider;
  modelId: string;
  capabilities: ModelCapability[];
  priority: number;
  enabled: boolean;
  endpoint?: string;
  sovereign: boolean;
  maxOutputTokens: number;
};

const profileSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  provider: z.enum(["openrouter", "local"]),
  modelId: z.string().min(1),
  capabilities: z.array(z.enum(modelCapabilities)).min(1),
  priority: z.number().int().min(0).default(100),
  enabled: z.boolean().default(true),
  endpoint: z.string().url().optional(),
  maxOutputTokens: z.number().int().min(1).max(32_768).default(2_048),
});

const registrySchema = z.array(profileSchema).min(1).superRefine((profiles, context) => {
  const ids = new Set<string>();
  for (const [index, profile] of profiles.entries()) {
    if (ids.has(profile.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate model profile '${profile.id}'`, path: [index, "id"] });
    ids.add(profile.id);
  }
});

export function parseModelRegistry(input: string): ModelProfile[] {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("MODEL_REGISTRY_JSON must contain valid JSON");
  }
  return registrySchema.parse(value).map((profile) => ({ ...profile, sovereign: profile.provider === "local" }));
}

function defaultProfiles(): ModelProfile[] {
  if (env.MODEL_PROVIDER === "openrouter") {
    return [{ id: "openrouter-development", provider: "openrouter", modelId: env.OPENROUTER_MODEL, capabilities: ["document", "vision", "code", "general"], priority: 100, enabled: true, sovereign: false, maxOutputTokens: 2_048 }];
  }
  return [
    { id: "local-general", provider: "local", endpoint: env.LOCAL_MODEL_BASE_URL, modelId: env.LOCAL_GENERAL_MODEL, capabilities: ["general", "document"], priority: 100, enabled: true, sovereign: true, maxOutputTokens: 2_048 },
    { id: "local-vision", provider: "local", endpoint: env.LOCAL_MODEL_BASE_URL, modelId: env.LOCAL_VISION_MODEL, capabilities: ["vision", "document"], priority: 50, enabled: true, sovereign: true, maxOutputTokens: 2_048 },
    { id: "local-code", provider: "local", endpoint: env.LOCAL_MODEL_BASE_URL, modelId: env.LOCAL_CODE_MODEL, capabilities: ["code"], priority: 50, enabled: true, sovereign: true, maxOutputTokens: 2_048 },
  ];
}

export function modelProfiles(): ModelProfile[] {
  const configured = env.MODEL_REGISTRY_JSON?.trim() ? parseModelRegistry(env.MODEL_REGISTRY_JSON) : defaultProfiles();
  const profiles = configured
    .filter((profile) => profile.enabled && profile.provider === env.MODEL_PROVIDER)
    .map((profile) => profile.provider === "local" ? { ...profile, endpoint: profile.endpoint ?? env.LOCAL_MODEL_BASE_URL } : profile)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  if (profiles.length === 0) throw new Error(`No enabled model profiles are configured for provider '${env.MODEL_PROVIDER}'`);
  if (profiles.some((profile) => profile.provider === "local" && !profile.endpoint)) throw new Error("Every local model profile requires an endpoint");
  return profiles;
}
