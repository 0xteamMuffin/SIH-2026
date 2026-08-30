import { DataClassification } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { modelProfiles, parseModelConfiguration, type ModelProfile } from "../src/infrastructure/models/model-registry.js";
import { routingDecisionForPersistedRun, selectModel } from "../src/infrastructure/models/model-router.js";

const profiles: ModelProfile[] = [
  { id: "general", providerId: "remote", location: "remote", baseUrl: "https://models.example/v1", modelId: "vendor/general", capabilities: ["general", "document"], priority: 20, enabled: true, sovereign: false, maxOutputTokens: 1_024 },
  { id: "vision-primary", providerId: "remote", location: "remote", baseUrl: "https://models.example/v1", modelId: "vendor/vision", capabilities: ["vision"], priority: 10, enabled: true, sovereign: false, maxOutputTokens: 2_048 },
  { id: "vision-fallback", providerId: "remote", location: "remote", baseUrl: "https://models.example/v1", modelId: "vendor/vision-small", capabilities: ["vision"], priority: 50, enabled: true, sovereign: false, maxOutputTokens: 1_024 },
];

describe("model registry", () => {
  it("joins provider settings and derives sovereignty from location", () => {
    const [profile] = parseModelConfiguration(JSON.stringify({
      providers: [{ id: "on-premise", location: "local", baseUrl: "http://localhost:11434/v1/" }],
      models: [{ id: "general", providerId: "on-premise", modelId: "qwen", capabilities: ["general"] }],
    }));

    expect(profile).toMatchObject({ id: "general", providerId: "on-premise", baseUrl: "http://localhost:11434/v1", priority: 100, sovereign: true });
  });

  it("rejects duplicate model identifiers", () => {
    const input = JSON.stringify({
      providers: [{ id: "local", location: "local", baseUrl: "http://localhost:11434/v1" }],
      models: [
        { id: "duplicate", providerId: "local", modelId: "one", capabilities: ["general"] },
        { id: "duplicate", providerId: "local", modelId: "two", capabilities: ["code"] },
      ],
    });

    expect(() => parseModelConfiguration(input)).toThrow("Duplicate model profile");
  });

  it("rejects models referencing unknown providers", () => {
    const input = JSON.stringify({
      providers: [{ id: "local", location: "local", baseUrl: "http://localhost:11434/v1" }],
      models: [{ id: "general", providerId: "missing", modelId: "one", capabilities: ["general"] }],
    });

    expect(() => parseModelConfiguration(input)).toThrow("Unknown provider");
  });

  it("routes capabilities by deterministic priority with ordered fallbacks", () => {
    const decision = selectModel("Review this scanned drawing", true, profiles);

    expect(decision.capability).toBe("vision");
    expect(decision.profile.id).toBe("vision-primary");
    expect(decision.fallbacks.map((profile) => profile.id)).toEqual(["vision-fallback"]);
  });

  it("routes coding tasks independently from attachments", () => {
    const codeProfile: ModelProfile = { id: "code", providerId: "local", location: "local", baseUrl: "http://localhost:11434/v1", modelId: "coder", capabilities: ["code"], priority: 10, enabled: true, sovereign: true, maxOutputTokens: 2_048 };

    expect(selectModel("Write and test Python code", true, [...profiles, codeProfile]).profile.id).toBe("code");
  });

  it("loads the configured registry and excludes remote profiles when disabled", () => {
    const previous = env.ALLOW_REMOTE_INFERENCE;
    env.ALLOW_REMOTE_INFERENCE = false;
    try {
      expect(modelProfiles()).not.toHaveLength(0);
      expect(modelProfiles().every((profile) => profile.location === "local")).toBe(true);
    } finally {
      env.ALLOW_REMOTE_INFERENCE = previous;
    }
  });

  it("keeps a persisted primary first and reconstructs current ordered fallbacks", () => {
    const decision = routingDecisionForPersistedRun({ taskCapability: "vision", modelProfile: "vision-fallback", modelReason: "persisted", dataClassification: DataClassification.PUBLIC }, profiles);

    expect(decision.profile.id).toBe("vision-fallback");
    expect(decision.fallbacks.map((profile) => profile.id)).toEqual(["vision-primary"]);
  });

  it("uses an eligible current fallback when a persisted remote primary is filtered out", () => {
    const local: ModelProfile = { ...profiles[0], id: "local-general", providerId: "local", location: "local", baseUrl: "http://localhost:11434/v1", modelId: "local/general", sovereign: true };
    const decision = routingDecisionForPersistedRun({ taskCapability: "general", modelProfile: "remote-general", modelReason: "persisted", dataClassification: DataClassification.INTERNAL }, [local]);

    expect(decision.profile.id).toBe("local-general");
    expect(decision.reason).toContain("no longer eligible");
  });

  it("excludes optional providers whose endpoint or credential is absent", () => {
    const previous = env.ALLOW_REMOTE_INFERENCE;
    env.ALLOW_REMOTE_INFERENCE = true;
    try {
      const profiles = modelProfiles();
      expect(profiles.some((profile) => profile.providerId === "development-remote")).toBe(Boolean(process.env.REMOTE_MODEL_API_KEY));
      expect(profiles.some((profile) => profile.providerId === "cloudflare")).toBe(Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_AI_BASE_URL));
    } finally {
      env.ALLOW_REMOTE_INFERENCE = previous;
    }
  });
});
