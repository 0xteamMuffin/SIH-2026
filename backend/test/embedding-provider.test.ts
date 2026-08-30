import { DataClassification } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { embedTexts, type EmbeddingProfile } from "../src/infrastructure/embeddings/embedding-provider.js";

const localProfile: EmbeddingProfile = {
  providerId: "local-embeddings",
  location: "local",
  baseUrl: "http://localhost:11434/v1/",
  modelId: "test-embedding-model",
  dimensions: 3,
  maxBatchInputs: 2,
  maxBatchCharacters: 6,
  maxInputCharacters: 5,
};

const remoteProfile: EmbeddingProfile = {
  ...localProfile,
  providerId: "remote-embeddings",
  location: "remote",
  baseUrl: "https://embeddings.example/v1",
  apiKeyEnv: "TEST_EMBEDDING_API_KEY",
};

function responseFor(inputs: string[], offset = 0): Response {
  return new Response(JSON.stringify({
    object: "list",
    data: inputs.map((_input, index) => ({ object: "embedding", index, embedding: [offset + index, 0.25, -0.5] })),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("OpenAI-compatible embedding provider", () => {
  afterEach(() => {
    delete process.env.TEST_EMBEDDING_API_KEY;
    vi.restoreAllMocks();
  });

  it("accepts profiles enriched with registry routing metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(responseFor(["alpha"]));
    const registryProfile = {
      ...localProfile,
      id: "registry-profile",
      capabilities: ["embedding"],
      priority: 10,
      enabled: true,
      sovereign: true,
      maxOutputTokens: 2_048,
      revision: "v1",
      distance: "cosine",
      inputModalities: ["TEXT"],
    };

    await expect(embedTexts(registryProfile, DataClassification.INTERNAL, ["alpha"])).resolves.toHaveLength(1);
  });

  it("posts OpenAI-compatible requests and returns vectors in input order", async () => {
    process.env.TEST_EMBEDDING_API_KEY = "secret-value";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(responseFor(["alpha", "b"]));

    await expect(embedTexts(remoteProfile, DataClassification.PUBLIC, ["alpha", "b"])).resolves.toEqual([
      [0, 0.25, -0.5],
      [1, 0.25, -0.5],
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://embeddings.example/v1/embeddings");
    expect(request).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer secret-value", "content-type": "application/json" },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(request?.body))).toEqual({ model: "test-embedding-model", input: ["alpha", "b"], dimensions: 3 });
  });

  it("splits batches by input count and total characters without changing order", async () => {
    const inputs = ["aa", "bbb", "c", "dddd", "e"];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(responseFor(["aa", "bbb"], 10))
      .mockResolvedValueOnce(responseFor(["c", "dddd"], 20))
      .mockResolvedValueOnce(responseFor(["e"], 30));

    const vectors = await embedTexts(localProfile, DataClassification.CONFIDENTIAL, inputs);

    expect(vectors.map((vector) => vector[0])).toEqual([10, 11, 20, 21, 30]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).input)).toEqual([
      ["aa", "bbb"],
      ["c", "dddd"],
      ["e"],
    ]);
  });

  it("returns an empty result without contacting or configuring a provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(embedTexts(remoteProfile, DataClassification.CONFIDENTIAL, [])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([DataClassification.INTERNAL, DataClassification.CONFIDENTIAL])("blocks %s data from remote inference before fetch", async (classification) => {
    process.env.TEST_EMBEDDING_API_KEY = "secret-value";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(embedTexts(remoteProfile, classification, ["text"])).rejects.toMatchObject({ status: 422, code: "EXTERNAL_INFERENCE_BLOCKED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([DataClassification.PUBLIC, DataClassification.SYNTHETIC])("allows %s data for remote inference", async (classification) => {
    process.env.TEST_EMBEDDING_API_KEY = "secret-value";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(responseFor(["text"]));

    await expect(embedTexts(remoteProfile, classification, ["text"])).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honors the global remote-inference switch", async () => {
    process.env.TEST_EMBEDDING_API_KEY = "secret-value";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const previous = env.ALLOW_REMOTE_INFERENCE;
    env.ALLOW_REMOTE_INFERENCE = false;

    try {
      await expect(embedTexts(remoteProfile, DataClassification.PUBLIC, ["text"])).rejects.toMatchObject({ status: 503, code: "REMOTE_INFERENCE_DISABLED" });
    } finally {
      env.ALLOW_REMOTE_INFERENCE = previous;
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes missing credentials without exposing the environment variable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(embedTexts(remoteProfile, DataClassification.PUBLIC, ["text"])).rejects.toMatchObject({
      status: 503,
      code: "EMBEDDING_PROVIDER_NOT_CONFIGURED",
      message: "Embedding provider credential is not configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { inputs: [""], code: "EMBEDDING_INPUT_INVALID", status: 422 },
    { inputs: ["123456"], code: "EMBEDDING_INPUT_TOO_LARGE", status: 413 },
  ])("rejects invalid inputs before sending any batch", async ({ inputs, code, status }) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, inputs)).rejects.toMatchObject({ code, status });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates every input before sending the first batch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, ["okay", "123456"])).rejects.toMatchObject({ code: "EMBEDDING_INPUT_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { maxBatchInputs: 0 },
    { maxBatchCharacters: 0 },
    { maxInputCharacters: 7 },
    { dimensions: 1.5 },
    { baseUrl: "file:///models" },
  ])("normalizes invalid profiles before fetch: %o", async (override) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const profile = { ...localProfile, ...override } as EmbeddingProfile;

    await expect(embedTexts(profile, DataClassification.INTERNAL, ["text"])).rejects.toMatchObject({ status: 500, code: "EMBEDDING_PROFILE_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "wrong count", data: [{ index: 0, embedding: [1, 2, 3] }] },
    { name: "out-of-order indexes", data: [{ index: 1, embedding: [1, 2, 3] }, { index: 0, embedding: [4, 5, 6] }] },
    { name: "wrong dimensions", data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3, 4, 5] }] },
    { name: "non-numeric values", data: [{ index: 0, embedding: [1, "2", 3] }, { index: 1, embedding: [4, 5, 6] }] },
  ])("rejects $name", async ({ data }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 }));

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, ["a", "b"])).rejects.toMatchObject({ status: 502, code: "EMBEDDING_RESPONSE_INVALID" });
  });

  it("rejects non-finite vector values", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding: [1, Number.POSITIVE_INFINITY, 3] }] }),
    } as Response);

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, ["text"])).rejects.toMatchObject({ code: "EMBEDDING_RESPONSE_INVALID" });
  });

  it.each([
    { body: "not-json", contentType: "text/plain" },
    { body: JSON.stringify({ data: "not-an-array" }), contentType: "application/json" },
  ])("rejects malformed successful responses", async ({ body, contentType }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": contentType } }));

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, ["text"])).rejects.toMatchObject({ code: "EMBEDDING_RESPONSE_INVALID" });
  });

  it("normalizes rate limits without exposing provider response bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("sensitive upstream details", { status: 429 }));

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, ["text"])).rejects.toMatchObject({
      status: 503,
      code: "EMBEDDING_RATE_LIMITED",
      message: "Embedding provider rate limit exceeded",
    });
  });

  it("normalizes other provider failures using only the status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret provider error", { status: 401 }));

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, ["text"])).rejects.toMatchObject({
      status: 502,
      code: "EMBEDDING_PROVIDER_ERROR",
      message: "Embedding provider request failed with status 401",
    });
  });

  it("normalizes provider unavailability", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DNS failure for a private host"));

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, ["text"])).rejects.toMatchObject({
      status: 502,
      code: "EMBEDDING_PROVIDER_UNAVAILABLE",
      message: "Embedding provider is unavailable",
    });
  });

  it("normalizes provider timeouts", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, ["text"])).rejects.toMatchObject({ status: 504, code: "EMBEDDING_TIMEOUT" });
  });

  it("normalizes caller cancellation and does not start later batches", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort();
      throw new DOMException("private abort detail", "AbortError");
    });

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, ["aa", "bbb", "c"], controller.signal)).rejects.toMatchObject({
      status: 503,
      code: "EMBEDDING_REQUEST_CANCELLED",
      message: "Embedding request was cancelled",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not fetch when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(embedTexts(localProfile, DataClassification.INTERNAL, ["text"], controller.signal)).rejects.toMatchObject({ code: "EMBEDDING_REQUEST_CANCELLED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
