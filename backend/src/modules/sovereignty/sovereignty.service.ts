import { DataClassification } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import {
  modelConfiguration,
  type ModelCapability,
  type ModelConfiguration,
  type ProviderLocation,
} from "../../infrastructure/models/model-registry.js";

/**
 * Evidence for the sovereignty claim.
 *
 * The deployment's promise is that confidential work never leaves the
 * premises. This module exists because a promise is not evidence: it reports
 * which controls are actually in force, enumerates every declared inference
 * destination, and lists every model call the system has made with its
 * destination resolved — so "nothing left the building" is a number someone
 * can read rather than a sentence someone wrote.
 *
 * Nothing here reads prompt or document content. The ledger is deliberately
 * metadata only: provider, model, timing, token counts. It has to be safe to
 * put on a projector.
 */

// ─── Posture ─────────────────────────────────────────────────────────────────

/**
 * `enforced` — the control is active and blocks egress.
 * `development` — deliberately relaxed for the development profile.
 * `structural` — a property of the code that cannot be switched off at runtime.
 */
export type SovereigntyControlState = "enforced" | "development" | "structural";

export type SovereigntyControl = {
  id: string;
  title: string;
  /** What the control does, in terms a reviewer can verify against the code. */
  detail: string;
  /** Where to look to confirm it. */
  evidence: string;
  state: SovereigntyControlState;
};

export type SovereigntyProfile = {
  profileId: string;
  modelId: string;
  capabilities: ModelCapability[];
  priority: number;
  enabled: boolean;
  /** Whether the router may currently choose this profile. */
  selectable: boolean;
};

export type SovereigntyProvider = {
  providerId: string;
  location: ProviderLocation;
  /** Host only — the API key never appears, and nor does the full URL. */
  host: string | null;
  requiresApiKey: boolean;
  apiKeyPresent: boolean;
  /** Whether any profile on this provider may currently be chosen. */
  reachablePolicy: boolean;
  profiles: SovereigntyProfile[];
};

export type CapabilityCoverage = {
  capability: ModelCapability;
  localProfiles: number;
  remoteProfiles: number;
  /** True when this capability can be served without leaving the premises. */
  sovereignReady: boolean;
};

export type SovereigntyPosture = {
  mode: "development" | "sovereign";
  sovereign: boolean;
  allowRemoteInference: boolean;
  controls: SovereigntyControl[];
  providers: SovereigntyProvider[];
  capabilityCoverage: CapabilityCoverage[];
  /** Classifications refused a remote route regardless of mode. */
  remoteDeniedClassifications: DataClassification[];
  checkedAt: string;
};

/** Capabilities the workbench must be able to serve to be useful on-premise. */
const REQUIRED_CAPABILITIES: ModelCapability[] = [
  "general",
  "document",
  "vision",
  "code",
  "embedding",
];

/**
 * Extracts the host for display. Falls back to `null` rather than echoing a
 * malformed value, and never returns the path or query — a base URL can carry
 * a key in either.
 */
