import { DataClassification, ModelInvocationStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { allowsExternalInference } from "../../lib/data-classification.js";
import { askModel, type ModelResponse } from "./model-provider.js";
import type { ModelProfile } from "./model-registry.js";
import type { RoutingDecision } from "./model-router.js";

const providerFailureCodes = new Set([
  "MODEL_PROVIDER_NOT_CONFIGURED",
  "MODEL_TIMEOUT",
  "MODEL_PROVIDER_UNAVAILABLE",
  "MODEL_RATE_LIMITED",
  "MODEL_PROVIDER_ERROR",
  "MODEL_RESPONSE_INVALID",
  "MODEL_RESPONSE_EMPTY",
]);

function isCancellation(error: unknown, signal?: AbortSignal) {
  return signal?.aborted
    || (error instanceof AppError && error.code === "MODEL_REQUEST_CANCELLED")
    || (error instanceof Error && error.name === "AbortError");
}

function isProviderFailure(error: unknown): error is AppError {
  return error instanceof AppError && providerFailureCodes.has(error.code);
}

function sanitizedError(error: unknown) {
  return error instanceof AppError
    ? `${error.code}: ${error.message}`.slice(0, 500)
    : "MODEL_INVOCATION_FAILED: Unexpected model invocation failure";
}

export async function invokeModelWithFallbacks(input: {
  runId: string;
  decision: RoutingDecision;
  classification: DataClassification;
  system: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<{ profile: ModelProfile; response: ModelResponse }> {
  const candidates = [input.decision.profile, ...input.decision.fallbacks]
    .filter((profile, index, profiles) => profiles.findIndex((candidate) => candidate.id === profile.id) === index)
    .filter((profile) => profile.enabled && profile.capabilities.includes(input.decision.capability))
    .filter((profile) => profile.location === "local" || allowsExternalInference(input.classification));
  if (candidates.length === 0) throw new AppError(422, "No model profile is eligible under the current inference policy", "MODEL_POLICY_BLOCKED");

  const previous = await prisma.modelInvocation.aggregate({ where: { runId: input.runId }, _max: { attempt: true } });
  let attempt = (previous._max.attempt ?? 0) + 1;
  let lastProviderError: AppError | undefined;

  for (const profile of candidates) {
    input.signal?.throwIfAborted();
    const invocation = await prisma.modelInvocation.create({
      data: { runId: input.runId, providerId: profile.providerId, profileId: profile.id, modelId: profile.modelId, attempt, status: ModelInvocationStatus.RUNNING },
    });
    const startedAt = performance.now();
    let response: ModelResponse;
    try {
      response = await askModel(profile, input.classification, input.system, input.prompt, input.signal);
    } catch (error) {
      const cancelled = isCancellation(error, input.signal);
      await prisma.modelInvocation.update({
        where: { id: invocation.id },
        data: {
          status: cancelled ? ModelInvocationStatus.CANCELLED : ModelInvocationStatus.FAILED,
          latencyMs: Math.round(performance.now() - startedAt),
          sanitizedError: sanitizedError(error),
          completedAt: new Date(),
        },
      });
      if (cancelled || !isProviderFailure(error)) throw error;
      lastProviderError = error;
      attempt += 1;
      continue;
    }

    await prisma.modelInvocation.update({
      where: { id: invocation.id },
      data: {
        status: ModelInvocationStatus.SUCCEEDED,
        latencyMs: response.latencyMs,
        promptTokens: response.usage?.promptTokens,
        completionTokens: response.usage?.completionTokens,
        totalTokens: response.usage?.totalTokens,
        finishReason: response.finishReason,
        completedAt: new Date(),
      },
    });
    return { profile, response };
  }

  throw lastProviderError ?? new AppError(503, "No model provider completed the request", "MODEL_PROVIDERS_EXHAUSTED");
}
