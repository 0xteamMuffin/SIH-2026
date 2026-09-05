import { z } from "zod";
import {
  authoredDocxSchema,
  authoredPptxSchema,
  authoredXlsxSchema,
  type AuthoredDocx,
  type AuthoredPptx,
  type AuthoredXlsx,
  type DocxDeliverableInput,
  type PptxDeliverableInput,
  type XlsxDeliverableInput,
} from "../deliverables/deliverable-schemas.js";
import type { DeliverableCitation, DeliverableFormat } from "./agent-deliverables.js";

/**
 * Turns a run's analysis into a deliverable the model actually wrote.
 *
 * The model supplies the body — sections, findings with real severities,
 * tables, calculations. It never supplies the citation list: those are
 * resolved from evidence the run genuinely gathered, so a fabricated source
 * cannot reach a document. The model refers to citations by id, and the
 * deliverable schemas reject any id that does not resolve.
 */

const AUTHORING_SYSTEM_PROMPT =
  "You are an on-premise industrial documentation assistant. You write structured deliverables from supplied evidence. " +
  "Return exactly one JSON object matching the requested shape. Do not use Markdown fences and do not add fields. " +
  "Ground every statement in the supplied source material. Never invent measurements, dates, approvals, or citation ids. " +
  "Cite only the citation ids you are given.";

/** Per-format guidance and the exact JSON shape expected back. */
const FORMAT_GUIDANCE: Record<DeliverableFormat, string> = {
  docx:
    'Produce an approval note. Shape:\n' +
    '{"purpose": string, "background": string (optional), "findings": [{"title": string, "detail": string, "severity": "critical"|"high"|"medium"|"low"|"info", "citationIds": [string, ...]}], "recommendation": string, "conditions": [string, ...] (optional)}\n' +
    "Assign each finding the severity the evidence supports; do not mark everything informational. " +
    "The recommendation must state clearly what is being approved and any limits on it.",
  pptx:
    'Produce a slide deck. Shape:\n' +
    '{"subtitle": string (optional), "sections": [{"title": string, "summary": string, "findings": [{"title": string, "detail": string, "severity": "critical"|"high"|"medium"|"low"|"info", "citationIds": [string, ...]}]}]}\n' +
    "Use one section per slide topic, at most six findings per section.",
  xlsx:
    'Produce a workbook. Shape:\n' +
    '{"sections": [{"title": string, "summary": string, "findings": [{"title": string, "detail": string, "severity": ..., "citationIds": [...]}]}], ' +
    '"assumptions": [string, ...], ' +
    '"tables": [{"name": "IdentifierNoSpaces", "title": string, "columns": [{"header": string, "dataType": "text"|"number"|"integer"|"percentage"|"boolean", "unit": string (optional)}], "rows": [[cell, ...], ...]}], ' +
    '"calculations": [{"label": string, "formula": string, "unit": string, "cachedResult": number (optional), "assumptions": [string, ...], "citationIds": [string, ...]}]}\n' +
    "Put the actual data from the source material into tables, one row per record, with cell values matching each column's dataType. " +
    "Write formulas that reference the data (for example AVERAGE(B2:B8)), without a leading '=', using only common spreadsheet functions. " +
    "Do not emit a table that merely lists the sources.",
};

const AUTHORED_SCHEMAS = {
  docx: authoredDocxSchema,
  pptx: authoredPptxSchema,
  xlsx: authoredXlsxSchema,
} as const;

export type AuthoredContent = { docx: AuthoredDocx; pptx: AuthoredPptx; xlsx: AuthoredXlsx };

export function authoringMessages(
  format: DeliverableFormat,
  task: string,
  analysis: string,
  sourceText: string | undefined,
  citations: DeliverableCitation[],
) {
  const available = citations
    .map((citation) => `${citation.id}: ${citation.title} (${citation.source})`)
    .join("\n");

  return {
    system: AUTHORING_SYSTEM_PROMPT,
    prompt: [
      `Task:\n${task}`,
      `Analysis so far:\n${analysis}`,
      sourceText ? `Source material:\n${sourceText}` : undefined,
      `Citation ids you may reference:\n${available}`,
      FORMAT_GUIDANCE[format],
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function authoringRepairMessages(
  format: DeliverableFormat,
  task: string,
  analysis: string,
  sourceText: string | undefined,
  citations: DeliverableCitation[],
  invalidOutput: string,
  reason: string,
  truncated = false,
) {
  const base = authoringMessages(format, task, analysis, sourceText, citations);

  // Truncation and malformed output need opposite corrections: one asks for
  // less, the other for a fix. Replaying "invalid JSON" after a cut-off
  // response invites the model to produce the same over-long document again.
  const instruction = truncated
    ? "Your previous response was cut off before it finished, so it could not be parsed. Produce a shorter document that still matches the required shape: fewer findings, fewer table rows, and briefer prose."
    : `Your previous response was rejected: ${reason}\nRepair it once and return only the corrected JSON object.`;
  const tail = truncated ? "" : `\n\nPrevious response:\n${invalidOutput}`;

  return { system: base.system, prompt: `${base.prompt}\n\n${instruction}${tail}` };
}

/**
 * Parses and validates a model-authored body.
 *
 * Throws with the schema's own message so the repair prompt can quote it.
 */
export function parseAuthored<Format extends DeliverableFormat>(
  format: Format,
  raw: string,
): AuthoredContent[Format] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error("Response is not valid JSON");
  }

  const result = AUTHORED_SCHEMAS[format].safeParse(parsed);
  if (!result.success) throw new Error(describeIssues(result.error));
  return result.data as AuthoredContent[Format];
}

/**
 * Models frequently wrap JSON in a Markdown fence despite instructions not to.
 * Stripping it is cheaper than spending a repair turn on formatting.
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

// ─── Merging authored content with resolved citations ────────────────────────

/** Deliverable titles are capped by the generator schemas. */
const TITLE_MAX_LENGTH = 160;

function asTitle(task: string): string {
  const trimmed = task.trim();
  return trimmed.length <= TITLE_MAX_LENGTH ? trimmed : `${trimmed.slice(0, TITLE_MAX_LENGTH - 1)}\u2026`;
}

export function mergeDocx(title: string, authored: AuthoredDocx, citations: DeliverableCitation[]): DocxDeliverableInput {
  return { title: asTitle(title), ...authored, citations };
}

export function mergePptx(title: string, authored: AuthoredPptx, citations: DeliverableCitation[]): PptxDeliverableInput {
  return { title: asTitle(title), ...authored, citations };
}

export function mergeXlsx(title: string, authored: AuthoredXlsx, citations: DeliverableCitation[]): XlsxDeliverableInput {
  return { title: asTitle(title), ...authored, citations };
}