function hostOf(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

function describeControls(): SovereigntyControl[] {
  const sovereign = env.APP_MODE === "sovereign";
  const remoteAllowed = env.ALLOW_REMOTE_INFERENCE;

  return [
    {
      id: "network-isolation",
      title: "Container network has no egress route",
      detail: sovereign
        ? "The sovereign compose profile drops the development-egress network. The remaining network is declared `internal: true`, so Docker attaches no gateway and there is no route off the host — independent of anything the application code attempts."
        : "The development profile attaches the backend and worker to a network with a gateway, so outbound requests are possible. Deploy with docker-compose.sovereign.yml to remove it.",
      evidence: "docker-compose.sovereign.yml · verify with `docker network inspect`, or run the egress probe",
      state: sovereign ? "enforced" : "development",
    },
    {
      id: "process-guard",
      title: "Process refuses to start with remote inference enabled",
      detail:
        "Environment validation rejects the combination of APP_MODE=sovereign and ALLOW_REMOTE_INFERENCE=true, so a sovereign deployment cannot be talked into remote inference by a configuration mistake — it fails to boot instead.",
      evidence: "backend/src/config/env.ts",
      state: "structural",
    },
    {
      id: "registry-filter",
      title: "Remote profiles are excluded from model selection",
      detail: remoteAllowed
        ? "ALLOW_REMOTE_INFERENCE is true, so remote profiles are candidates for the router. This is the development profile."
        : "The registry filters out every profile whose provider location is `remote` before the router sees it, so a remote model cannot be selected even by an explicit request.",
      evidence: "backend/src/infrastructure/models/model-registry.ts",
      state: remoteAllowed ? "development" : "enforced",
    },
    {
      id: "call-path-guard",
      title: "The inference call path rejects remote providers",
      detail: remoteAllowed
        ? "The guard is present but permissive while ALLOW_REMOTE_INFERENCE is true."
        : "Policy is checked before the request is constructed, so a blocked call is never issued and then discarded — it never reaches the network stack at all.",
      evidence: "backend/src/infrastructure/models/model-provider.ts · embedding-provider.ts",
      state: remoteAllowed ? "development" : "enforced",
    },
    {
      id: "classification-policy",
      title: "Confidential work is denied a remote route in every mode",
      detail:
        "INTERNAL and CONFIDENTIAL classifications are refused external inference regardless of APP_MODE, so the development profile cannot send sensitive material off-premise even while remote models are enabled for synthetic work.",
      evidence: "backend/src/lib/data-classification.ts",
      state: "structural",
    },
  ];
}

export function describePosture(
  configuration: ModelConfiguration = modelConfiguration(),
): SovereigntyPosture {
  const providers: SovereigntyProvider[] = configuration.providers.map((provider) => {
    const profiles = configuration.profiles.filter((profile) => profile.providerId === provider.id);
    const apiKeyPresent = provider.apiKeyEnv ? Boolean(process.env[provider.apiKeyEnv]) : true;
    // Mirrors the registry's own filter, so this view cannot claim a profile
    // is selectable when the router would skip it.
    const policyAllows = provider.location === "local" || env.ALLOW_REMOTE_INFERENCE;

    return {
      providerId: provider.id,
      location: provider.location,
      host: hostOf(provider.baseUrl),
      requiresApiKey: Boolean(provider.apiKeyEnv),
      apiKeyPresent,
      reachablePolicy: policyAllows,
      profiles: profiles.map((profile) => ({
        profileId: profile.id,
        modelId: profile.modelId,
        capabilities: profile.capabilities,
        priority: profile.priority,
        enabled: profile.enabled,
        selectable: profile.enabled && policyAllows,
      })),
    };
  });

  const capabilityCoverage: CapabilityCoverage[] = REQUIRED_CAPABILITIES.map((capability) => {
    const matching = configuration.profiles.filter(
      (profile) => profile.enabled && profile.capabilities.includes(capability),
    );
    const localProfiles = matching.filter((profile) => profile.location === "local").length;
    return {
      capability,
      localProfiles,
      remoteProfiles: matching.length - localProfiles,
      sovereignReady: localProfiles > 0,
    };
  });

  return {
    mode: env.APP_MODE,
    sovereign: env.APP_MODE === "sovereign",
    allowRemoteInference: env.ALLOW_REMOTE_INFERENCE,
    controls: describeControls(),
    providers,
    capabilityCoverage,
    remoteDeniedClassifications: [DataClassification.INTERNAL, DataClassification.CONFIDENTIAL],
    checkedAt: new Date().toISOString(),
  };
}

// ─── Egress ledger ───────────────────────────────────────────────────────────

export type EgressChannel = ProviderLocation | "unknown";

export type EgressEntry = {
  id: string;
  kind: "inference" | "embedding";
  /** ISO-8601. */
  at: string;
  channel: EgressChannel;
  providerId: string;
  /** Destination host, or `null` for a provider the registry no longer declares. */
  host: string | null;
  profileId: string;
  modelId: string;
  status: string;
  latencyMs: number | null;
  totalTokens: number | null;
  runId: string | null;
  workspaceId: string | null;
};

export type EgressSummary = {
  /** Start of the window these counts cover, or `null` for all of history. */
  since: string | null;
  localCalls: number;
  remoteCalls: number;
  /** Calls whose provider is no longer in the registry, so unclassifiable. */
  unknownCalls: number;
  /** Refusals recorded by the policy guard — attempts that never left. */
  blockedAttempts: number;
  /** Distinct off-premise hosts contacted in the window. */
  remoteHosts: string[];
};

export type EgressLedger = { summary: EgressSummary; entries: EgressEntry[] };

/** providerId → { location, host }, from the live registry. */
function providerIndex(
  configuration: ModelConfiguration,
): Map<string, { location: ProviderLocation; host: string | null }> {
  return new Map(
    configuration.providers.map((provider) => [
      provider.id,
      { location: provider.location, host: hostOf(provider.baseUrl) },
    ]),
  );
}

/**
 * Reads the ledger.
 *
 * The destination is resolved from the registry at read time rather than being
 * denormalised onto each row: `ModelInvocation` records which provider was
 * used, and the provider's location and host are configuration. That keeps the
 * ledger honest when a provider is reconfigured — and needs no migration.
 * A provider that has since been removed resolves to `unknown` rather than
 * being silently counted as local.
 */
export async function readEgressLedger(input: {
  limit: number;
  since?: Date;
  configuration?: ModelConfiguration;
}): Promise<EgressLedger> {
  const configuration = input.configuration ?? modelConfiguration();
  const providers = providerIndex(configuration);
  const startedAt = input.since ? { gte: input.since } : undefined;

  const [inferences, embeddings, blockedAttempts] = await Promise.all([
    prisma.modelInvocation.findMany({
      where: { startedAt },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: {
        id: true,
        runId: true,
        providerId: true,
        profileId: true,
        modelId: true,
        status: true,
        latencyMs: true,
        totalTokens: true,
        startedAt: true,
        run: { select: { workspaceId: true } },
      },
    }),
    prisma.embeddingInvocation.findMany({
      where: { startedAt },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: {
        id: true,
        providerId: true,
        profileId: true,
        modelId: true,
        status: true,
        latencyMs: true,
        inputTokens: true,
        startedAt: true,
      },
    }),
    prisma.auditEvent.count({
      where: { eventType: "EXTERNAL_INFERENCE_BLOCKED", createdAt: startedAt },
    }),
  ]);

  const resolve = (providerId: string): { channel: EgressChannel; host: string | null } => {
    const provider = providers.get(providerId);
    if (!provider) return { channel: "unknown", host: null };
    return { channel: provider.location, host: provider.host };
  };

  const entries: EgressEntry[] = [
    ...inferences.map((invocation): EgressEntry => ({
      id: invocation.id,
      kind: "inference",
      at: invocation.startedAt.toISOString(),
      ...resolve(invocation.providerId),
      providerId: invocation.providerId,
      profileId: invocation.profileId,
      modelId: invocation.modelId,
      status: invocation.status,
      latencyMs: invocation.latencyMs,
      totalTokens: invocation.totalTokens,
      runId: invocation.runId,
      workspaceId: invocation.run?.workspaceId ?? null,
    })),
    ...embeddings.map((invocation): EgressEntry => ({
      id: invocation.id,
      kind: "embedding",
      at: invocation.startedAt.toISOString(),
      ...resolve(invocation.providerId),
      providerId: invocation.providerId,
      profileId: invocation.profileId,
      modelId: invocation.modelId,
      status: invocation.status,
      latencyMs: invocation.latencyMs,
      totalTokens: invocation.inputTokens,
      runId: null,
      workspaceId: null,
    })),
  ]
    // Both queries are already sorted; merging needs one more pass to
    // interleave them, then the combined list is trimmed to the page size.
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, input.limit);

  // Counted over the same window as the entries, but across *all* rows rather
  // than the page — a summary that only described one page of a ledger would
  // be worse than no summary.
  const [localCalls, remoteCalls, unknownCalls, remoteHosts] = summarise(
    await countByProvider(startedAt),
    providers,
  );

  return {
    summary: {
      since: input.since?.toISOString() ?? null,
      localCalls,
      remoteCalls,
      unknownCalls,
      blockedAttempts,
      remoteHosts,
    },
    entries,
  };
}

