import type { DataClassification } from "@prisma/client";
import { z } from "zod";

import { AppError } from "../../lib/errors.js";
import { RunWaitingForApproval } from "./agent-approval.service.js";
import { logger } from "../../lib/logger.js";
import type { ChatMessage, ContentPart, ModelToolCall, ToolDefinition } from "../../infrastructure/models/model-provider.js";
import type { AgentToolName } from "./agent-tool-registry.js";
import { isAgentToolName, validateToolInput } from "./agent-tool-registry.js";
import { toolDefinitions } from "./agent-tool-definitions.js";
import { appendTranscript, assistantMessage, loadTranscript, toolFailureMessage, toolResultMessage } from "./agent-transcript.js";
import type { ToolResult } from "./agent.types.js";

/**
 * The agentic loop.
 *
 * The model chooses what to do next: it is given the tools, and it calls them
 * until it calls `final.answer`. Nothing here decides the order of work, which
 * is the whole difference from a fixed pipeline — the agent can read a
 * document, notice a gap, search for it, and revise.
 *
 * Two properties shape the implementation:
 *
 * - **It must survive suspension.** A high-risk tool pauses the run for human
 *   approval, possibly for hours, so the loop holds no state in memory. The
 *   transcript is persisted per message and rebuilt on every invocation, and a
 *   resumed run re-executes any tool call whose result was never recorded.
 * - **It must always terminate with something.** Exhausting a budget removes
 *   every tool except `final.answer` and forces it, so the user gets the best
 *   answer the evidence supports instead of a failure.
 */

export const FINAL_ANSWER_TOOL = "final.answer" satisfies AgentToolName;

/** Tools offered when the agent still has budget to work with. */
const WORKING_TOOLS: readonly AgentToolName[] = [
  "artifact.read",
  "artifact.inspectVisually",
  "knowledge.search",
  "sandbox.execute",
  "code.persistOutput",
  "deliverable.createApprovalNote",
  "deliverable.createPresentation",
  "deliverable.createSpreadsheet",
  FINAL_ANSWER_TOOL,
];

const finalAnswerSchema = z.object({
  answer: z.string().trim().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  unresolved: z.array(z.string()).optional(),
});

export type FinalAnswer = z.infer<typeof finalAnswerSchema>;

/** Executes one tool. Supplied by the service, which owns the side effects. */
export type ToolHandler = (input: unknown) => Promise<ToolResult>;
export type ToolDispatcher = Partial<Record<AgentToolName, ToolHandler>>;

export interface LoopBudget {
  maxTurns: number;
  maxToolCalls: number;
}

export interface AgentLoopInput {
  runId: string;
  classification: DataClassification;
  /** Rebuilds the system prompt each turn, so budgets stay current. */
  systemPrompt: (context: { turnsRemaining: number; toolCallsRemaining: number; mustFinish: boolean }) => string;
  /**
   * Sent once, when the transcript is empty. Content rather than a string so a
   * vision run can attach its rendered pages to the opening turn.
   */
  openingMessage: string | ContentPart[];
  /**
   * Earlier turns of the same chat, as real messages.
   *
   * Presented as conversation rather than described in the system prompt: a
   * tool-calling model reads its own transcript far more reliably than a
   * summary buried in instructions, and without this it reaches for a tool to
   * re-derive something it was already told.
   */
  priorTurns?: ChatMessage[];
  /** Tools this run may use, filtered from the working set. */
  availableTools?: readonly AgentToolName[];
  dispatch: ToolDispatcher;
  budget: LoopBudget;
  invoke: (input: { system: string; messages: ChatMessage[]; tools: ToolDefinition[]; toolChoice: "auto" | "required" }) => Promise<{
    text: string | null;
    toolCalls: ModelToolCall[];
    profileId: string;
  }>;
  signal: AbortSignal;
  /** Called after each completed iteration so the caller can checkpoint. */
  onIteration?: (iteration: number) => Promise<void>;
}

