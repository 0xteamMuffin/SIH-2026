import { ArtifactKind, DataClassification, EvidenceKind } from "@prisma/client";

import { AppError } from "../../lib/errors.js";
import { runCode } from "../../infrastructure/sandbox/sandbox-client.js";
import { createArtifact } from "../artifacts/artifacts.service.js";
import { extractArtifact } from "../artifacts/artifact-extraction.service.js";
import { generatePptx, PPTX_MIME_TYPE } from "../deliverables/pptx-generator.js";
import { generateXlsx, XLSX_MIME_TYPE } from "../deliverables/xlsx-generator.js";
import { approvalNoteDocx } from "./approval-note.js";
import { deliverableCitations } from "./agent-deliverables.js";
import { mergeDocx, mergePptx, mergeXlsx } from "./deliverable-authoring.js";
import type { ToolDispatcher } from "./agent-loop.js";
import { searchAgentKnowledge } from "./agent-knowledge-search.js";
import { validateToolInput } from "./agent-tool-registry.js";
import { sandboxToolResult, type EvidenceItem, type ToolResult } from "./agent.types.js";

/**
 * The tools the agent can actually call.
 *
 * Every side effect lives here, so the loop stays pure orchestration. Each
 * handler is wrapped by `executeRunTool`, which supplies idempotency, the
 * tool-call budget, and the approval gate — so a resumed run replays a call
 * without repeating its effect.
 */

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface ToolContext {
  run: { id: string; workspaceId: string; requestedBy: string; dataClassification: DataClassification };
  /** The user's request, used as a generated document's title. */
  task: string;
  /** Name of the run's source document, for evidence titles. */
  sourceFilename?: string;
  extractionVersion: string;
  signal: AbortSignal;
  /** Accumulated evidence, appended to as tools gather it. */
  evidence: EvidenceItem[];
  /** Runs a tool with idempotency, budget, and approval handling. */
  execute: (name: string, input: object, work: (persistedInput: object) => Promise<ToolResult>) => Promise<ToolResult>;
  saveEvidence: (
    kind: EvidenceKind,
    artifactId: string | undefined,
    sourceRef: string,
    title: string,
    summary: string,
    facts: string[],
  ) => Promise<EvidenceItem>;
  /** Records a produced artifact so the run result can surface the latest. */
  onArtifact: (artifact: { id: string; filename: string }) => void;
  /**
   * Renders the source document for visual inspection and routes later turns
   * to a vision-capable model. The agent states the need; which profile serves
   * it stays a decision for the router.
   */
  requestVisualInspection: (reason: string) => Promise<{ pages: number }>;
}

export function createToolDispatcher(context: ToolContext): ToolDispatcher {
  return {
    "artifact.read": (input) => readArtifact(context, input),
    "artifact.inspectVisually": (input) => inspectVisually(context, input),
    "knowledge.search": (input) => searchKnowledge(context, input),
    "sandbox.execute": (input) => executeSandbox(context, input),
    "code.persistOutput": (input) => persistCode(context, input),
    "deliverable.createApprovalNote": (input) => createDeliverable(context, "docx", input),
    "deliverable.createPresentation": (input) => createDeliverable(context, "pptx", input),
    "deliverable.createSpreadsheet": (input) => createDeliverable(context, "xlsx", input),
  };
}

async function readArtifact(context: ToolContext, input: unknown): Promise<ToolResult> {
  const args = validateToolInput("artifact.read", input);

  return context.execute("artifact.read", args, async () => {
    const extraction = await extractArtifact(args.artifactId, context.signal);
    const text = extraction.text;

    await context.saveEvidence(
      EvidenceKind.SOURCE,
      args.artifactId,
      `artifact:${args.artifactId}`,
      context.sourceFilename ?? "Source document",
      text.slice(0, 800),
      splitFacts(text),
    );

    return {
      ok: true,
      summary: `Read ${text.length} characters from the source document`,
      data: { characters: text.length, text },
    };
  });
}

/**
 * Puts the source document in front of the model as images.
 *
 * The pages are attached to the next turn rather than returned here, because
 * a tool result carries text and what the agent needs is to see the page.
 */
async function inspectVisually(context: ToolContext, input: unknown): Promise<ToolResult> {
  const args = validateToolInput("artifact.inspectVisually", input);

  return context.execute("artifact.inspectVisually", args, async () => {
    const { pages } = await context.requestVisualInspection(args.reason);
    return {
      ok: true,
      summary: `Prepared ${pages} page image(s) of the source document; they are attached to your next turn`,
      data: { pages },
    };
  });
}

async function searchKnowledge(context: ToolContext, input: unknown): Promise<ToolResult> {
  const args = validateToolInput("knowledge.search", input);

  return context.execute("knowledge.search", args, async () => {
    const citations = await searchAgentKnowledge({
      workspaceId: context.run.workspaceId,
      classification: context.run.dataClassification,
      query: args.query,
      signal: context.signal,
    });

    for (const citation of citations) {
      await context.saveEvidence(
        EvidenceKind.SOURCE,
        citation.artifactId,
        citation.sourceRef,
        citation.title,
        citation.text.slice(0, 800),
        [citation.text],
      );
    }

    return {
      ok: true,
      summary: citations.length > 0
        ? `Retrieved ${citations.length} knowledge citation(s)`
        : "No relevant knowledge citations found",
      data: { citations },
    };
  });
}

async function executeSandbox(context: ToolContext, input: unknown): Promise<ToolResult> {
  const args = validateToolInput("sandbox.execute", input);

  // `execute` pauses here for approval on first call; the resumed run arrives
  // with the same arguments and therefore the same idempotency key.
  return context.execute("sandbox.execute", args, async (persisted) => {
    const approved = validateToolInput("sandbox.execute", persisted);
    return sandboxToolResult(await runCode(approved.code, approved.language, context.signal));
  });
}

