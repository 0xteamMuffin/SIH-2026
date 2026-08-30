import type { EvidenceItem } from "./agent.types.js";
import type { PptxDeliverableInput, XlsxDeliverableInput } from "../deliverables/deliverable-schemas.js";

export type DeliverableFormat = "docx" | "pptx" | "xlsx";

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

function sourceMaterial(evidence: EvidenceItem[]) {
  if (evidence.length === 0) throw new Error("Office deliverables require source evidence");
  const citations = evidence.map((item, index) => ({
    id: `S${index + 1}`,
    title: clean(item.title, 160),
    source: clean(item.sourceRef, 500),
    locator: `Evidence ${item.id}`.slice(0, 120),
  }));
  return { citations, citationIds: citations.map((citation) => citation.id) };
}

export function presentationInput(task: string, analysis: string, evidence: EvidenceItem[]): PptxDeliverableInput {
  const { citations, citationIds } = sourceMaterial(evidence);
  return {
    title: clean(task, 160),
    subtitle: "Evidence-backed review",
    sections: [{
      title: "Analysis",
      summary: clean(analysis, 800),
      findings: [{ title: "Model-assisted finding", detail: clean(analysis, 900), severity: "info", citationIds: citationIds.slice(0, 8) }],
    }],
    citations,
  };
}

export function spreadsheetInput(task: string, analysis: string, evidence: EvidenceItem[]): XlsxDeliverableInput {
  const { citations, citationIds } = sourceMaterial(evidence);
  return {
    title: clean(task, 160),
    sections: [{
      title: "Analysis",
      summary: clean(analysis, 1_500),
      findings: [{ title: "Model-assisted finding", detail: clean(analysis, 1_500), severity: "info", citationIds: citationIds.slice(0, 8) }],
    }],
    citations,
    assumptions: ["Model-assisted findings require human review against the cited source material."],
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
      citationIds: citationIds.slice(0, 8),
    }],
  };
}
