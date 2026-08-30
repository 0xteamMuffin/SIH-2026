import { z } from "zod";

export const KNOWLEDGE_JOB_REQUESTED_TOPIC = "knowledge.job.requested";

const knowledgeJobRequestedSchema = z.object({ jobId: z.string().uuid() }).strict();

export type KnowledgeJobRequestedMessage = z.infer<typeof knowledgeJobRequestedSchema>;

export function parseKnowledgeJobRequested(value: unknown): KnowledgeJobRequestedMessage {
  return knowledgeJobRequestedSchema.parse(value);
}

export function decodeKnowledgeJobRequested(content: Buffer): KnowledgeJobRequestedMessage {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("Knowledge job message must contain valid JSON");
  }
  return parseKnowledgeJobRequested(value);
}
