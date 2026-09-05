import { RunStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Prior turns of a chat thread, loaded so a follow-up can refer to what has
 * already been asked and answered.
 *
 * Runs are otherwise independent: each one carries a single task string and no
 * memory. Without this, "make it shorter" or "why?" has nothing to attach to.
 */

export interface ConversationTurn {
  task: string;
  answer: string;
}

/** Turns loaded per request. Older context is dropped, not summarised. */
const MAX_TURNS = 8;

/** Per-answer budget, so one long analysis cannot crowd out the rest. */
const MAX_ANSWER_CHARS = 1_200;

/** Whole-history budget, to bound what a long thread adds to every prompt. */
const MAX_TOTAL_CHARS = 8_000;

/**
 * Loads the most recent completed turns of a conversation, oldest first.
 *
 * Only completed runs contribute: a failed or cancelled turn has no answer
 * worth conditioning on, and replaying its task would invite the model to
 * repeat work that already went wrong.
 */
export async function loadConversationHistory(input: {
  workspaceId: string;
  conversationId: string | null;
  excludeRunId: string;
}): Promise<ConversationTurn[]> {
  if (!input.conversationId) return [];

  const runs = await prisma.agentRun.findMany({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      status: RunStatus.COMPLETED,
      id: { not: input.excludeRunId },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_TURNS,
    select: { task: true, result: true },
  });

  const turns: ConversationTurn[] = [];
  let budget = MAX_TOTAL_CHARS;

  // Walk newest first so the oldest turns are the ones dropped when the
  // budget runs out, then restore chronological order for the prompt.
  for (const run of runs) {
    const answer = extractAnswer(run.result);
    if (!answer) continue;

    const trimmed = answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS)}…` : answer;
    const cost = run.task.length + trimmed.length;
    if (cost > budget) break;

    budget -= cost;
    turns.push({ task: run.task, answer: trimmed });
  }

  return turns.reverse();
}

function extractAnswer(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const analysis = (result as { analysis?: unknown }).analysis;
  if (typeof analysis !== "string") return null;

  const trimmed = analysis.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Renders history as a transcript the model can read. */
export function conversationPrompt(turns: ConversationTurn[]): string {
  return turns.map((turn) => `User: ${turn.task}\nAssistant: ${turn.answer}`).join("\n\n");
}
