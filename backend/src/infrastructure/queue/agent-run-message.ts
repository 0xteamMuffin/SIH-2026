import { z } from "zod";

export const AGENT_RUN_REQUESTED_TOPIC = "agent.run.requested";

const agentRunRequestedSchema = z.object({ runId: z.string().uuid() }).strict();

export type AgentRunRequestedMessage = z.infer<typeof agentRunRequestedSchema>;

export function parseAgentRunRequested(value: unknown): AgentRunRequestedMessage {
  return agentRunRequestedSchema.parse(value);
}

export function decodeAgentRunRequested(content: Buffer): AgentRunRequestedMessage {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("Agent run message must contain valid JSON");
  }
  return parseAgentRunRequested(value);
}