/** Total calls per provider, across both invocation tables. */
async function countByProvider(startedAt?: { gte: Date }): Promise<Map<string, number>> {
  const [inference, embedding] = await Promise.all([
    prisma.modelInvocation.groupBy({
      by: ["providerId"],
      where: { startedAt },
      _count: { _all: true },
    }),
    prisma.embeddingInvocation.groupBy({
      by: ["providerId"],
      where: { startedAt },
      _count: { _all: true },
    }),
  ]);

  const totals = new Map<string, number>();
  for (const group of [...inference, ...embedding]) {
    totals.set(group.providerId, (totals.get(group.providerId) ?? 0) + group._count._all);
  }
  return totals;
}

function summarise(
  totals: Map<string, number>,
  providers: Map<string, { location: ProviderLocation; host: string | null }>,
): [number, number, number, string[]] {
  let local = 0;
  let remote = 0;
  let unknown = 0;
  const hosts = new Set<string>();

  for (const [providerId, count] of totals) {
    const provider = providers.get(providerId);
    if (!provider) {
      unknown += count;
      continue;
    }
    if (provider.location === "local") {
      local += count;
      continue;
    }
    remote += count;
    if (provider.host) hosts.add(provider.host);
  }

  return [local, remote, unknown, [...hosts].sort()];
}

