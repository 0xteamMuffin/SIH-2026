import { z } from "zod";
import { AppError } from "../../lib/errors.js";

export const runtimePhaseSchema = z.enum(["SOURCE", "ANALYZE", "ACTION", "FINALIZE"]);
const tokenBudgetSchema = z.object({
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxTotalTokens: z.number().int().positive(),
}).strict();
const runtimeStateSchema = z.object({
  version: z.literal(1),
  phase: runtimePhaseSchema,
  turn: z.number().int().nonnegative(),
  phaseStarted: z.boolean(),
  tokenBudget: tokenBudgetSchema.optional(),
}).strict();

export type ModelTokenBudget = z.infer<typeof tokenBudgetSchema>;
export type AgentRuntimeState = Omit<z.infer<typeof runtimeStateSchema>, "tokenBudget"> & { tokenBudget: ModelTokenBudget };

export function runtimeState(value: unknown, tokenBudget: ModelTokenBudget): AgentRuntimeState {
  const parsed = runtimeStateSchema.safeParse(value);
  return parsed.success
    ? { ...parsed.data, tokenBudget: parsed.data.tokenBudget ?? tokenBudget }
    : { version: 1, phase: "SOURCE", turn: 0, phaseStarted: false, tokenBudget };
}

export function beginTurn(state: AgentRuntimeState, maxTurns: number, deadlineAt: Date, now = new Date()) {
  if (now >= deadlineAt) throw new AppError(408, "Agent run execution deadline exceeded", "RUN_DEADLINE_EXCEEDED");
  if (state.phaseStarted) return state;
  if (state.turn >= maxTurns) throw new AppError(422, "Agent run turn limit exceeded", "RUN_TURN_LIMIT_EXCEEDED");
  return { ...state, turn: state.turn + 1, phaseStarted: true };
}

export function nextPhase(state: AgentRuntimeState): AgentRuntimeState {
  const phase = state.phase === "SOURCE" ? "ANALYZE" : state.phase === "ANALYZE" ? "ACTION" : "FINALIZE";
  return { ...state, phase, phaseStarted: false };
}

export function progressEvent(state: AgentRuntimeState, summary: string) {
  return { event: "RUN_PROGRESS", phase: state.phase, turn: state.turn, summary };
}
