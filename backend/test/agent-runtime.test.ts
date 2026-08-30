import { describe, expect, it } from "vitest";
import { beginTurn, nextPhase, progressEvent, runtimeState } from "../src/modules/agent/agent-runtime.js";

describe("bounded agent runtime", () => {
  it("persists one turn per phase and does not count a resumed phase twice", () => {
    const first = beginTurn(runtimeState({}), 4, new Date("2026-08-30T12:01:00Z"), new Date("2026-08-30T12:00:00Z"));
    const resumed = beginTurn(first, 4, new Date("2026-08-30T12:01:00Z"), new Date("2026-08-30T12:00:01Z"));

    expect(first).toEqual({ version: 1, phase: "SOURCE", turn: 1, phaseStarted: true });
    expect(resumed).toEqual(first);
    expect(nextPhase(first)).toEqual({ version: 1, phase: "ANALYZE", turn: 1, phaseStarted: false });
  });

  it("enforces the snapshotted turn limit and deadline", () => {
    const deadline = new Date("2026-08-30T12:01:00Z");
    expect(() => beginTurn({ version: 1, phase: "FINALIZE", turn: 4, phaseStarted: false }, 4, deadline, new Date("2026-08-30T12:00:00Z"))).toThrow("turn limit");
    expect(() => beginTurn(runtimeState({}), 4, deadline, deadline)).toThrow("deadline");
  });

  it("emits concise progress without a reasoning field", () => {
    const event = progressEvent({ version: 1, phase: "ACTION", turn: 3, phaseStarted: true }, "Waiting for approval");
    expect(event).toEqual({ event: "RUN_PROGRESS", phase: "ACTION", turn: 3, summary: "Waiting for approval" });
    expect(event).not.toHaveProperty("reasoning");
  });
});
