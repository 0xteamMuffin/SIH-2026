import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { probeModelProviders } from "../src/infrastructure/models/model-provider-status.js";
import type { ModelConfiguration } from "../src/infrastructure/models/model-registry.js";

function configuration(location: "local" | "remote" = "local"): ModelConfiguration {
  return {
    providers: [{ id: "provider", location, baseUrl: "https://models.example/v1", apiKeyEnv: location === "remote" ? "TEST_PROBE_KEY" : undefined }],
    profiles: [
      { id: "chat", providerId: "provider", location, baseUrl: "https://models.example/v1", apiKeyEnv: location === "remote" ? "TEST_PROBE_KEY" : undefined, modelId: "chat-v1", capabilities: ["general"], priority: 1, enabled: true, sovereign: location === "local", maxOutputTokens: 100 },
      { id: "code", providerId: "provider", location, baseUrl: "https://models.example/v1", apiKeyEnv: location === "remote" ? "TEST_PROBE_KEY" : undefined, modelId: "code-v1", capabilities: ["code"], priority: 2, enabled: true, sovereign: location === "local", maxOutputTokens: 100 },
    ],
  };
}

describe("model provider status probes", () => {
  afterEach(() => {
    delete process.env.TEST_PROBE_KEY;
    vi.restoreAllMocks();
  });

  it("uses a content-free model catalog request and reports capability availability", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "chat-v1" }] }), { status: 200 }));

    const result = await probeModelProviders(configuration());

    expect(fetchMock).toHaveBeenCalledWith("https://models.example/v1/models", expect.objectContaining({ method: "GET" }));
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("body");
    expect(result.providers[0]).toMatchObject({ status: "degraded", capabilities: ["code", "general"], availableCapabilities: ["general"] });
    expect(result.providers[0].profiles.map(({ profileId, available }) => ({ profileId, available }))).toEqual([
      { profileId: "chat", available: true },
      { profileId: "code", available: false },
    ]);
  });

  it("does not contact disabled remote providers", async () => {
    process.env.TEST_PROBE_KEY = "secret";
    const previous = env.ALLOW_REMOTE_INFERENCE;
    env.ALLOW_REMOTE_INFERENCE = false;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const result = await probeModelProviders(configuration("remote"));
      expect(result.providers[0].status).toBe("disabled");
    } finally {
      env.ALLOW_REMOTE_INFERENCE = previous;
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing credentials without exposing their environment-variable name", async () => {
    const result = await probeModelProviders(configuration("remote"));

    expect(result.providers[0].status).toBe("not_configured");
    expect(JSON.stringify(result)).not.toContain("TEST_PROBE_KEY");
  });
});
