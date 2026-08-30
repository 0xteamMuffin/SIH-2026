import { DataClassification, ModelInvocationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/errors.js";
import type { ModelProfile } from "../src/infrastructure/models/model-registry.js";

const { askModelMock, modelInvocationMock } = vi.hoisted(() => ({
  askModelMock: vi.fn(),
  modelInvocationMock: {
    aggregate: vi.fn(),
    create: vi.fn(),
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

describe("model fallback orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelInvocationMock.aggregate.mockResolvedValue({ _max: { attempt: null } });
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
    })).resolves.toEqual({ profile: fallback, response });

    expect(askModelMock.mock.calls.map(([selected]) => selected.id)).toEqual(["primary", "fallback"]);
    expect(modelInvocationMock.create.mock.calls.map(([input]) => input.data.attempt)).toEqual([1, 2]);
    expect(modelInvocationMock.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ status: ModelInvocationStatus.FAILED, sanitizedError: "MODEL_TIMEOUT: Model provider request timed out" }) }));
    expect(modelInvocationMock.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ status: ModelInvocationStatus.SUCCEEDED, totalTokens: 6, finishReason: "stop" }) }));
  });

  it("filters remote profiles before invoking restricted data", async () => {
    const remote = profile("remote", "remote");
    const local = profile("local");
    askModelMock.mockResolvedValue(response);

    await invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "general", profile: remote, fallbacks: [local], reason: "test" },
      classification: DataClassification.CONFIDENTIAL,
      system: "system",
      prompt: "prompt",
    });

    expect(askModelMock).toHaveBeenCalledOnce();
    expect(askModelMock).toHaveBeenCalledWith(local, DataClassification.CONFIDENTIAL, "system", "prompt", undefined);
    expect(modelInvocationMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ profileId: "local", attempt: 1 }) });
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
    })).rejects.toBe(error);

    expect(askModelMock).toHaveBeenCalledOnce();
    expect(modelInvocationMock.create).toHaveBeenCalledOnce();
    expect(modelInvocationMock.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status }) }));
  });

  it("continues attempt ordering from prior worker attempts", async () => {
    modelInvocationMock.aggregate.mockResolvedValue({ _max: { attempt: 3 } });
    askModelMock.mockResolvedValue(response);

    await invokeModelWithFallbacks({
      runId: "run-1",
      decision: { capability: "general", profile: profile("primary"), fallbacks: [], reason: "test" },
      classification: DataClassification.INTERNAL,
      system: "system",
      prompt: "prompt",
    });

    expect(modelInvocationMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ attempt: 4 }) });
  });
});
