import { DataClassification } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askModel } from "../src/infrastructure/models/model-provider.js";
import type { ModelProfile } from "../src/infrastructure/models/model-registry.js";

const remoteProfile: ModelProfile = {
  id: "remote-test",
  providerId: "remote-provider",
  location: "remote",
  baseUrl: "https://models.example/v1",
  apiKeyEnv: "REMOTE_MODEL_API_KEY",
  modelId: "test/model",
  capabilities: ["general"],
  priority: 100,
  enabled: true,
  sovereign: false,
  maxOutputTokens: 2_048,
};
const localProfile: ModelProfile = { ...remoteProfile, id: "local-test", providerId: "local-provider", location: "local", baseUrl: "http://localhost:11434/v1", apiKeyEnv: undefined, modelId: "local/model", sovereign: true };

describe("model provider policy", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([DataClassification.INTERNAL, DataClassification.CONFIDENTIAL])("blocks %s data before making an external request", async (classification) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(askModel(remoteProfile, classification, "system", "prompt")).rejects.toMatchObject({
      status: 422,
      code: "EXTERNAL_INFERENCE_BLOCKED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes missing remote provider credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(askModel(remoteProfile, DataClassification.PUBLIC, "system", "prompt")).rejects.toMatchObject({ status: 503, code: "MODEL_PROVIDER_NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes successful provider responses and usage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "  Completed analysis.  " } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await askModel(localProfile, DataClassification.CONFIDENTIAL, "system", "prompt");

    expect(result).toMatchObject({ text: "Completed analysis.", provider: "local-provider", modelId: "local/model", finishReason: "stop", usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:11434/v1/chat/completions", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: "local/model", max_tokens: 2_048 });
  });

  it("normalizes rate limits without exposing provider response bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("sensitive upstream details", { status: 429 }));

    await expect(askModel(localProfile, DataClassification.INTERNAL, "system", "prompt")).rejects.toMatchObject({ status: 503, code: "MODEL_RATE_LIMITED" });
  });

  it("rejects malformed successful responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));

    await expect(askModel(localProfile, DataClassification.INTERNAL, "system", "prompt")).rejects.toMatchObject({ status: 502, code: "MODEL_RESPONSE_INVALID" });
  });

  it("normalizes provider timeouts", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Timed out", "TimeoutError"));

    await expect(askModel(localProfile, DataClassification.INTERNAL, "system", "prompt")).rejects.toMatchObject({ status: 504, code: "MODEL_TIMEOUT" });
  });
});
