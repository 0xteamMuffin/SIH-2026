import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfiguration, ModelProfile } from "../src/infrastructure/models/model-registry.js";

/**
 * The sovereignty module is the evidence behind the deployment's central
 * claim, so these tests are about honesty rather than plumbing: that a
 * relaxed control is never reported as enforced, that a credential in a base
 * URL cannot leak through the provider list, and that a call to a provider the
 * registry no longer declares is counted as unclassified rather than quietly
 * counted as local.
 */

const env = { APP_MODE: "sovereign", ALLOW_REMOTE_INFERENCE: false };
const modelInvocation = { findMany: vi.fn(), groupBy: vi.fn() };
const embeddingInvocation = { findMany: vi.fn(), groupBy: vi.fn() };
const auditEvent = { count: vi.fn() };

vi.mock("../src/config/env.js", () => ({ env }));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { modelInvocation, embeddingInvocation, auditEvent },
}));

const { describePosture, probeEgress, readEgressLedger } = await import(
  "../src/modules/sovereignty/sovereignty.service.js"
);

const baseProfile: Omit<ModelProfile, "id" | "providerId" | "location" | "baseUrl" | "capabilities"> = {
  modelId: "test/model",
  priority: 100,
  enabled: true,
  sovereign: true,
  maxOutputTokens: 2_048,
};

function configuration(): ModelConfiguration {
  return {
    providers: [
      { id: "local-runtime", location: "local", baseUrl: "http://host.docker.internal:11434/v1" },
      {
        id: "development-remote",
        location: "remote",
        // Path and query are deliberately present: the provider list must
        // return the host alone.
        baseUrl: "https://openrouter.ai/api/v1?key=should-not-appear",
        apiKeyEnv: "REMOTE_MODEL_API_KEY",
      },
    ],
    profiles: [
      { ...baseProfile, id: "local-general", providerId: "local-runtime", location: "local", baseUrl: "http://host.docker.internal:11434/v1", capabilities: ["general", "document"] },
      { ...baseProfile, id: "local-vision", providerId: "local-runtime", location: "local", baseUrl: "http://host.docker.internal:11434/v1", capabilities: ["vision"] },
      { ...baseProfile, id: "local-embedding", providerId: "local-runtime", location: "local", baseUrl: "http://host.docker.internal:11434/v1", capabilities: ["embedding"] },
      { ...baseProfile, id: "remote-code", providerId: "development-remote", location: "remote", baseUrl: "https://openrouter.ai/api/v1", capabilities: ["code"], sovereign: false },
    ],
  };
}

