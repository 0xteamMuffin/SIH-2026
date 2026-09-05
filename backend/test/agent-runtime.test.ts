import { describe, expect, it } from "vitest";
import { assertWithinDeadline, progressEvent, runtimeState } from "../src/modules/agent/agent-runtime.js";

const tokenBudget = { maxInputTokens: 100, maxOutputTokens: 50, maxTotalTokens: 150 };

describe("runtimeState", () => {
  it("starts a fresh run at iteration zero", () => {
    expect(runtimeState({}, tokenBudget)).toEqual({ version: 2, iteration: 0, tokenBudget });
  });

  it("resumes from a persisted iteration", () => {
    const persisted = { version: 2 as const, iteration: 3, tokenBudget };

    expect(runtimeState(persisted, tokenBudget)).toEqual(persisted);
  });

  it("keeps the budget the run was admitted with", () => {
    // Re-reading current configuration on resume would let a mid-flight change
    // move a ceiling the run has already been accounted against.
    const admitted = { maxInputTokens: 10, maxOutputTokens: 5, maxTotalTokens: 12 };

    expect(runtimeState({ version: 2, iteration: 1, tokenBudget: admitted }, tokenBudget).tokenBudget).toEqual(admitted);
  });

  it("supplies the configured budget when a persisted state omits one", () => {
    expect(runtimeState({ version: 2, iteration: 1 }, tokenBudget).tokenBudget).toEqual(tokenBudget);
  });

  it("restarts a run whose state predates the loop", () => {
    // The old phase machine's position has no meaning in an iterative loop, so
    // such a run begins again rather than resuming into an uninterpretable shape.
    const legacy = { version: 1, phase: "ANALYZE", turn: 2, phaseStarted: true };

    expect(runtimeState(legacy, tokenBudget)).toEqual({ version: 2, iteration: 0, tokenBudget });
  });

  it("restarts on an unparseable state rather than throwing", () => {
    for (const value of [null, "corrupt", 42, { iteration: -1 }]) {
      expect(runtimeState(value, tokenBudget).iteration).toBe(0);
    }
  });
});

describe("assertWithinDeadline", () => {
  it("passes before the deadline", () => {
    expect(() => assertWithinDeadline(new Date("2026-08-30T12:01:00Z"), new Date("2026-08-30T12:00:00Z"))).not.toThrow();
  });

  it("fails once the deadline has passed", () => {
    const deadline = new Date("2026-08-30T12:01:00Z");

    expect(() => assertWithinDeadline(deadline, deadline)).toThrow("deadline");
  });

  it("reports a distinguishable code so the run fails terminally", () => {
    const deadline = new Date("2026-08-30T12:01:00Z");

    try {
      assertWithinDeadline(deadline, deadline);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("RUN_DEADLINE_EXCEEDED");
    }
  });
});

describe("progressEvent", () => {
  it("reports the iteration without a reasoning field", () => {
    const event = progressEvent({ version: 2, iteration: 3, tokenBudget }, "Iteration 3");

    expect(event).toEqual({ event: "RUN_PROGRESS", iteration: 3, summary: "Iteration 3" });
    // Progress is persisted and read by clients, so private model reasoning
    // must never travel with it.
    expect(JSON.stringify(event)).not.toMatch(/reasoning|thought/i);
  });
});
