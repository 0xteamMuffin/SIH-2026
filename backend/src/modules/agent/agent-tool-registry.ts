import { ToolRiskLevel } from "@prisma/client";
import { z } from "zod";

const artifactReadInput = z.object({
  artifactId: z.string().uuid(),
  extractionVersion: z.string().min(1).max(64),
}).strict();

const approvalNoteInput = z.object({ format: z.literal("docx") }).strict();

const sandboxExecuteInput = z.object({
  language: z.enum(["javascript", "python"]),
  code: z.string().max(100_000),
}).strict();

const toolFailure = z.object({
  ok: z.literal(false),
  summary: z.string(),
  errorCode: z.string().optional(),
  data: z.record(z.unknown()).optional(),
}).passthrough();
const artifactReadOutput = z.union([toolFailure, z.object({
  ok: z.literal(true),
  summary: z.string(),
  data: z.object({ characters: z.number().int().nonnegative(), text: z.string() }).passthrough(),
}).passthrough()]);
const approvalNoteOutput = z.union([toolFailure, z.object({
  ok: z.literal(true),
  summary: z.string(),
  data: z.object({ artifactId: z.string().uuid() }).passthrough(),
}).passthrough()]);
const sandboxExecuteOutput = z.union([toolFailure, z.object({
  ok: z.literal(true),
  summary: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  timedOut: z.boolean().optional(),
  outputTruncated: z.boolean().optional(),
}).passthrough()]);

export const agentToolRegistry = {
  "artifact.read": { input: artifactReadInput, output: artifactReadOutput, risk: ToolRiskLevel.LOW, requiresApproval: false },
  "deliverable.createApprovalNote": { input: approvalNoteInput, output: approvalNoteOutput, risk: ToolRiskLevel.MEDIUM, requiresApproval: false },
  "sandbox.execute": { input: sandboxExecuteInput, output: sandboxExecuteOutput, risk: ToolRiskLevel.HIGH, requiresApproval: true },
} as const;

export type AgentToolName = keyof typeof agentToolRegistry;
export type AgentToolInput<Name extends AgentToolName> = z.infer<(typeof agentToolRegistry)[Name]["input"]>;

export function isAgentToolName(name: string): name is AgentToolName {
  return Object.hasOwn(agentToolRegistry, name);
}

export function registeredTool<Name extends AgentToolName>(name: Name) {
  return agentToolRegistry[name];
}

export function toolRequiresApproval(name: AgentToolName) {
  return agentToolRegistry[name].risk === ToolRiskLevel.HIGH;
}

export function validateToolInput<Name extends AgentToolName>(name: Name, input: unknown): AgentToolInput<Name> {
  return agentToolRegistry[name].input.parse(input) as AgentToolInput<Name>;
}

export function validateToolOutput<Name extends AgentToolName>(name: Name, output: unknown) {
  return agentToolRegistry[name].output.parse(output);
}
