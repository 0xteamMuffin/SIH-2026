import { describe, expect, it } from "vitest";
import { parseModelRegistry, type ModelProfile } from "../src/infrastructure/models/model-registry.js";
import { selectModel } from "../src/infrastructure/models/model-router.js";

const profiles: ModelProfile[] = [
  { id: "general", provider: "openrouter", modelId: "vendor/general", capabilities: ["general", "document"], priority: 20, enabled: true, sovereign: false, maxOutputTokens: 1_024 },
  { id: "vision-primary", provider: "openrouter", modelId: "vendor/vision", capabilities: ["vision"], priority: 10, enabled: true, sovereign: false, maxOutputTokens: 2_048 },
  { id: "vision-fallback", provider: "openrouter", modelId: "vendor/vision-small", capabilities: ["vision"], priority: 50, enabled: true, sovereign: false, maxOutputTokens: 1_024 },
];

describe("model registry", () => {
  it("validates profiles and derives sovereignty from the provider", () => {
    const [profile] = parseModelRegistry(JSON.stringify([{ id: "local", provider: "local", modelId: "qwen", capabilities: ["general"] }]));

    expect(profile).toMatchObject({ id: "local", priority: 100, enabled: true, sovereign: true, maxOutputTokens: 2_048 });
  });

  it("rejects duplicate profile identifiers", () => {
    const input = JSON.stringify([
      { id: "duplicate", provider: "local", modelId: "one", capabilities: ["general"] },
      { id: "duplicate", provider: "local", modelId: "two", capabilities: ["code"] },
    ]);

    expect(() => parseModelRegistry(input)).toThrow("Duplicate model profile");
  });

  it("routes capabilities by deterministic priority with ordered fallbacks", () => {
    const decision = selectModel("Review this scanned drawing", true, profiles);

    expect(decision.capability).toBe("vision");
    expect(decision.profile.id).toBe("vision-primary");
    expect(decision.fallbacks.map((profile) => profile.id)).toEqual(["vision-fallback"]);
  });

  it("routes coding tasks independently from attachments", () => {
    const codeProfile: ModelProfile = { id: "code", provider: "local", modelId: "coder", capabilities: ["code"], priority: 10, enabled: true, endpoint: "http://localhost:11434/v1", sovereign: true, maxOutputTokens: 2_048 };

    expect(selectModel("Write and test Python code", true, [...profiles, codeProfile]).profile.id).toBe("code");
  });
});