export interface AgentLoopOutcome {
  answer: FinalAnswer;
  /** Model profile that produced the final answer. */
  profileId: string;
  iterations: number;
  /** True when budgets forced the agent to stop rather than it choosing to. */
  exhausted: boolean;
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopOutcome> {
  const offered = (input.availableTools ?? WORKING_TOOLS).filter((name) => name in input.dispatch || name === FINAL_ANSWER_TOOL);
  const workingDefinitions = toolDefinitions(offered);
  const finalOnly = toolDefinitions([FINAL_ANSWER_TOOL]);

  // The opening turn is rebuilt each invocation rather than persisted. It is
  // fully derivable from the run, and a vision run attaches rendered page
  // images to it — bytes that must never be written to durable storage.
  const opening: ChatMessage = { role: "user", content: input.openingMessage };
  const persisted = await loadTranscript(input.runId);
  let transcript: ChatMessage[] = [...(input.priorTurns ?? []), opening, ...persisted];

  // Budgets count only what this run has spent, so replayed earlier turns of the
  // conversation do not arrive looking like exhausted budget.
  let iteration = countAssistantTurns(persisted);
  let toolCallsUsed = countToolResults(persisted);
  let mustFinish = false;
  let lastProfileId = "";

  // A resumed run may have an assistant turn whose tool results were never
  // written, because the run suspended for approval part-way through. Those are
  // replayed before asking the model for anything new; `executeRunTool` makes
  // the replay idempotent.
  const pending = pendingToolCalls(transcript);
  if (pending.length > 0) {
    const results = await executeToolCalls(input, pending);
    transcript.push(...results.messages);
    toolCallsUsed += results.executed;
    if (results.answer) {
      return { answer: results.answer, profileId: lastProfileId, iterations: iteration, exhausted: false };
    }
    if (results.budgetExhausted) mustFinish = true;
  }

  while (true) {
    input.signal.throwIfAborted();

    const turnsRemaining = Math.max(0, input.budget.maxTurns - iteration);
    const toolCallsRemaining = Math.max(0, input.budget.maxToolCalls - toolCallsUsed);
    // Forced on the *last* turn, not after it. Waiting for `turnsRemaining`
    // to hit zero would spend an extra model call beyond the budget just to
    // ask for the answer.
    if (turnsRemaining <= 1 || toolCallsRemaining === 0) mustFinish = true;

    const system = input.systemPrompt({ turnsRemaining, toolCallsRemaining, mustFinish });
    const response = await input.invoke({
      system,
      // A snapshot: the live array keeps growing as results are appended, and
      // handing that out would let a caller observe a conversation that had
      // moved on since the request.
      messages: [...transcript],
      tools: mustFinish ? finalOnly : workingDefinitions,
      // `required` is what stops a budget-exhausted run from replying in prose
      // and leaving the loop with nothing structured to return.
      toolChoice: mustFinish ? "required" : "auto",
    });
    lastProfileId = response.profileId;

    const assistant = assistantMessage(response.text, response.toolCalls);
    await appendTranscript(input.runId, iteration + 1, assistant);
    transcript.push(assistant);
    iteration += 1;

    if (response.toolCalls.length === 0) {
      // The model answered without calling the terminal tool. Prose is
      // accepted rather than discarded, but only once it has been asked.
      if (mustFinish || iteration >= input.budget.maxTurns) {
        return {
          answer: { answer: response.text ?? "No answer was produced.", confidence: "low" },
          profileId: lastProfileId,
          iterations: iteration,
          exhausted: true,
        };
      }
      const nudge: ChatMessage = {
        role: "user",
        content: "Call a tool to continue, or call final.answer if you are done.",
      };
      await appendTranscript(input.runId, iteration, nudge);
      transcript.push(nudge);
      await input.onIteration?.(iteration);
      continue;
    }

    const executed = await executeToolCalls(input, response.toolCalls);
    for (const message of executed.messages) {
      await appendTranscript(input.runId, iteration, message);
    }
    transcript.push(...executed.messages);
    toolCallsUsed += executed.executed;

    if (executed.answer) {
      return { answer: executed.answer, profileId: lastProfileId, iterations: iteration, exhausted: mustFinish };
    }
    if (executed.budgetExhausted) mustFinish = true;

    await input.onIteration?.(iteration);
  }
}

interface ExecutionOutcome {
  messages: ChatMessage[];
  executed: number;
  answer: FinalAnswer | null;
  budgetExhausted: boolean;
}

/**
 * Runs a batch of tool calls, turning every outcome into a message the model
 * can read.
 *
 * Failures are reported as tool results rather than thrown, so a bad argument
 * or an unavailable provider costs one turn instead of the whole run. The one
 * exception is a suspension for approval, which must propagate so the run can
 * pause and resume later.
 */
async function executeToolCalls(input: AgentLoopInput, calls: ModelToolCall[]): Promise<ExecutionOutcome> {
  const messages: ChatMessage[] = [];
  let executed = 0;
  let answer: FinalAnswer | null = null;
  let budgetExhausted = false;

  for (const call of calls) {
    if (answer) {
      // The agent already finished; anything batched alongside is moot.
      messages.push(toolFailureMessage(call.id, "Skipped: the run already finished."));
      continue;
    }

    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(call.argumentsJson || "{}");
    } catch {
      messages.push(toolFailureMessage(call.id, "Arguments were not valid JSON. Send a single JSON object."));
      continue;
    }

    if (call.name === FINAL_ANSWER_TOOL) {
      const parsed = finalAnswerSchema.safeParse(parsedArguments);
      if (!parsed.success) {
        messages.push(toolFailureMessage(call.id, `final.answer was rejected: ${describeIssues(parsed.error)}`));
        continue;
      }
      answer = parsed.data;
      messages.push(toolResultMessage(call.id, { ok: true, summary: "Answer accepted." }));
      continue;
    }

    if (!isAgentToolName(call.name)) {
      messages.push(toolFailureMessage(call.id, `Unknown tool '${call.name}'. Use only the tools provided.`));
      continue;
    }

    const handler = input.dispatch[call.name];
    if (!handler) {
      messages.push(toolFailureMessage(call.id, `Tool '${call.name}' is not available for this run.`));
      continue;
    }

    let validated: unknown;
    try {
      validated = validateToolInput(call.name, parsedArguments);
    } catch (error) {
      messages.push(toolFailureMessage(call.id, `Arguments rejected: ${describeUnknown(error)}`));
      continue;
    }

    try {
      const result = await handler(validated);
      executed += 1;
      messages.push(toolResultMessage(call.id, result));
    } catch (error) {
      // Approval suspension is control flow, not failure: let it out so the
      // run can pause with this tool call already recorded.
      if (isSuspension(error)) throw error;

      if (isBudgetExhausted(error)) {
        budgetExhausted = true;
        messages.push(toolFailureMessage(call.id, "The tool-call budget for this run is spent. Call final.answer now."));
        continue;
      }
      if (input.signal.aborted) throw error;

      logger.warn({ runId: input.runId, tool: call.name, reason: describeUnknown(error) }, "agent tool call failed");
      messages.push(toolFailureMessage(call.id, describeUnknown(error)));
    }
  }

  return { messages, executed, answer, budgetExhausted };
}

/** Tool calls from the final assistant turn that have no recorded result. */
function pendingToolCalls(transcript: ChatMessage[]): ModelToolCall[] {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (message?.role !== "assistant") continue;
    if (!message.toolCalls || message.toolCalls.length === 0) return [];

    const answered = new Set<string>();
    for (const later of transcript.slice(index + 1)) {
      if (later.role === "tool") answered.add(later.toolCallId);
    }
    return message.toolCalls.filter((call) => !answered.has(call.id));
  }
  return [];
}

function countAssistantTurns(transcript: ChatMessage[]): number {
  return transcript.filter((message) => message.role === "assistant").length;
}

function countToolResults(transcript: ChatMessage[]): number {
  return transcript.filter((message) => message.role === "tool").length;
}

function isSuspension(error: unknown): boolean {
  return error instanceof RunWaitingForApproval;
}

function isBudgetExhausted(error: unknown): boolean {
  return error instanceof AppError && error.code === "RUN_TOOL_CALL_LIMIT_EXCEEDED";
}

function describeIssues(error: z.ZodError): string {
  return error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function describeUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
