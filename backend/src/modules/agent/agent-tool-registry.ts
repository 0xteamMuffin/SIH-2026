import { ToolRiskLevel } from "@prisma/client";
import { z } from "zod";

const artifactReadInput = z.object({
  artifactId: z.string().uuid(),
  extractionVersion: z.string().min(1).max(64),
}).strict();

const knowledgeSearchInput = z.object({ query: z.string().trim().min(1).max(20_000) }).strict();

const approvalNoteInput = z.object({ format: z.literal("docx") }).strict();
const presentationInput = z.object({ format: z.literal("pptx"), evidenceIds: z.array(z.string().uuid()).min(1).max(60) }).strict();
const spreadsheetInput = z.object({ format: z.literal("xlsx"), evidenceIds: z.array(z.string().uuid()).min(1).max(200) }).strict();
const codeOutputInput = z.object({
  language: z.enum(["javascript", "python"]),
  code: z.string().min(1).max(100_000),
  explanation: z.string().min(1).max(20_000),
}).strict();

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
const knowledgeSearchOutput = z.union([toolFailure, z.object({
  ok: z.literal(true),
  summary: z.string(),
  data: z.object({
    citations: z.array(z.object({
      artifactId: z.string().uuid(),
      title: z.string().min(1).max(500),
      text: z.string().min(1).max(2_000),
      sourceRef: z.string().min(1).max(1_000),
      score: z.number().finite(),
    }).strict()).max(8),
  }).strict(),
}).strict()]);
const approvalNoteOutput = z.union([toolFailure, z.object({
  ok: z.literal(true),
  summary: z.string(),
  data: z.object({ artifactId: z.string().uuid() }).passthrough(),
}).passthrough()]);
const artifactOutput = approvalNoteOutput;
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
  "knowledge.search": { input: knowledgeSearchInput, output: knowledgeSearchOutput, risk: ToolRiskLevel.LOW, requiresApproval: false },
  "deliverable.createApprovalNote": { input: approvalNoteInput, output: approvalNoteOutput, risk: ToolRiskLevel.MEDIUM, requiresApproval: false },
  "deliverable.createPresentation": { input: presentationInput, output: artifactOutput, risk: ToolRiskLevel.MEDIUM, requiresApproval: false },
  "deliverable.createSpreadsheet": { input: spreadsheetInput, output: artifactOutput, risk: ToolRiskLevel.MEDIUM, requiresApproval: false },
  "code.persistOutput": { input: codeOutputInput, output: artifactOutput, risk: ToolRiskLevel.LOW, requiresApproval: false },
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
