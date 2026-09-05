import type { DataClassification } from "@prisma/client";

import type { ConversationTurn } from "./conversation-history.js";
import type { EvidenceItem } from "./agent.types.js";

/**
 * System prompt for the agentic loop.
 *
 * Budgets are stated explicitly because a model that knows it has two turns
 * left behaves differently from one that does not — it stops exploring and
 * commits. Evidence is listed with its ids so every claim in a deliverable can
 * be traced, and so the model can see what it has already gathered rather than
 * re-fetching it.
 */

export interface LoopPromptInput {
  task: string;
  classification: DataClassification;
  /** Source document attached to this run, if any. */
  sourceArtifact?: { id: string; filename: string; extractionVersion: string };
  /**
   * A caveat about the source the model must honour — for example that only
   * some pages of a long PDF were rendered for visual analysis.
   */
  sourceLimitation?: string;
  evidence: EvidenceItem[];
  turnsRemaining: number;
  toolCallsRemaining: number;
  /** True when budgets are spent and only the terminal tool remains. */
  mustFinish: boolean;
}

const RULES = [
  "You are an on-premise industrial workbench assistant. You work on documents and data held inside the organisation; nothing you do reaches the public internet.",
  "Work by calling tools. After each result, decide the smallest next action that closes a real gap, then finish by calling final.answer.",
  "Ground every factual claim in evidence you actually retrieved. Never invent measurements, dates, approvals, or citation ids. If the evidence does not settle something, say so in `unresolved` rather than guessing.",
  "Do not repeat a tool call that already succeeded with the same arguments; its result is already in this conversation. If a call failed, read the error and either repair the arguments or choose a different tool.",
  "Read the source document before analysing it, and search the knowledge base before claiming the organisation has no guidance on something.",
  "Produce a document only when the user asked for one. When you do, put the real figures into it rather than describing them.",
  "When a document tool asks for citationIds, use the evidence ids exactly as they appear in the evidence ledger below.",
  "Write the final answer for the person who asked: give the result and the figures behind it. The tool calls you made are shown to them separately, so do not narrate your process or paste code you ran.",
];

export function loopSystemPrompt(input: LoopPromptInput): string {
  const sections = [RULES.join("\n\n")];

  if (input.mustFinish) {
    sections.push(
      "Your remaining budget is spent. Call final.answer now with the best answer the gathered evidence supports, and list what remains unresolved.",
    );
  }

  sections.push(
    JSON.stringify({
      task: input.task,
      dataClassification: input.classification,
      sourceArtifact: input.sourceArtifact ?? null,
      sourceLimitation: input.sourceLimitation ?? null,
      budgets: {
        turnsRemaining: input.turnsRemaining,
        toolCallsRemaining: input.toolCallsRemaining,
      },
      evidenceLedger: input.evidence.map((item) => ({
        id: item.id,
        sourceRef: item.sourceRef,
        title: item.title,
        summary: item.summary.slice(0, 400),
      })),
    }),
  );

  return sections.join("\n\n");
}

/**
 * The opening user message.
 *
 * Kept separate from the system prompt so the transcript reads as a real
 * exchange, which is the shape tool-calling models are trained on.
 */
export function loopOpeningMessage(input: {
  task: string;
  sourceFilename?: string;
  limitation?: string;
}): string {
  const attachment = input.sourceFilename
    ? `\n\nA document is attached to this run: ${input.sourceFilename}. Read it with artifact.read before answering.`
    : "";
  const limitation = input.limitation ? `\n\nInput limitation: ${input.limitation}` : "";
  return `${input.task}${attachment}${limitation}`;
}

/**
 * Earlier turns of the chat, as messages the model can read directly.
 *
 * A tool-calling model trusts its own transcript over a summary in the system
 * prompt, so history is replayed as conversation instead of described.
 */
export function priorTurnMessages(history: ConversationTurn[]): Array<
  { role: "user"; content: string } | { role: "assistant"; content: string }
> {
  return history.flatMap((turn) => [
    { role: "user" as const, content: turn.task },
    { role: "assistant" as const, content: turn.answer },
  ]);
}