beforeEach(() => {
  env.APP_MODE = "sovereign";
  env.ALLOW_REMOTE_INFERENCE = false;
  modelInvocation.findMany.mockResolvedValue([]);
  modelInvocation.groupBy.mockResolvedValue([]);
  embeddingInvocation.findMany.mockResolvedValue([]);
  embeddingInvocation.groupBy.mockResolvedValue([]);
  auditEvent.count.mockResolvedValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("sovereignty posture", () => {
  function controlState(posture: ReturnType<typeof describePosture>, id: string) {
    return posture.controls.find((control) => control.id === id)?.state;
  }

  it("reports egress controls as enforced in the sovereign profile", () => {
    const posture = describePosture(configuration());

    expect(posture.sovereign).toBe(true);
    expect(controlState(posture, "network-isolation")).toBe("enforced");
    expect(controlState(posture, "registry-filter")).toBe("enforced");
    expect(controlState(posture, "call-path-guard")).toBe("enforced");
    // These two cannot be switched off at runtime at all.
    expect(controlState(posture, "process-guard")).toBe("structural");
    expect(controlState(posture, "classification-policy")).toBe("structural");
  });

  it("does not claim enforcement for the relaxed development profile", () => {
    env.APP_MODE = "development";
    env.ALLOW_REMOTE_INFERENCE = true;

    const posture = describePosture(configuration());

    expect(posture.sovereign).toBe(false);
    expect(controlState(posture, "network-isolation")).toBe("development");
    expect(controlState(posture, "registry-filter")).toBe("development");
    expect(controlState(posture, "call-path-guard")).toBe("development");
    // The classification guard holds even when remote inference is enabled.
    expect(controlState(posture, "classification-policy")).toBe("structural");
    expect(posture.remoteDeniedClassifications).toEqual(["INTERNAL", "CONFIDENTIAL"]);
  });

  it("marks remote profiles unselectable while remote inference is disabled", () => {
    const posture = describePosture(configuration());
    const remote = posture.providers.find((provider) => provider.providerId === "development-remote");
    const local = posture.providers.find((provider) => provider.providerId === "local-runtime");

    expect(remote?.reachablePolicy).toBe(false);
    expect(remote?.profiles.every((profile) => !profile.selectable)).toBe(true);
    expect(local?.reachablePolicy).toBe(true);
    expect(local?.profiles.every((profile) => profile.selectable)).toBe(true);
  });

  it("returns the provider host only, never a credential-bearing URL", () => {
    const posture = describePosture(configuration());
    const remote = posture.providers.find((provider) => provider.providerId === "development-remote");

    expect(remote?.host).toBe("openrouter.ai");
    expect(JSON.stringify(posture)).not.toContain("should-not-appear");
    expect(JSON.stringify(posture)).not.toContain("/api/v1");
  });

  it("reports a capability as sovereign-ready only when a local profile serves it", () => {
    const coverage = new Map(
      describePosture(configuration()).capabilityCoverage.map((entry) => [entry.capability, entry]),
    );

    expect(coverage.get("general")?.sovereignReady).toBe(true);
    expect(coverage.get("vision")?.sovereignReady).toBe(true);
    expect(coverage.get("embedding")?.sovereignReady).toBe(true);
    // Only the remote provider offers code, so on-premise coverage is absent.
    expect(coverage.get("code")).toMatchObject({
      localProfiles: 0,
      remoteProfiles: 1,
      sovereignReady: false,
    });
  });
});

describe("egress ledger", () => {
  it("resolves each call to its destination and totals them by channel", async () => {
    modelInvocation.findMany.mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        runId: "22222222-2222-4222-8222-222222222222",
        providerId: "local-runtime",
        profileId: "local-general",
        modelId: "test/model",
        status: "COMPLETED",
        latencyMs: 120,
        totalTokens: 90,
        startedAt: new Date("2026-01-02T10:00:00.000Z"),
        run: { workspaceId: "33333333-3333-4333-8333-333333333333" },
      },
    ]);
    modelInvocation.groupBy.mockResolvedValue([
      { providerId: "local-runtime", _count: { _all: 4 } },
      { providerId: "development-remote", _count: { _all: 3 } },
    ]);
    embeddingInvocation.groupBy.mockResolvedValue([{ providerId: "local-runtime", _count: { _all: 2 } }]);
    auditEvent.count.mockResolvedValue(5);

    const ledger = await readEgressLedger({ limit: 10, configuration: configuration() });

    expect(ledger.summary).toEqual({
      since: null,
      localCalls: 6,
      remoteCalls: 3,
      unknownCalls: 0,
      blockedAttempts: 5,
      remoteHosts: ["openrouter.ai"],
    });
    expect(ledger.entries[0]).toMatchObject({
      kind: "inference",
      channel: "local",
      host: "host.docker.internal:11434",
      workspaceId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("counts a call to an undeclared provider as unknown rather than local", async () => {
    modelInvocation.findMany.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        runId: "55555555-5555-4555-8555-555555555555",
        providerId: "retired-provider",
        profileId: "retired",
        modelId: "gone/model",
        status: "COMPLETED",
        latencyMs: 10,
        totalTokens: 1,
        startedAt: new Date("2026-01-02T10:00:00.000Z"),
        run: { workspaceId: null },
      },
    ]);
    modelInvocation.groupBy.mockResolvedValue([{ providerId: "retired-provider", _count: { _all: 1 } }]);

    const ledger = await readEgressLedger({ limit: 10, configuration: configuration() });

    expect(ledger.summary.unknownCalls).toBe(1);
    expect(ledger.summary.localCalls).toBe(0);
    expect(ledger.entries[0]).toMatchObject({ channel: "unknown", host: null });
  });

  it("interleaves inference and embedding calls newest first", async () => {
    modelInvocation.findMany.mockResolvedValue([
      { id: "a", runId: "r", providerId: "local-runtime", profileId: "p", modelId: "m", status: "COMPLETED", latencyMs: null, totalTokens: null, startedAt: new Date("2026-01-02T12:00:00.000Z"), run: { workspaceId: null } },
    ]);
    embeddingInvocation.findMany.mockResolvedValue([
      { id: "b", providerId: "local-runtime", profileId: "p", modelId: "m", status: "COMPLETED", latencyMs: null, inputTokens: 7, startedAt: new Date("2026-01-02T13:00:00.000Z") },
    ]);

    const ledger = await readEgressLedger({ limit: 10, configuration: configuration() });

    expect(ledger.entries.map((entry) => entry.kind)).toEqual(["embedding", "inference"]);
    expect(ledger.entries[0]).toMatchObject({ totalTokens: 7 });
  });
});

describe("egress probe", () => {
  it("reports every declared remote destination as blocked when there is no route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("fetch failed"), { cause: { code: "ENETUNREACH" } }),
    );

    const result = await probeEgress(configuration());

    expect(result.allBlocked).toBe(true);
    expect(result.targets).toEqual([
      expect.objectContaining({ host: "openrouter.ai", verdict: "blocked", reason: "ENETUNREACH" }),
    ]);
    // Local providers are not probed — they are supposed to be reachable.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://openrouter.ai/");
  });

  it("reports a destination as reachable when the connection succeeds", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 405 }));

    const result = await probeEgress(configuration());

    expect(result.allBlocked).toBe(false);
    expect(result.targets[0]).toMatchObject({ verdict: "reachable" });
  });
});