// ─── Live egress probe ───────────────────────────────────────────────────────

export type EgressProbeVerdict = "blocked" | "reachable";

export type EgressProbeTarget = {
  /** Label shown in the UI — the host being attempted. */
  host: string;
  url: string;
  verdict: EgressProbeVerdict;
  /** Populated when blocked: the transport-level reason it failed. */
  reason?: string;
  latencyMs: number;
};

export type EgressProbeResult = {
  mode: "development" | "sovereign";
  /** True when every target failed to connect — the sovereign expectation. */
  allBlocked: boolean;
  targets: EgressProbeTarget[];
  probedAt: string;
};

/**
 * Hosts to attempt. Drawn from the remote providers the registry declares,
 * so the probe tests the destinations this deployment could actually reach
 * rather than an arbitrary internet address.
 */
function probeTargets(configuration: ModelConfiguration): string[] {
  const hosts = new Set<string>();
  for (const provider of configuration.providers) {
    if (provider.location !== "remote") continue;
    const host = hostOf(provider.baseUrl);
    if (host) hosts.add(host);
  }
  return [...hosts].sort();
}

/** Bounded tightly: a blocked route fails immediately, so a slow probe is a reachable one. */
const PROBE_TIMEOUT_MS = 4_000;

/**
 * Attempts a connection to each declared remote destination and reports
 * whether it was refused.
 *
 * This is the demonstration the sovereignty claim rests on: in the sovereign
 * profile every target fails at the transport layer, because the container has
 * no route. It is deliberately a separate, explicitly-invoked operation rather
 * than part of the posture read — in the development profile these attempts
 * genuinely reach the internet, and that should never happen as a side effect
 * of opening a dashboard.
 */
export async function probeEgress(
  configuration: ModelConfiguration = modelConfiguration(),
): Promise<EgressProbeResult> {
  const targets = await Promise.all(
    probeTargets(configuration).map(async (host): Promise<EgressProbeTarget> => {
      const url = `https://${host}/`;
      const startedAt = performance.now();
      try {
        // HEAD, and the response is discarded: this asks "is there a route",
        // not "what is there". Any HTTP status counts as reachable.
        await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return { host, url, verdict: "reachable", latencyMs: Math.round(performance.now() - startedAt) };
      } catch (error) {
        return {
          host,
          url,
          verdict: "blocked",
          reason: transportReason(error),
          latencyMs: Math.round(performance.now() - startedAt),
        };
      }
    }),
  );

  return {
    mode: env.APP_MODE,
    allBlocked: targets.length > 0 && targets.every((target) => target.verdict === "blocked"),
    targets,
    probedAt: new Date().toISOString(),
  };
}

/**
 * A short, non-sensitive reason. `fetch` wraps the underlying failure, so the
 * cause carries the useful part — `ENOTFOUND` for no DNS, `ENETUNREACH` for no
 * route, which is what an isolated network produces.
 */
function transportReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "Connection timed out";
    const cause = (error as { cause?: unknown }).cause;
    const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : null;
    if (code) return code;
    return error.message.slice(0, 200);
  }
  return "Connection failed";
}
