import { ToolRiskLevel } from "@prisma/client";
import { z } from "zod";
import { authoredDocxSchema, authoredPptxSchema, authoredXlsxSchema } from "../deliverables/deliverable-schemas.js";

const artifactReadInput = z.object({
  artifactId: z.string().uuid().describe("UUID of the artifact to read."),
  extractionVersion: z.string().min(1).max(64).describe("Extraction schema version reported for the artifact."),
}).strict();

const artifactInspectInput = z.object({
  reason: z.string().trim().min(1).max(500).describe("What the extracted text is missing or getting wrong that looking at the document would settle."),
}).strict();

const knowledgeSearchInput = z.object({
  query: z.string().trim().min(1).max(20_000).describe("Natural-language search query."),
}).strict();

// `content` carries the document the model wrote. Citations are not part of
// it: they are resolved server-side from the evidence referenced by
// `evidenceIds`, so a fabricated source cannot reach a generated document.
const approvalNoteInput = z.object({
  format: z.literal("docx").describe("Output format. Always 'docx'."),
  evidenceIds: z.array(z.string().uuid()).min(1).max(200).describe("Evidence records to cite, from earlier tool results in this run."),
  content: authoredDocxSchema.describe("The approval note body: purpose, findings with severities, recommendation, and any conditions."),
}).strict();
const presentationInput = z.object({
  format: z.literal("pptx").describe("Output format. Always 'pptx'."),
  evidenceIds: z.array(z.string().uuid()).min(1).max(60).describe("Evidence records to cite, from earlier tool results in this run."),
  content: authoredPptxSchema.describe("The deck body: one section per slide topic, each with findings and their severities."),
}).strict();
const spreadsheetInput = z.object({
  format: z.literal("xlsx").describe("Output format. Always 'xlsx'."),
  evidenceIds: z.array(z.string().uuid()).min(1).max(200).describe("Evidence records to cite, from earlier tool results in this run."),
  content: authoredXlsxSchema.describe("The workbook body: data tables with typed columns, and calculations whose formulas reference those tables."),
}).strict();
const codeOutputInput = z.object({
  language: z.enum(["javascript", "python"]).describe("Language the code is written in."),
  code: z.string().min(1).max(100_000).describe("Complete source code to save."),
  explanation: z.string().min(1).max(20_000).describe("Plain-language explanation of what the code does."),
}).strict();

/**
 * How the agent declares it is finished.
 *
 * Terminating through a tool rather than by trailing off in prose makes "done"
 * explicit and structured: the loop never has to guess whether a reply was an
 * answer or a step towards one, and the final answer arrives in a known shape.
 */
const finalAnswerInput = z.object({
  answer: z.string().trim().min(1).max(20_000).describe(
    "The complete answer to the user's question, as Markdown prose. State the findings and figures. Do not restate the code you ran, the tools you called, or the steps you took — the user sees those separately.",
  ),
  confidence: z.enum(["high", "medium", "low"]).describe("How well the gathered evidence supports this answer."),
  unresolved: z.array(z.string().max(500)).max(10).optional()
    .describe("Anything the evidence could not settle. State these rather than guessing."),
}).strict();

const sandboxExecuteInput = z.object({
  language: z.enum(["javascript", "python"]).describe("Runtime to execute the program with."),
  code: z.string().max(100_000).describe("Self-contained program. It has no network access and no filesystem beyond a temporary directory."),
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
const artifactInspectOutput = z.union([toolFailure, z.object({
  ok: z.literal(true),
  summary: z.string(),
  data: z.object({ pages: z.number().int().nonnegative() }).passthrough(),
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
const finalAnswerOutput = z.object({ ok: z.literal(true), summary: z.string() }).passthrough();
const sandboxExecuteOutput = z.union([toolFailure, z.object({
  ok: z.literal(true),
  summary: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  timedOut: z.boolean().optional(),
  outputTruncated: z.boolean().optional(),
}).passthrough()]);

/**
 * Every tool the agent may call.
 *
 * `description` is what the model actually reads when deciding between tools,
 * so it is kept beside the schema rather than in a separate table where the
 * two could drift. Descriptions state when to use a tool and what it returns,
 * because that is what smaller local models need in order to route correctly.
 */
export const agentToolRegistry = {
  "artifact.read": {
    description:
      "Read the extracted text of an uploaded document by artifact id. Use this to inspect a source document before analysing it. Returns the document's text and its character count.",
    input: artifactReadInput,
    output: artifactReadOutput,
    risk: ToolRiskLevel.LOW,
    requiresApproval: false,
  },
  "artifact.inspectVisually": {
    description:
      "Look at the source document as an image instead of reading its text. Use this when the extracted text is empty, garbled, or does not describe what the document actually shows — a scan, a photograph, a stamped form, or an engineering drawing. The pages are put in front of you on the next turn.",
    input: artifactInspectInput,
    output: artifactInspectOutput,
    risk: ToolRiskLevel.LOW,
    requiresApproval: false,
  },
  "knowledge.search": {
    description:
      "Search the organisation's indexed manuals, SOPs and past correspondence for passages relevant to a query. Use this to ground an answer in internal sources. Returns up to eight cited passages with their source references.",
    input: knowledgeSearchInput,
    output: knowledgeSearchOutput,
    risk: ToolRiskLevel.LOW,
    requiresApproval: false,
  },
  "deliverable.createApprovalNote": {
    description:
      "Generate a Word (.docx) approval note. You supply the purpose, the findings with the severity each one warrants, the recommendation, and any conditions. Returns the id of the stored document.",
    input: approvalNoteInput,
    output: approvalNoteOutput,
    risk: ToolRiskLevel.MEDIUM,
    requiresApproval: false,
  },
  "deliverable.createPresentation": {
    description:
      "Generate a PowerPoint (.pptx) deck from cited evidence. Use this when the user asks for slides or a presentation. Returns the id of the stored document.",
    input: presentationInput,
    output: artifactOutput,
    risk: ToolRiskLevel.MEDIUM,
    requiresApproval: false,
  },
  "deliverable.createSpreadsheet": {
    description:
      "Generate an Excel (.xlsx) workbook. You supply the data tables and the formulas that operate on them, so put the actual figures from the source material into rows rather than listing the sources. Returns the id of the stored document.",
    input: spreadsheetInput,
    output: artifactOutput,
    risk: ToolRiskLevel.MEDIUM,
    requiresApproval: false,
  },
  "code.persistOutput": {
    description:
      "Save generated source code as a downloadable file for the user, together with an explanation of what it does. Use this once the code is final. Does not run the code.",
    input: codeOutputInput,
    output: artifactOutput,
    risk: ToolRiskLevel.LOW,
    requiresApproval: false,
  },
  "final.answer": {
    description:
      "Finish the task and return the answer to the user. Call this when you have gathered enough evidence, or when further tool calls cannot resolve the question. This ends the run, so call it exactly once and only when you are done.",
    input: finalAnswerInput,
    output: finalAnswerOutput,
    risk: ToolRiskLevel.LOW,
    requiresApproval: false,
  },
  "sandbox.execute": {
    description:
      "Run a short Python or JavaScript program in an isolated sandbox with no network access, and return its stdout, stderr and exit code. Use this to verify code or perform a calculation. Requires human approval before it runs.",
    input: sandboxExecuteInput,
    output: sandboxExecuteOutput,
    risk: ToolRiskLevel.HIGH,
    requiresApproval: true,
  },
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
