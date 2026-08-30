import { z } from "zod";
import { env } from "../../config/env.js";
import {
  modelConfiguration,
  type ModelCapability,
  type ModelConfiguration,
  type ModelProfile,
  type ProviderConfiguration,
} from "./model-registry.js";

const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough()),
}).passthrough();

export type ProviderProbeStatus = "available" | "degraded" | "unavailable" | "not_configured" | "disabled";

export type ModelProviderStatus = {
  providerId: string;
  location: "local" | "remote";
  status: ProviderProbeStatus;
  capabilities: ModelCapability[];
  availableCapabilities: ModelCapability[];
  profiles: Array<{
    profileId: string;
    modelId: string;
    capabilities: ModelCapability[];
    available: boolean | null;
  }>;
  latencyMs?: number;
  errorCode?: "PROBE_REQUEST_FAILED" | "PROBE_RESPONSE_INVALID";
};

export type ModelProviderStatusResult = { checkedAt: string; providers: ModelProviderStatus[] };

function capabilitiesFor(profiles: ModelProfile[]): ModelCapability[] {
  return [...new Set(profiles.flatMap((profile) => profile.capabilities))].sort();
}

function withoutRequest(provider: ProviderConfiguration, profiles: ModelProfile[], status: "not_configured" | "disabled"): ModelProviderStatus {
  return {
    providerId: provider.id,
    location: provider.location,
    status,
    capabilities: capabilitiesFor(profiles),
    availableCapabilities: [],
    profiles: profiles.map((profile) => ({ profileId: profile.id, modelId: profile.modelId, capabilities: profile.capabilities, available: null })),
  };
}

async function probeProvider(provider: ProviderConfiguration, profiles: ModelProfile[]): Promise<ModelProviderStatus> {
  if (profiles.length === 0 || (provider.location === "remote" && !env.ALLOW_REMOTE_INFERENCE)) return withoutRequest(provider, profiles, "disabled");
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
  if (!provider.baseUrl || (provider.apiKeyEnv && !apiKey)) return withoutRequest(provider, profiles, "not_configured");

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl}/models`, {
      method: "GET",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(env.MODEL_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      ...withoutRequest(provider, profiles, "disabled"),
      status: "unavailable",
      latencyMs: Math.round(performance.now() - startedAt),
      errorCode: "PROBE_REQUEST_FAILED",
    };
  }

  if (!response.ok) {
    return {
      ...withoutRequest(provider, profiles, "disabled"),
      status: "unavailable",
      latencyMs: Math.round(performance.now() - startedAt),
      errorCode: "PROBE_REQUEST_FAILED",
    };
  }

  const parsed = modelsResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    return {
      ...withoutRequest(provider, profiles, "disabled"),
      status: "unavailable",
      latencyMs: Math.round(performance.now() - startedAt),
      errorCode: "PROBE_RESPONSE_INVALID",
    };
  }

  const availableIds = new Set(parsed.data.data.map((model) => model.id));
  const profileStatuses = profiles.map((profile) => ({
    profileId: profile.id,
    modelId: profile.modelId,
    capabilities: profile.capabilities,
    available: availableIds.has(profile.modelId),
  }));
  const availableProfiles = profiles.filter((profile) => availableIds.has(profile.modelId));
  return {
    providerId: provider.id,
    location: provider.location,
    status: availableProfiles.length === profiles.length ? "available" : "degraded",
    capabilities: capabilitiesFor(profiles),
    availableCapabilities: capabilitiesFor(availableProfiles),
    profiles: profileStatuses,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

export async function probeModelProviders(configuration: ModelConfiguration = modelConfiguration()): Promise<ModelProviderStatusResult> {
  const statuses = await Promise.all(configuration.providers.map((provider) => probeProvider(
    provider,
    configuration.profiles.filter((profile) => profile.providerId === provider.id && profile.enabled),
  )));
  return { checkedAt: new Date().toISOString(), providers: statuses };
}
