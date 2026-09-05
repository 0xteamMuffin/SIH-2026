import { z } from "zod";

export const HUMAN_REVIEW_NOTICE = "DRAFT - HUMAN REVIEW REQUIRED BEFORE USE";

const invalidXmlControl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

function text(max: number) {
  return z.string().trim().min(1).max(max).refine((value) => !invalidXmlControl.test(value), "Text contains an unsupported control character");
}

/**
 * A citation handle.
 *
 * Wide enough to hold a UUID, because an agent naturally cites using the
 * evidence ids it was shown; those are normalised to short handles before the
 * document is rendered.
 */
const citationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const citationSchema = z.object({
  id: citationIdSchema,
  title: text(160),
  source: text(500),
  locator: text(120).optional(),
}).strict();

const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);

export function findingSchema(detailLimit: number) {
  return z.object({
    title: text(140),
    detail: text(detailLimit),
    severity: severitySchema,
    citationIds: z.array(citationIdSchema).min(1).max(8),
  }).strict();
}

function validateReferences(
  input: { citations: Array<{ id: string }>; sections: Array<{ findings: Array<{ citationIds: string[] }> }> },
  context: z.RefinementCtx,
) {
  const citationIds = new Set<string>();
  input.citations.forEach((citation, index) => {
    if (citationIds.has(citation.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate citation id: ${citation.id}`, path: ["citations", index, "id"] });
    }
    citationIds.add(citation.id);
  });

  input.sections.forEach((section, sectionIndex) => {
    section.findings.forEach((finding, findingIndex) => {
      finding.citationIds.forEach((citationId, citationIndex) => {
        if (!citationIds.has(citationId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown citation id: ${citationId}`,
            path: ["sections", sectionIndex, "findings", findingIndex, "citationIds", citationIndex],
          });
        }
      });
    });
  });
}

export const pptxDeliverableInputSchema = z.object({
  title: text(160),
  subtitle: text(240).optional(),
  sections: z.array(z.object({
    title: text(140),
    summary: text(800),
    findings: z.array(findingSchema(900)).min(1).max(6),
  }).strict()).min(1).max(12),
  citations: z.array(citationSchema).min(1).max(60),
}).strict().superRefine((input, context) => {
  validateReferences(input, context);
  if (input.sections.reduce((count, section) => count + section.findings.length, 0) > 48) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A presentation supports at most 48 findings", path: ["sections"] });
  }
});

const safeFormulaFunctions = new Set([
  "ABS", "AND", "AVERAGE", "AVERAGEIF", "AVERAGEIFS", "COUNT", "COUNTA", "COUNTIF", "COUNTIFS",
  "IF", "IFERROR", "INDEX", "MATCH", "MAX", "MEDIAN", "MIN", "NOT", "OR", "POWER", "PRODUCT",
  "ROUND", "ROUNDDOWN", "ROUNDUP", "SQRT", "STDEV.S", "SUBTOTAL", "SUM", "SUMIF", "SUMIFS", "VAR.S", "XLOOKUP",
]);

