import { describe, expect, it } from "vitest";
import { pptxDeliverableInputSchema, xlsxDeliverableInputSchema } from "../src/modules/deliverables/deliverable-schemas.js";
import { presentationInput, selectDeliverableFormat, spreadsheetInput } from "../src/modules/agent/agent-deliverables.js";
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

  it("builds generator-valid PPTX and XLSX inputs with source citations", () => {
    const pptx = pptxDeliverableInputSchema.parse(presentationInput("Create slides", "Valve finding", evidence));
    const xlsx = xlsxDeliverableInputSchema.parse(spreadsheetInput("Create workbook", "Valve finding", evidence));

    expect(pptx.citations[0]).toMatchObject({ id: "S1", source: evidence[0].sourceRef });
    expect(pptx.sections[0].findings[0].citationIds).toEqual(["S1"]);
    expect(xlsx.citations[0]).toMatchObject({ id: "S1", source: evidence[0].sourceRef });
    expect(xlsx.calculations[0].citationIds).toEqual(["S1"]);
  });
});
