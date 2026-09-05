import { describe, expect, it } from "vitest";
import { pptxDeliverableInputSchema, xlsxDeliverableInputSchema } from "../src/modules/deliverables/deliverable-schemas.js";
import { deliverableCitations, fallbackDocx, fallbackPptx, fallbackXlsx, selectDeliverableFormat } from "../src/modules/agent/agent-deliverables.js";
import { mergeDocx, mergePptx, mergeXlsx } from "../src/modules/agent/deliverable-authoring.js";
import { docxDeliverableInputSchema } from "../src/modules/deliverables/deliverable-schemas.js";
import { parseGeneratedCode, sandboxToolResult } from "../src/modules/agent/agent.types.js";

const evidence = [{
  id: "10000000-0000-4000-8000-000000000001",
  title: "Inspection report",
  summary: "Valve V-101 requires review.",
  facts: ["Valve V-101 requires review."],
  sourceRef: "artifact:20000000-0000-4000-8000-000000000001",
}];

describe("agent generated outputs", () => {
  it("accepts only the exact generated-code JSON contract", () => {
    expect(parseGeneratedCode('{"language":"python","code":"print(1)","explanation":"Prints one."}')).toEqual({ language: "python", code: "print(1)", explanation: "Prints one." });
    expect(() => parseGeneratedCode("```json\n{}\n```")).toThrow("not valid JSON");
    expect(() => parseGeneratedCode('{"language":"python","code":"print(1)","explanation":"Prints one.","extra":true}')).toThrow("required schema");
  });

  it("classifies non-zero sandbox exits as failed tool results", () => {
    expect(sandboxToolResult({ stdout: "", stderr: "boom", exitCode: 2 })).toMatchObject({ ok: false, errorCode: "SANDBOX_NON_ZERO_EXIT", data: { exitCode: 2 } });
    expect(sandboxToolResult({ stdout: "ok", stderr: "", exitCode: 0 })).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("selects requested Office formats deterministically and defaults to DOCX", () => {
    expect(selectDeliverableFormat("Create a PowerPoint presentation and an Excel appendix")).toBe("pptx");
    expect(selectDeliverableFormat("Build an XLSX workbook")).toBe("xlsx");
    expect(selectDeliverableFormat("Create an approval note")).toBe("docx");
  });

  it("derives citations from evidence rather than from model output", () => {
    const citations = deliverableCitations(evidence);

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ id: "S1", source: evidence[0].sourceRef });
    expect(citations[0].locator).toContain(evidence[0].id);
  });

  it("refuses to build citations with no evidence", () => {
    expect(() => deliverableCitations([])).toThrow(/require source evidence/);
  });

  it("merges model-authored content with server-resolved citations", () => {
    const citations = deliverableCitations(evidence);
    const merged = mergeXlsx("Wall thickness review", {
      sections: [{
        title: "Findings",
        summary: "Station 41 is the thinnest point on the run.",
        findings: [{ title: "Station 41", detail: "6.81 mm, below the alert threshold.", severity: "high", citationIds: ["S1"] }],
      }],
      assumptions: ["Retirement thickness is 6.53 mm."],
      tables: [{
        name: "Readings",
        title: "Wall thickness by station",
        columns: [
          { header: "Station", dataType: "integer" },
          { header: "Thickness", dataType: "number", unit: "mm" },
        ],
        rows: [[41, 6.81], [42, 7.12]],
      }],
      calculations: [{
        label: "Mean thickness",
        formula: "AVERAGE(B2:B3)",
        unit: "mm",
        cachedResult: 6.965,
        assumptions: [],
        citationIds: ["S1"],
      }],
    }, citations);

    // Round-tripping through the generator schema proves authored content is
    // accepted on the same terms as anything else.
    const parsed = xlsxDeliverableInputSchema.parse(merged);
    expect(parsed.title).toBe("Wall thickness review");
    expect(parsed.tables[0].rows).toEqual([[41, 6.81], [42, 7.12]]);
    expect(parsed.calculations[0].formula).toBe("AVERAGE(B2:B3)");
    expect(parsed.sections[0].findings[0].severity).toBe("high");
    expect(parsed.citations[0]).toMatchObject({ id: "S1", source: evidence[0].sourceRef });
  });

  it("rejects authored content that cites an id the run never gathered", () => {
    const citations = deliverableCitations(evidence);
    const merged = mergePptx("Deck", {
      sections: [{
        title: "Findings",
        summary: "Summary",
        findings: [{ title: "Finding", detail: "Detail", severity: "low", citationIds: ["S9"] }],
      }],
    }, citations);

    expect(() => pptxDeliverableInputSchema.parse(merged)).toThrow(/Unknown citation id/);
  });

  it("produces schema-valid fallbacks for every format", () => {
    const citations = deliverableCitations(evidence);

    expect(() => docxDeliverableInputSchema.parse(mergeDocx("Note", fallbackDocx("Analysis", citations), citations))).not.toThrow();
    expect(() => pptxDeliverableInputSchema.parse(mergePptx("Deck", fallbackPptx("Analysis", citations), citations))).not.toThrow();
    expect(() => xlsxDeliverableInputSchema.parse(mergeXlsx("Book", fallbackXlsx("Analysis", citations), citations))).not.toThrow();
  });

  it("marks a fallback document as degraded in its own text", () => {
    const citations = deliverableCitations(evidence);

    expect(fallbackDocx("Analysis", citations).purpose).toMatch(/Structured authoring was unavailable/);
    expect(fallbackXlsx("Analysis", citations).assumptions[0]).toMatch(/Structured authoring was unavailable/);
  });
});
