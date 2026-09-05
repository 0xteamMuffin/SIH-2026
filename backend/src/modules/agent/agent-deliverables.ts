import type { EvidenceItem } from "./agent.types.js";
import type {
  AuthoredDocx,
  AuthoredPptx,
  AuthoredXlsx,
  citationSchema,
} from "../deliverables/deliverable-schemas.js";
import type { z } from "zod";

export type DeliverableFormat = "docx" | "pptx" | "xlsx";
export type DeliverableCitation = z.infer<typeof citationSchema>;

const formatPatterns: Array<{ format: Exclude<DeliverableFormat, "docx">; pattern: RegExp }> = [
  { format: "pptx", pattern: /\b(?:pptx|powerpoint|presentation|slide deck|slides)\b/i },
  { format: "xlsx", pattern: /\b(?:xlsx|excel|spreadsheet|workbook)\b/i },
];

export function selectDeliverableFormat(task: string): DeliverableFormat {
  const matches = formatPatterns
    .map(({ format, pattern }) => ({ format, index: task.search(pattern) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index || left.format.localeCompare(right.format));
  return matches[0]?.format ?? "docx";
}

function clean(value: string, maximum: number) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, maximum) || "Source content unavailable";
}

/**
 * Resolves evidence records into the citation list a deliverable is bound to.
 *
 * Deliberately server-side: the model is shown these ids and may reference
 * them, but cannot add to them, so every citation in a generated document
 * corresponds to evidence the run actually collected.
 */
export function deliverableCitations(evidence: EvidenceItem[]): DeliverableCitation[] {
  if (evidence.length === 0) throw new Error("Office deliverables require source evidence");
  return evidence.map((item, index) => ({
    id: `S${index + 1}`,
    title: clean(item.title, 160),
    source: clean(item.sourceRef, 500),
    locator: `Evidence ${item.id}`.slice(0, 120),
  }));
}

// ─── Fallbacks ───────────────────────────────────────────────────────────────
//
// Used only when the model fails twice to author a valid body. They produce a
// minimal, clearly-labelled document rather than failing the run outright —
// but they are a degraded result, and they say so in the document itself, so
// nobody mistakes one for a real analysis.

const FALLBACK_NOTICE =
  "Structured authoring was unavailable for this run, so this document contains the unstructured model analysis only. Treat it as a draft and review it against the cited sources.";

export function fallbackDocx(analysis: string, citations: DeliverableCitation[]): AuthoredDocx {
  return {
    purpose: FALLBACK_NOTICE,
    findings: [{
      title: "Model analysis",
      detail: clean(analysis, 1_500),
      severity: "info",
      citationIds: citations.slice(0, 8).map((citation) => citation.id),
    }],
    recommendation: "No structured recommendation was produced. Review the analysis above against the cited sources.",
  };
}

export function fallbackPptx(analysis: string, citations: DeliverableCitation[]): AuthoredPptx {
  return {
    subtitle: "Evidence-backed review",
    sections: [{
      title: "Analysis",
      summary: clean(analysis, 800),
      findings: [{
        title: "Model analysis",
        detail: clean(analysis, 900),
        severity: "info",
        citationIds: citations.slice(0, 8).map((citation) => citation.id),
      }],
    }],
  };
}

export function fallbackXlsx(analysis: string, citations: DeliverableCitation[]): AuthoredXlsx {
  const citationIds = citations.slice(0, 8).map((citation) => citation.id);
  return {
    sections: [{
      title: "Analysis",
      summary: clean(analysis, 1_500),
      findings: [{
        title: "Model analysis",
        detail: clean(analysis, 1_500),
        severity: "info",
        citationIds,
      }],
    }],
    assumptions: [FALLBACK_NOTICE],
    tables: [{
      name: "SourceEvidence",
      title: "Source evidence register",
      columns: [
        { header: "Source ID", dataType: "text" },
        { header: "Title", dataType: "text" },
        { header: "Reference", dataType: "text" },
      ],
      rows: citations.map((citation) => [citation.id, citation.title, citation.source]),
    }],
    calculations: [{
      label: "Source records included",
      formula: `SUM(${citations.length})`,
      unit: "records",
      cachedResult: citations.length,
      assumptions: ["Counts the source records embedded in this workbook."],
      citationIds,
    }],
  };
}
