import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { spreadsheetFormulaSchema, xlsxDeliverableInputSchema, type XlsxDeliverableInput } from "../src/modules/deliverables/deliverable-schemas.js";
import { generateXlsx } from "../src/modules/deliverables/xlsx-generator.js";

const input: XlsxDeliverableInput = {
  title: "Production reconciliation",
  sections: [{
    title: "Daily output",
    summary: "Reported output was checked against the shift production log.",
    findings: [{
      title: "Output remains within plan",
      detail: "The reconciled total is within two percent of the daily plan.",
      severity: "low",
      citationIds: ["LOG-01"],
    }],
  }],
  citations: [{ id: "LOG-01", title: "Shift production log", source: "@SUM(A1:A2)", locator: "Rows 18-20" }],
  assumptions: ["Meter readings are reported at standard conditions."],
  tables: [{
    name: "Production",
    title: "Shift output",
    columns: [
      { header: "Shift", dataType: "text" },
      { header: "Output", dataType: "number", unit: "t" },
      { header: "Utilization", dataType: "percentage", unit: "%" },
    ],
    rows: [["=2+5", 120.5, 0.94], ["Night", 118, 0.91]],
  }],
  calculations: [{
    label: "Total output",
    formula: "SUM(Production[Output])",
    unit: "t",
    cachedResult: 238.5,
    assumptions: ["Both shifts are complete."],
    citationIds: ["LOG-01"],
  }],
};

async function xml(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  expect(file, `Missing OOXML part: ${path}`).not.toBeNull();
  return file!.async("string");
}

describe("XLSX deliverable generator", () => {
  it("creates editable tables and controlled formulas in a valid OOXML workbook", async () => {
    const zip = await JSZip.loadAsync(await generateXlsx(input));
    const requiredParts = [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/tables/table1.xml",
    ];
    requiredParts.forEach((part) => expect(zip.file(part), `Missing OOXML part: ${part}`).not.toBeNull());

    const contentTypes = await xml(zip, "[Content_Types].xml");
    const rootRelationships = await xml(zip, "_rels/.rels");
    const workbook = await xml(zip, "xl/workbook.xml");
    const workbookRelationships = await xml(zip, "xl/_rels/workbook.xml.rels");
    const table = await xml(zip, "xl/tables/table1.xml");
    const sharedStrings = await xml(zip, "xl/sharedStrings.xml");
    const core = await xml(zip, "docProps/core.xml");
    const worksheetParts = Object.keys(zip.files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path));
    const worksheetXml = (await Promise.all(worksheetParts.map((path) => xml(zip, path)))).join("\n");
    const formulas = [...worksheetXml.matchAll(/<f(?: [^>]*)?>(.*?)<\/f>/g)].map((match) => match[1]);

    expect(contentTypes).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml");
    expect(rootRelationships).toContain('Target="xl/workbook.xml"');
    expect(workbookRelationships).toContain("/relationships/worksheet");
    expect((workbook.match(/<sheet /g) ?? [])).toHaveLength(5);
    expect(worksheetParts).toHaveLength(5);
    expect(table).toContain('name="Production"');
    expect(table).toContain('name="Output"');
    expect(sharedStrings).toContain("Units: Output = t; Utilization = %");
    expect(formulas).toEqual(["SUM(Production[Output])"]);
    expect(sharedStrings).toContain("&apos;=2+5");
    expect(sharedStrings).toContain("&apos;@SUM(A1:A2)");
    expect(sharedStrings).toContain("HUMAN REVIEW REQUIRED BEFORE USE");
    expect(core).toContain("2000-01-01T00:00:00Z");
    expect(Object.keys(zip.files).some((path) => /vbaProject|externalLinks/i.test(path))).toBe(false);
  });

  it("rejects external-capable formulas, malformed tables, and unknown citations", () => {
    expect(spreadsheetFormulaSchema.safeParse("WEBSERVICE(\"https://example.test\")").success).toBe(false);
    expect(spreadsheetFormulaSchema.safeParse("='C:\\temp\\book.xlsx'!A1").success).toBe(false);
    expect(xlsxDeliverableInputSchema.safeParse({
      ...input,
      tables: [{ ...input.tables[0], rows: [["Day"]] }],
    }).success).toBe(false);
    expect(xlsxDeliverableInputSchema.safeParse({
      ...input,
      calculations: [{ ...input.calculations[0], citationIds: ["MISSING"] }],
    }).success).toBe(false);
  });
});
