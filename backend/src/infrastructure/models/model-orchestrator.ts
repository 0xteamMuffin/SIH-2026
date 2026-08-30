import { DataClassification, ModelInvocationStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { allowsExternalInference } from "../../lib/data-classification.js";
import { askModel, type ModelImageInput, type ModelResponse } from "./model-provider.js";
import type { ModelProfile } from "./model-registry.js";
import type { RoutingDecision } from "./model-router.js";
import type { ModelTokenBudget } from "../../modules/agent/agent-runtime.js";

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

type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

export class RunTokenBudgetError extends AppError {
  constructor(message: string, public readonly budget: ModelTokenBudget, public readonly usage: TokenUsage, code = "RUN_TOKEN_BUDGET_EXCEEDED") {
    super(422, message, code);
  }
}

function ensureBudgetAvailable(budget: ModelTokenBudget, usage: TokenUsage) {
  if (usage.inputTokens >= budget.maxInputTokens) throw new RunTokenBudgetError("Agent run input-token budget exhausted", budget, usage);
  if (usage.outputTokens >= budget.maxOutputTokens) throw new RunTokenBudgetError("Agent run output-token budget exhausted", budget, usage);
  if (usage.totalTokens >= budget.maxTotalTokens) throw new RunTokenBudgetError("Agent run total-token budget exhausted", budget, usage);
}

function ensureBudgetNotExceeded(budget: ModelTokenBudget, usage: TokenUsage) {
  if (usage.inputTokens > budget.maxInputTokens) throw new RunTokenBudgetError("Agent run input-token budget exceeded", budget, usage);
  if (usage.outputTokens > budget.maxOutputTokens) throw new RunTokenBudgetError("Agent run output-token budget exceeded", budget, usage);
  if (usage.totalTokens > budget.maxTotalTokens) throw new RunTokenBudgetError("Agent run total-token budget exceeded", budget, usage);
}

export async function invokeModelWithFallbacks(input: {
  runId: string;
  decision: RoutingDecision;
  classification: DataClassification;
  system: string;
  prompt: string;
  images?: readonly ModelImageInput[];
  signal?: AbortSignal;
  tokenBudget: ModelTokenBudget;
}): Promise<{ profile: ModelProfile; response: ModelResponse }> {
  const candidates = [input.decision.profile, ...input.decision.fallbacks]
    .filter((profile, index, profiles) => profiles.findIndex((candidate) => candidate.id === profile.id) === index)
    .filter((profile) => profile.enabled && profile.capabilities.includes(input.decision.capability))
    .filter((profile) => profile.location === "local" || allowsExternalInference(input.classification));
  if (candidates.length === 0) throw new AppError(422, "No model profile is eligible under the current inference policy", "MODEL_POLICY_BLOCKED");

  const incomplete = await prisma.modelInvocation.findFirst({
    where: { runId: input.runId, status: ModelInvocationStatus.SUCCEEDED, OR: [{ promptTokens: null }, { completionTokens: null }] },
    select: { id: true },
  });
  if (incomplete) {
    throw new RunTokenBudgetError("A prior model invocation did not report token usage", input.tokenBudget, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, "RUN_TOKEN_USAGE_UNAVAILABLE");
  }
  const previous = await prisma.modelInvocation.aggregate({
    where: { runId: input.runId },
    _max: { attempt: true },
    _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
  });
  let attempt = (previous._max.attempt ?? 0) + 1;
  const sums = previous._sum;
  let usage = {
    inputTokens: sums?.promptTokens ?? 0,
    outputTokens: sums?.completionTokens ?? 0,
    totalTokens: Math.max(sums?.totalTokens ?? 0, (sums?.promptTokens ?? 0) + (sums?.completionTokens ?? 0)),
  };
  let lastProviderError: AppError | undefined;

  for (const profile of candidates) {
    input.signal?.throwIfAborted();
    ensureBudgetAvailable(input.tokenBudget, usage);
    const maxOutputTokens = Math.min(
      profile.maxOutputTokens,
      input.tokenBudget.maxOutputTokens - usage.outputTokens,
      input.tokenBudget.maxTotalTokens - usage.totalTokens,
    );
    const boundedProfile = maxOutputTokens === profile.maxOutputTokens ? profile : { ...profile, maxOutputTokens };
    const invocation = await prisma.modelInvocation.create({
      data: { runId: input.runId, providerId: profile.providerId, profileId: profile.id, modelId: profile.modelId, attempt, status: ModelInvocationStatus.RUNNING },
    });
    const startedAt = performance.now();
    let response: ModelResponse;
    try {
      response = await askModel(boundedProfile, input.classification, input.system, input.prompt, input.signal, input.images);
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

    const promptTokens = response.usage?.promptTokens;
    const completionTokens = response.usage?.completionTokens;
    if (promptTokens === undefined || completionTokens === undefined) {
      await prisma.modelInvocation.update({
        where: { id: invocation.id },
        data: { status: ModelInvocationStatus.SUCCEEDED, latencyMs: response.latencyMs, finishReason: response.finishReason, sanitizedError: "RUN_TOKEN_USAGE_UNAVAILABLE: Model provider did not report complete token usage", completedAt: new Date() },
      });
      throw new RunTokenBudgetError("Model provider did not report complete token usage", input.tokenBudget, usage, "RUN_TOKEN_USAGE_UNAVAILABLE");
    }
    const totalTokens = Math.max(response.usage?.totalTokens ?? 0, promptTokens + completionTokens);
    await prisma.modelInvocation.update({
      where: { id: invocation.id },
      data: {
        status: ModelInvocationStatus.SUCCEEDED,
        latencyMs: response.latencyMs,
        promptTokens,
        completionTokens,
        totalTokens,
        finishReason: response.finishReason,
        completedAt: new Date(),
      },
    });
    usage = { inputTokens: usage.inputTokens + promptTokens, outputTokens: usage.outputTokens + completionTokens, totalTokens: usage.totalTokens + totalTokens };
    ensureBudgetNotExceeded(input.tokenBudget, usage);
    return { profile, response };
  }

  throw lastProviderError ?? new AppError(503, "No model provider completed the request", "MODEL_PROVIDERS_EXHAUSTED");
}