export const spreadsheetFormulaSchema = z.string().trim().min(1).max(500).superRefine((formula, context) => {
  if (formula.startsWith("=")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Formula must not include a leading equals sign" });
  }
  if (!/^[A-Za-z0-9_.$,:()[\]+\-*/%^<>=&" ]+$/.test(formula)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Formula contains unsupported or external-reference characters" });
  }
  for (const match of formula.matchAll(/([A-Za-z][A-Za-z0-9.]*)\s*\(/g)) {
    if (!safeFormulaFunctions.has(match[1].toUpperCase())) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Formula function is not allowed: ${match[1]}` });
    }
  }
});

const spreadsheetCellSchema = z.union([
  text(500),
  z.number().finite().min(-1e15).max(1e15),
  z.boolean(),
  z.null(),
]);

const tableSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,30}$/),
  title: text(120),
  columns: z.array(z.object({
    header: text(80),
    dataType: z.enum(["text", "number", "integer", "percentage", "boolean"]),
    unit: text(40).optional(),
  }).strict()).min(1).max(30),
  rows: z.array(z.array(spreadsheetCellSchema).max(30)).max(5_000),
}).strict().superRefine((table, context) => {
  const headers = new Set<string>();
  table.columns.forEach((column, index) => {
    const normalized = column.header.toLocaleLowerCase();
    if (headers.has(normalized)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate column header: ${column.header}`, path: ["columns", index, "header"] });
    }
    headers.add(normalized);
  });

  table.rows.forEach((row, rowIndex) => {
    if (row.length !== table.columns.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Row length must match the column count", path: ["rows", rowIndex] });
      return;
    }
    row.forEach((value, columnIndex) => {
      if (value === null) return;
      const expected = table.columns[columnIndex].dataType;
      const valid = expected === "text"
        ? typeof value === "string"
        : expected === "boolean"
          ? typeof value === "boolean"
          : typeof value === "number" && (expected !== "integer" || Number.isInteger(value));
      if (!valid) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Cell does not match ${expected} column`, path: ["rows", rowIndex, columnIndex] });
      }
    });
  });
});

export const xlsxDeliverableInputSchema = z.object({
  title: text(160),
  sections: z.array(z.object({
    title: text(140),
    summary: text(1_500),
    findings: z.array(findingSchema(1_500)).min(1).max(12),
  }).strict()).min(1).max(20),
  citations: z.array(citationSchema).min(1).max(200),
  assumptions: z.array(text(500)).min(1).max(50),
  tables: z.array(tableSchema).min(1).max(12),
  calculations: z.array(z.object({
    label: text(120),
    formula: spreadsheetFormulaSchema,
    unit: text(40),
    cachedResult: z.number().finite().min(-1e15).max(1e15).optional(),
    assumptions: z.array(text(300)).max(8),
    citationIds: z.array(citationIdSchema).min(1).max(8),
  }).strict()).min(1).max(100),
}).strict().superRefine((input, context) => {
  validateReferences(input, context);

  const tableNames = new Set<string>();
  let cellCount = 0;
  input.tables.forEach((table, index) => {
    const normalized = table.name.toLocaleLowerCase();
    if (tableNames.has(normalized)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate table name: ${table.name}`, path: ["tables", index, "name"] });
    }
    tableNames.add(normalized);
    cellCount += table.columns.length * table.rows.length;
  });
  if (cellCount > 100_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A workbook supports at most 100,000 input cells", path: ["tables"] });
  }

  const citationIds = new Set(input.citations.map((citation) => citation.id));
  input.calculations.forEach((calculation, calculationIndex) => {
    calculation.citationIds.forEach((citationId, citationIndex) => {
      if (!citationIds.has(citationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown citation id: ${citationId}`,
          path: ["calculations", calculationIndex, "citationIds", citationIndex],
        });
      }
    });
  });
});

export type PptxDeliverableInput = z.infer<typeof pptxDeliverableInputSchema>;
export type XlsxDeliverableInput = z.infer<typeof xlsxDeliverableInputSchema>;

// ─── Word approval notes ─────────────────────────────────────────────────────

/**
 * An approval note the model actually writes.
 *
 * Previously this document was assembled from a fixed skeleton, so the model's
 * reasoning arrived as one undifferentiated blob and every finding was filed
 * as informational. Giving it real structure is what lets a reviewer see the
 * recommendation, the findings behind it, and the conditions attached — which
 * is the whole point of an approval note.
 */
export const docxDeliverableInputSchema = z.object({
  title: text(160),
  purpose: text(2_000),
  background: text(4_000).optional(),
  findings: z.array(findingSchema(1_500)).min(1).max(20),
  recommendation: text(2_000),
  conditions: z.array(text(500)).max(20).optional(),
  citations: z.array(citationSchema).min(1).max(200),
}).strict().superRefine((input, context) => {
  const citationIds = new Set<string>();
  input.citations.forEach((citation, index) => {
    if (citationIds.has(citation.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate citation id: ${citation.id}`, path: ["citations", index, "id"] });
    }
    citationIds.add(citation.id);
  });

  input.findings.forEach((finding, findingIndex) => {
    finding.citationIds.forEach((citationId, citationIndex) => {
      if (!citationIds.has(citationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown citation id: ${citationId}`,
          path: ["findings", findingIndex, "citationIds", citationIndex],
        });
      }
    });
  });
});

export type DocxDeliverableInput = z.infer<typeof docxDeliverableInputSchema>;

// ─── Model-authored portions ─────────────────────────────────────────────────
//
// The model writes the body of a deliverable but never its citation list:
// citations are resolved from evidence records the run actually gathered, so a
// fabricated source cannot reach the document. The model refers to them by id,
// and the full schemas above reject any id that does not resolve.

export const authoredDocxSchema = docxDeliverableInputSchema.innerType().omit({ title: true, citations: true });
export const authoredPptxSchema = pptxDeliverableInputSchema.innerType().omit({ title: true, citations: true });
export const authoredXlsxSchema = xlsxDeliverableInputSchema.innerType().omit({ title: true, citations: true });

export type AuthoredDocx = z.infer<typeof authoredDocxSchema>;
export type AuthoredPptx = z.infer<typeof authoredPptxSchema>;
export type AuthoredXlsx = z.infer<typeof authoredXlsxSchema>;
