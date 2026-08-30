import { DataClassification } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { EmbeddingProfile } from "../src/infrastructure/embeddings/embedding-provider.js";
import { selectEmbeddingProfile } from "../src/infrastructure/embeddings/embedding-profile-resolver.js";
import type { EmbeddingModelProfile } from "../src/infrastructure/models/model-registry.js";

function profile(overrides: Partial<EmbeddingModelProfile> = {}): EmbeddingModelProfile {
  return {
    id: "text-primary",
    providerId: "local",
    location: "local",
    baseUrl: "http://localhost:11434/v1",
    modelId: "embedding-v1",
    capabilities: ["embedding"],
    priority: 10,
    enabled: true,
    sovereign: true,
    maxOutputTokens: 2_048,
    revision: "embedding-v1.0.0",
    dimensions: 1_024,
    distance: "cosine",
    maxBatchInputs: 16,
    maxBatchCharacters: 8_192,
    maxInputCharacters: 4_096,
    inputModalities: ["TEXT"],
    ...overrides,
  };
}

describe("embedding profile resolver", () => {
  it("selects one TEXT profile deterministically by priority and ID", () => {
    const selected = selectEmbeddingProfile(DataClassification.INTERNAL, [
      profile({ id: "z-profile", priority: 20 }),
      profile({ id: "b-profile" }),
      profile({ id: "a-profile" }),
    ]);

    expect(selected.id).toBe("a-profile");
    expect(selected).not.toHaveProperty("fallbacks");
  });

  it("returns a profile accepted by the existing embedding provider", () => {
    const selected: EmbeddingProfile = selectEmbeddingProfile(DataClassification.INTERNAL, [profile()]);

    expect(selected).toMatchObject({
      providerId: "local",
      modelId: "embedding-v1",
      dimensions: 1_024,
      maxBatchInputs: 16,
      maxBatchCharacters: 8_192,
      maxInputCharacters: 4_096,
    });
  });

  it("excludes remote profiles for restricted classifications", () => {
    const remote = profile({ id: "remote", providerId: "remote", location: "remote", sovereign: false, priority: 1 });
    const local = profile({ id: "local", priority: 100 });

    expect(selectEmbeddingProfile(DataClassification.CONFIDENTIAL, [remote, local]).id).toBe("local");
    expect(selectEmbeddingProfile(DataClassification.PUBLIC, [remote, local]).id).toBe("remote");
  });

  it("ignores disabled and non-TEXT embedding profiles", () => {
    const imageOnly = profile({ id: "image", inputModalities: ["IMAGE"], priority: 1 });
    const disabled = profile({ id: "disabled", enabled: false, priority: 2 });

    expect(selectEmbeddingProfile(DataClassification.INTERNAL, [imageOnly, disabled, profile({ id: "text", priority: 100 })]).id).toBe("text");
  });

  it("fails instead of returning a fallback from an ineligible vector space", () => {
    const remote = profile({ id: "remote", providerId: "remote", location: "remote", sovereign: false });

    expect(() => selectEmbeddingProfile(DataClassification.INTERNAL, [remote])).toThrow("No TEXT embedding profile is available under the current data policy");
  });
});
