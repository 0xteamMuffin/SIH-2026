import { DataClassification, ModelInvocationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/errors.js";
import type { ModelProfile } from "../src/infrastructure/models/model-registry.js";

const { askModelMock, modelInvocationMock } = vi.hoisted(() => ({
  askModelMock: vi.fn(),
  modelInvocationMock: {
    aggregate: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { modelInvocation: modelInvocationMock } }));
vi.mock("../src/infrastructure/models/model-provider.js", () => ({ askModel: askModelMock }));

import { invokeModelWithFallbacks } from "../src/infrastructure/models/model-orchestrator.js";

const profile = (id: string, location: "local" | "remote" = "local"): ModelProfile => ({
  id,
  providerId: `${id}-provider`,
  location,
  baseUrl: location === "local" ? "http://localhost:11434/v1" : "https://models.example/v1",
  modelId: `${id}-model`,
  capabilities: ["general"],
  priority: id === "primary" ? 10 : 20,
  enabled: true,
  sovereign: location === "local",
  maxOutputTokens: 1_024,
});

const response = { text: "answer", provider: "fallback-provider", modelId: "fallback-model", finishReason: "stop", latencyMs: 25, usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } };
const tokenBudget = { maxInputTokens: 100, maxOutputTokens: 50, maxTotalTokens: 150 };

describe("model fallback orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelInvocationMock.aggregate.mockResolvedValue({ _max: { attempt: null }, _sum: { promptTokens: null, completionTokens: null, totalTokens: null } });
    modelInvocationMock.findFirst.mockResolvedValue(null);
    modelInvocationMock.create.mockImplementation(({ data }) => Promise.resolve({ id: `invocation-${data.attempt}` }));
    modelInvocationMock.update.mockResolvedValue({});
  });

  it("records a provider failure and selects the next profile in order", async () => {
    const primary = profile("primary");
    const fallback = profile("fallback");
    askModelMock.mockRejectedValueOnce(new AppError(504, "Model provider request timed out", "MODEL_TIMEOUT")).mockResolvedValueOnce(response);

    await expect(invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "general", profile: primary, fallbacks: [fallback], reason: "test" },
      classification: DataClassification.INTERNAL,
      system: "system",
      prompt: "prompt",
      tokenBudget,
    })).resolves.toEqual({ profile: fallback, response });

    expect(askModelMock.mock.calls.map(([selected]) => selected.id)).toEqual(["primary", "fallback"]);
    expect(modelInvocationMock.create.mock.calls.map(([input]) => input.data.attempt)).toEqual([1, 2]);
    expect(modelInvocationMock.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ status: ModelInvocationStatus.FAILED, sanitizedError: "MODEL_TIMEOUT: Model provider request timed out" }) }));
    expect(modelInvocationMock.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ status: ModelInvocationStatus.SUCCEEDED, totalTokens: 6, finishReason: "stop" }) }));
  });

  it("filters remote profiles before invoking restricted data", async () => {
    const remote = { ...profile("remote", "remote"), capabilities: ["vision"] as ModelProfile["capabilities"] };
    const local = { ...profile("local"), capabilities: ["vision"] as ModelProfile["capabilities"] };
    const image = { mimeType: "image/jpeg" as const, bytes: Buffer.from([0xff, 0xd8, 0xff]) };
    askModelMock.mockResolvedValue(response);

    await invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "vision", profile: remote, fallbacks: [local], reason: "test" },
      classification: DataClassification.CONFIDENTIAL,
      system: "system",
      prompt: "prompt",
      images: [image],
      tokenBudget,
    });

    expect(askModelMock).toHaveBeenCalledOnce();
    expect(askModelMock).toHaveBeenCalledWith({ ...local, maxOutputTokens: tokenBudget.maxOutputTokens }, DataClassification.CONFIDENTIAL, "system", "prompt", undefined, [image]);
    expect(modelInvocationMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ profileId: "local", attempt: 1 }) });
    const telemetryCalls = JSON.stringify({ creates: modelInvocationMock.create.mock.calls, updates: modelInvocationMock.update.mock.calls });
    expect(telemetryCalls).not.toContain('"image"');
    expect(telemetryCalls).not.toContain('"type":"Buffer"');
  });

  it.each([
    ["cancellation", new AppError(503, "Model request was cancelled", "MODEL_REQUEST_CANCELLED"), ModelInvocationStatus.CANCELLED],
    ["policy rejection", new AppError(422, "External inference is restricted", "EXTERNAL_INFERENCE_BLOCKED"), ModelInvocationStatus.FAILED],
  ])("does not fall back after %s", async (_name, error, status) => {
    askModelMock.mockRejectedValue(error);

    await expect(invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "general", profile: profile("primary"), fallbacks: [profile("fallback")], reason: "test" },
      classification: DataClassification.INTERNAL,
      system: "system",
      prompt: "prompt",
      tokenBudget,
    })).rejects.toBe(error);

    expect(askModelMock).toHaveBeenCalledOnce();
    expect(modelInvocationMock.create).toHaveBeenCalledOnce();
    expect(modelInvocationMock.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status }) }));
  });

  it("continues attempt ordering from prior worker attempts", async () => {
    modelInvocationMock.aggregate.mockResolvedValue({ _max: { attempt: 3 }, _sum: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } });
    askModelMock.mockResolvedValue(response);

    await invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "general", profile: profile("primary"), fallbacks: [], reason: "test" },
      classification: DataClassification.INTERNAL,
      system: "system",
      prompt: "prompt",
      tokenBudget,
    });

    expect(modelInvocationMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ attempt: 4 }) });
  });

  it("allows an invocation that reaches the exact token boundaries", async () => {
    askModelMock.mockResolvedValue({ ...response, usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } });

    await expect(invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "general", profile: profile("primary"), fallbacks: [], reason: "test" },
      classification: DataClassification.INTERNAL,
      system: "system",
      prompt: "prompt",
      tokenBudget: { maxInputTokens: 4, maxOutputTokens: 2, maxTotalTokens: 6 },
    })).resolves.toEqual({ profile: profile("primary"), response: { ...response, usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } } });
  });

  it("stops before another fallback when persisted usage has exhausted a budget", async () => {
    modelInvocationMock.aggregate.mockResolvedValue({ _max: { attempt: 1 }, _sum: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } });

    await expect(invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "general", profile: profile("primary"), fallbacks: [profile("fallback")], reason: "test" },
      classification: DataClassification.INTERNAL,
      system: "system",
      prompt: "prompt",
      tokenBudget,
    })).rejects.toMatchObject({ code: "RUN_TOKEN_BUDGET_EXCEEDED" });

    expect(askModelMock).not.toHaveBeenCalled();
    expect(modelInvocationMock.create).not.toHaveBeenCalled();
  });

  it("persists usage and fails after a response exceeds the input budget", async () => {
    askModelMock.mockResolvedValue({ ...response, usage: { promptTokens: 101, completionTokens: 2, totalTokens: 103 } });

    await expect(invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "general", profile: profile("primary"), fallbacks: [], reason: "test" },
      classification: DataClassification.INTERNAL,
      system: "system",
      prompt: "prompt",
      tokenBudget,
    })).rejects.toMatchObject({ code: "RUN_TOKEN_BUDGET_EXCEEDED", usage: { inputTokens: 101, outputTokens: 2, totalTokens: 103 } });

    expect(modelInvocationMock.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ promptTokens: 101, completionTokens: 2, totalTokens: 103 }) }));
  });

  it("fails closed when a successful provider omits usage", async () => {
    askModelMock.mockResolvedValue({ ...response, usage: undefined });

    await expect(invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "general", profile: profile("primary"), fallbacks: [], reason: "test" },
      classification: DataClassification.INTERNAL,
      system: "system",
      prompt: "prompt",
      tokenBudget,
    })).rejects.toMatchObject({ code: "RUN_TOKEN_USAGE_UNAVAILABLE" });
  });

  it("persists a versioned zero estimate for a free invocation", async () => {
    askModelMock.mockResolvedValue(response);
    const free = profile("primary");
    free.pricing = { version: "free-2026-08-30", currency: "USD", inputPerMillionTokens: 0, outputPerMillionTokens: 0 };

    await invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "general", profile: free, fallbacks: [], reason: "test" },
      classification: DataClassification.INTERNAL,
      system: "system",
      prompt: "prompt",
      tokenBudget,
    });

    expect(modelInvocationMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ estimatedCostMicros: 0, pricingVersion: "free-2026-08-30", pricingCurrency: "USD" }) });
    expect(modelInvocationMock.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ estimatedCostMicros: 0 }) }));
  });
});
