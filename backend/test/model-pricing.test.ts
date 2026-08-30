import { describe, expect, it } from "vitest";
import { estimateInvocationCost } from "../src/infrastructure/models/model-pricing.js";

describe("model pricing", () => {
  it("estimates integer micro-USD from versioned per-million token rates", () => {
    expect(estimateInvocationCost({
      pricing: { version: "vendor-2026-08-30", currency: "USD", inputPerMillionTokens: 0.5, outputPerMillionTokens: 1.5 },
    }, { promptTokens: 10, completionTokens: 4 })).toEqual({
      estimatedCostMicros: 11,
      pricingVersion: "vendor-2026-08-30",
      pricingCurrency: "USD",
    });
  });

  it("returns a versioned zero estimate for free models", () => {
    expect(estimateInvocationCost({
      pricing: { version: "free-2026-08-30", currency: "USD", inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
    }, { promptTokens: 50_000, completionTokens: 10_000 })).toEqual({
      estimatedCostMicros: 0,
      pricingVersion: "free-2026-08-30",
      pricingCurrency: "USD",
    });
  });

  it("does not invent an estimate when pricing is absent", () => {
    expect(estimateInvocationCost({}, { promptTokens: 10, completionTokens: 4 })).toBeUndefined();
  });
});
