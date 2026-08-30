import type { ModelProfile } from "./model-registry.js";

export type InvocationCostEstimate = {
  estimatedCostMicros: number;
  pricingVersion: string;
  pricingCurrency: "USD";
};

export function estimateInvocationCost(
  profile: Pick<ModelProfile, "pricing">,
  usage: { promptTokens: number; completionTokens: number },
): InvocationCostEstimate | undefined {
  if (!profile.pricing) return undefined;
  const estimatedCostMicros = Math.round(
    usage.promptTokens * profile.pricing.inputPerMillionTokens
    + usage.completionTokens * profile.pricing.outputPerMillionTokens,
  );
  if (!Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros > 2_147_483_647) return undefined;
  return {
    estimatedCostMicros,
    pricingVersion: profile.pricing.version,
    pricingCurrency: profile.pricing.currency,
  };
}
