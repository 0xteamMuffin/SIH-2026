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
const localVisionProfile: ModelProfile = { ...localProfile, id: "local-vision", capabilities: ["vision"] };

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
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({ model: "local/model", max_tokens: 2_048 });
    expect(body.messages[1]).toEqual({ role: "user", content: "prompt" });
  });

  it("uses OpenAI-compatible text and image parts without changing the text prompt", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "Observed image." } }],
    }), { status: 200 }));
    const image = { mimeType: "image/png" as const, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };

    await askModel(localVisionProfile, DataClassification.INTERNAL, "system", "OCR text", undefined, [image]);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[1].content[0]).toEqual({ type: "text", text: "OCR text" });
    expect(body.messages[1].content[1].type).toBe("image_url");
    expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(body.messages[1].content[1].image_url.url.length).toBe("data:image/png;base64,".length + image.bytes.toString("base64").length);
  });

  it("rejects TIFF explicitly before contacting the provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(askModel(localVisionProfile, DataClassification.INTERNAL, "system", "OCR text", undefined, [{ mimeType: "image/tiff", bytes: Buffer.from([1]) }]))
      .rejects.toMatchObject({ status: 415, code: "VISION_PROVIDER_MIME_UNSUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects images above the configured byte limit before contacting the provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(askModel(localVisionProfile, DataClassification.INTERNAL, "system", "OCR text", undefined, [{ mimeType: "image/webp", bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }]))
      .rejects.toMatchObject({ status: 413, code: "VISION_IMAGE_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends multiple images after the deterministic extraction text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "Observed pages." } }] }), { status: 200 }));
    const images = [Buffer.from("page-1"), Buffer.from("page-2")].map((bytes) => ({ mimeType: "image/png" as const, bytes }));

    await askModel(localVisionProfile, DataClassification.INTERNAL, "system", "Extracted PDF text", undefined, images);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[1].content).toHaveLength(3);
    expect(body.messages[1].content[0]).toEqual({ type: "text", text: "Extracted PDF text" });
    expect(body.messages[1].content.slice(1).every((part: { type: string }) => part.type === "image_url")).toBe(true);
  });

  it("rejects images whose combined bytes exceed the request limit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const images = [Buffer.alloc(6 * 1024 * 1024), Buffer.alloc(6 * 1024 * 1024)].map((bytes) => ({ mimeType: "image/png" as const, bytes }));

    await expect(askModel(localVisionProfile, DataClassification.INTERNAL, "system", "text", undefined, images))
      .rejects.toMatchObject({ status: 413, code: "VISION_IMAGES_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
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
