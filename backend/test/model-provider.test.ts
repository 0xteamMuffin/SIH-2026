import { DataClassification } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { askModel } from "../src/infrastructure/models/model-provider.js";
import type { ModelProfile } from "../src/infrastructure/models/model-registry.js";

const openRouterProfile: ModelProfile = {
  id: "openrouter-test",
  provider: "openrouter",
  modelId: "test/model",
  capabilities: ["general"],
  priority: 100,
  enabled: true,
  sovereign: false,
  maxOutputTokens: 2_048,
};

describe("model provider policy", () => {
  it.each([DataClassification.INTERNAL, DataClassification.CONFIDENTIAL])("blocks %s data before making an external request", async (classification) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(askModel(openRouterProfile, classification, "system", "prompt")).rejects.toMatchObject({
      status: 422,
      code: "EXTERNAL_INFERENCE_BLOCKED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
