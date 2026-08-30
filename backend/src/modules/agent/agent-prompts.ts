import type { TaskCapability } from "../../infrastructure/models/model-registry.js";

const evidenceSystemPrompt = "You are an on-premise industrial workbench assistant. Produce concise factual findings only from supplied source text. State uncertainty when source material is missing or unreadable. Never invent measurements, approvals, or citations.";

export function modelMessages(task: string, capability: TaskCapability, sourceText?: string) {
  if (capability === "general" && sourceText === undefined) {
    return {
      system: "You are an on-premise industrial workbench assistant. Answer the user's task directly and concisely. Do not claim access to documents, evidence, measurements, approvals, or citations that were not provided.",
      prompt: `Task instructions:\n${task}`,
    };
  }
  return {
    system: evidenceSystemPrompt,
    prompt: `Task: ${task}\n\nSource material:\n${sourceText ?? "No source artifact was provided. State that the requested document analysis cannot be completed without source evidence."}`,
  };
}
