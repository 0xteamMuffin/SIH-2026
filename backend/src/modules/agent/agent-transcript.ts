import { prisma } from "../../lib/prisma.js";
import type { ChatMessage, ModelToolCall } from "../../infrastructure/models/model-provider.js";

/**
 * The agent's conversation with the model, persisted per run.
 *
 * A run is queue-driven and can suspend indefinitely waiting on a human to
 * approve a tool, so the loop cannot hold its transcript in memory. Every turn
 * is written to `run_messages` and the transcript is rebuilt from there on each
 * invocation — which is what lets a resumed run continue mid-thought instead of
 * starting over.
 *
 * Transcript rows are tagged so they can be told apart from the progress
 * messages the UI also reads out of the same table.
 */

const TRANSCRIPT_MARKER = "transcript";

interface TranscriptEnvelope {
  kind: typeof TRANSCRIPT_MARKER;
  message: ChatMessage;
}

function isEnvelope(content: unknown): content is TranscriptEnvelope {
  return (
    typeof content === "object" &&
    content !== null &&
    (content as { kind?: unknown }).kind === TRANSCRIPT_MARKER &&
    typeof (content as { message?: unknown }).message === "object"
  );
}

/** Appends one model-facing message to the run's transcript. */
export async function appendTranscript(
  runId: string,
  turn: number,
  message: ChatMessage,
): Promise<void> {
  const envelope: TranscriptEnvelope = { kind: TRANSCRIPT_MARKER, message };
  await prisma.runMessage.create({
    data: { runId, turn, role: message.role, content: envelope as unknown as object },
  });
}

/**
 * Rebuilds the transcript in the order it was written.
 *
 * Ordered by creation rather than turn: several messages share a turn, and the
 * model requires an assistant tool-call message to be immediately followed by
 * its results.
 */
export async function loadTranscript(runId: string): Promise<ChatMessage[]> {
  const rows = await prisma.runMessage.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
    select: { content: true },
  });

  const messages: ChatMessage[] = [];
  for (const row of rows) {
    // Prisma types `content` as loose JSON, so the guard both filters progress
    // rows out and narrows the value.
    const content: unknown = row.content;
    if (isEnvelope(content)) messages.push(content.message);
  }
  return messages;
}

/**
 * A tool result, shaped for the model.
 *
 * Results are sent as JSON text because that is what the OpenAI-compatible
 * tool protocol accepts, and because a model reading a structured result
 * repairs its next call far more reliably than one reading prose.
 */
export function toolResultMessage(toolCallId: string, result: unknown): ChatMessage {
  return { role: "tool", toolCallId, content: safeStringify(result) };
}

/**
 * Reports a rejected tool call back to the model as a result rather than an
 * error, so the loop can continue and the model can choose differently.
 */
export function toolFailureMessage(toolCallId: string, reason: string): ChatMessage {
  return toolResultMessage(toolCallId, { ok: false, error: reason });
}

export function assistantMessage(text: string | null, toolCalls: ModelToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ ok: false, error: "Tool result could not be serialised" });
  }
}
