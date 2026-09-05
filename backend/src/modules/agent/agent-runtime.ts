import { z } from "zod";
import { AppError } from "../../lib/errors.js";

const tokenBudgetSchema = z.object({
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxTotalTokens: z.number().int().positive(),
}).strict();
/**
 * A run's resumable position.
 *
 * The agentic loop has no phases: it iterates until the model finishes, so the
 * only thing worth checkpointing is how many iterations have completed. A
 * resumed run rebuilds everything else from the persisted transcript.
 */
const runtimeStateSchema = z.object({
  version: z.literal(2),
  iteration: z.number().int().nonnegative(),
  tokenBudget: tokenBudgetSchema.optional(),
}).strict();

export type ModelTokenBudget = z.infer<typeof tokenBudgetSchema>;
export type AgentRuntimeState = Omit<z.infer<typeof runtimeStateSchema>, "tokenBudget"> & { tokenBudget: ModelTokenBudget };

/**
 * Reads a run's state, falling back to a fresh one.
 *
 * A state written by an earlier version no longer parses, which is deliberate:
 * such a run restarts from iteration zero rather than resuming into a shape
 * the loop cannot interpret.
 */
export function runtimeState(value: unknown, tokenBudget: ModelTokenBudget): AgentRuntimeState {
  const parsed = runtimeStateSchema.safeParse(value);
  return parsed.success
    ? { ...parsed.data, tokenBudget: parsed.data.tokenBudget ?? tokenBudget }
    : { version: 2, iteration: 0, tokenBudget };
}

export function assertWithinDeadline(deadlineAt: Date, now = new Date()): void {
  if (now >= deadlineAt) throw new AppError(408, "Agent run execution deadline exceeded", "RUN_DEADLINE_EXCEEDED");
}

export function progressEvent(state: AgentRuntimeState, summary: string) {
  return { event: "RUN_PROGRESS", iteration: state.iteration, summary };
}