async function persistCode(context: ToolContext, input: unknown): Promise<ToolResult> {
  const args = validateToolInput("code.persistOutput", input);

  return context.execute("code.persistOutput", args, async () => {
    context.signal.throwIfAborted();
    const extension = args.language === "python" ? "py" : "js";
    const artifact = await createArtifact({
      workspaceId: context.run.workspaceId,
      userId: context.run.requestedBy,
      filename: `generated-code-${context.run.id}.${extension}`,
      mimeType: args.language === "python" ? "text/x-python" : "text/javascript",
      kind: ArtifactKind.CODE_OUTPUT,
      classification: context.run.dataClassification,
      bytes: Buffer.from(args.code, "utf8"),
      idempotencyKey: `run-${context.run.id}-code-output`,
    });

    context.onArtifact({ id: artifact.id, filename: `generated-code-${context.run.id}.${extension}` });
    return { ok: true, summary: "Saved the generated code", data: { artifactId: artifact.id } };
  });
}

type DeliverableKind = "docx" | "pptx" | "xlsx";

const DELIVERABLE_TOOLS = {
  docx: "deliverable.createApprovalNote",
  pptx: "deliverable.createPresentation",
  xlsx: "deliverable.createSpreadsheet",
} as const;

const DELIVERABLE_ARTIFACT_KINDS = {
  docx: ArtifactKind.GENERATED_DOCX,
  pptx: ArtifactKind.GENERATED_PPTX,
  xlsx: ArtifactKind.GENERATED_XLSX,
} as const;

/**
 * Renders a document the model authored.
 *
 * The model supplies the body and the evidence ids to cite; citations
 * themselves are resolved here from evidence the run actually gathered, so a
 * fabricated source cannot reach a generated file.
 */
async function createDeliverable(
  context: ToolContext,
  kind: DeliverableKind,
  input: unknown,
): Promise<ToolResult> {
  const toolName = DELIVERABLE_TOOLS[kind];
  const args = validateToolInput(toolName, input);

  return context.execute(toolName, args, async () => {
    const selected = selectEvidence(context.evidence, args.evidenceIds);
    if (selected.length === 0) {
      throw new AppError(
        422,
        "None of the supplied evidenceIds match evidence gathered in this run. Read a document or search the knowledge base first, then cite the ids from the evidence ledger.",
        "EVIDENCE_NOT_FOUND",
      );
    }

    const citations = deliverableCitations(selected);
    // The model cites using the evidence ids it was shown, which are UUIDs;
    // the document format uses short handles. Translating here means the
    // agent never has to keep two id systems straight.
    const content = normaliseCitationIds(args.content, selected);
    const title = context.task;
    context.signal.throwIfAborted();

    const output = kind === "pptx"
      ? {
          bytes: await generatePptx(mergePptx(title, content as never, citations)),
          filename: `presentation-${context.run.id}.pptx`,
          mimeType: PPTX_MIME_TYPE,
          summary: "Generated a cited PowerPoint deck",
        }
      : kind === "xlsx"
        ? {
            bytes: await generateXlsx(mergeXlsx(title, content as never, citations)),
            filename: `workbook-${context.run.id}.xlsx`,
            mimeType: XLSX_MIME_TYPE,
            summary: "Generated a cited Excel workbook",
          }
        : {
            bytes: Buffer.from(await approvalNoteDocx(mergeDocx(title, content as never, citations))),
            filename: `approval-note-${context.run.id}.docx`,
            mimeType: DOCX_MIME_TYPE,
            summary: "Generated a cited approval note",
          };

    context.signal.throwIfAborted();
    const artifact = await createArtifact({
      workspaceId: context.run.workspaceId,
      userId: context.run.requestedBy,
      filename: output.filename,
      mimeType: output.mimeType,
      kind: DELIVERABLE_ARTIFACT_KINDS[kind],
      classification: context.run.dataClassification,
      bytes: output.bytes,
      idempotencyKey: `run-${context.run.id}-${kind}`,
    });

    context.onArtifact({ id: artifact.id, filename: output.filename });
    return { ok: true, summary: output.summary, data: { artifactId: artifact.id } };
  });
}

/**
 * Rewrites citation handles into the form the document format expects.
 *
 * Accepts either an evidence UUID or an already-short handle, mapping each to
 * its position in the resolved citation list. Anything unrecognised is
 * dropped, which leaves the schema to reject a finding that cites nothing —
 * inventing a citation to fill the gap would defeat the point of citing.
 */
function normaliseCitationIds<T>(content: T, selected: EvidenceItem[]): T {
  const handleByEvidenceId = new Map(selected.map((item, index) => [item.id, `S${index + 1}`]));
  const validHandles = new Set(handleByEvidenceId.values());

  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== "object") return value;

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (key === "citationIds" && Array.isArray(entry)) {
        const mapped = entry
          .map((id) => (typeof id === "string" ? handleByEvidenceId.get(id) ?? (validHandles.has(id) ? id : null) : null))
          .filter((id): id is string => id !== null);
        result[key] = [...new Set(mapped)];
        continue;
      }
      result[key] = rewrite(entry);
    }
    return result;
  };

  return rewrite(content) as T;
}

/** Evidence in the order the model cited it, ignoring ids it invented. */
function selectEvidence(evidence: EvidenceItem[], evidenceIds: string[]): EvidenceItem[] {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const selected: EvidenceItem[] = [];

  for (const id of evidenceIds) {
    const item = byId.get(id);
    if (item && !selected.includes(item)) selected.push(item);
  }
  return selected;
}

/** First few sentences, used as the evidence record's discrete facts. */
function splitFacts(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 8);
}
