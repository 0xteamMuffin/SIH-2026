import { describe, expect, it } from "vitest";
import {
  authoringMessages,
  authoringRepairMessages,
  mergeDocx,
  parseAuthored,
} from "../src/modules/agent/deliverable-authoring.js";
import { docxDeliverableInputSchema } from "../src/modules/deliverables/deliverable-schemas.js";

const citations = [
  { id: "S1", title: "Inspection report QA-2291", source: "artifact:1", locator: "Evidence 1" },
  { id: "S2", title: "Deviation log", source: "artifact:2", locator: "Evidence 2" },
];

const validDocx = {
  purpose: "Seek approval to return the line to service.",
  findings: [{
    title: "Station 41 wall loss",
    detail: "6.81 mm, above the 6.53 mm retirement thickness.",
    severity: "high" as const,
    citationIds: ["S1"],
  }],
  recommendation: "Approve with a reduced inspection interval.",
};

describe("parseAuthored", () => {
  it("accepts a well-formed body", () => {
    expect(parseAuthored("docx", JSON.stringify(validDocx))).toMatchObject({
      recommendation: "Approve with a reduced inspection interval.",
    });
  });

  it("tolerates a Markdown code fence", () => {
    // Models wrap JSON in fences routinely; spending a repair turn on
    // formatting would waste a model call for nothing.
    const fenced = "```json\n" + JSON.stringify(validDocx) + "\n```";

    expect(parseAuthored("docx", fenced)).toMatchObject({ purpose: validDocx.purpose });
  });

  it("tolerates an unlabelled fence and surrounding whitespace", () => {
    const fenced = "\n  ```\n" + JSON.stringify(validDocx) + "\n```  \n";

    expect(parseAuthored("docx", fenced)).toMatchObject({ purpose: validDocx.purpose });
  });

  it("reports unparseable output distinctly from invalid output", () => {
    expect(() => parseAuthored("docx", "I could not complete this.")).toThrow("Response is not valid JSON");
  });

  it("names the offending field so the repair prompt can quote it", () => {
    const missingRecommendation = { purpose: validDocx.purpose, findings: validDocx.findings };

    expect(() => parseAuthored("docx", JSON.stringify(missingRecommendation))).toThrow(/recommendation/);
  });

  it("rejects a severity outside the permitted set", () => {
    const badSeverity = {
      ...validDocx,
      findings: [{ ...validDocx.findings[0], severity: "catastrophic" }],
    };

    expect(() => parseAuthored("docx", JSON.stringify(badSeverity))).toThrow(/severity/);
  });

  it("rejects a body that smuggles in its own citation list", () => {
    // Citations are resolved from evidence server-side; accepting them from
    // the model would let it invent a source.
    const withCitations = { ...validDocx, citations: [{ id: "S9", title: "Invented", source: "nowhere" }] };

    expect(() => parseAuthored("docx", JSON.stringify(withCitations))).toThrow();
  });

  it("rejects a spreadsheet body missing its tables", () => {
    const noTables = {
      sections: [{ title: "S", summary: "S", findings: [{ title: "F", detail: "D", severity: "low", citationIds: ["S1"] }] }],
      assumptions: ["A"],
      calculations: [{ label: "X", formula: "SUM(A1:A2)", unit: "mm", assumptions: [], citationIds: ["S1"] }],
    };

    expect(() => parseAuthored("xlsx", JSON.stringify(noTables))).toThrow(/tables/);
  });
});

describe("authoringMessages", () => {
  it("lists exactly the citation ids the model may reference", () => {
    const { prompt } = authoringMessages("docx", "Draft a note", "Analysis text", undefined, citations);

    expect(prompt).toContain("S1: Inspection report QA-2291");
    expect(prompt).toContain("S2: Deviation log");
  });

  it("includes the source material when the run has any", () => {
    const { prompt } = authoringMessages("docx", "Draft a note", "Analysis", "Raw report text", citations);

    expect(prompt).toContain("Raw report text");
  });

  it("omits the source section entirely when there is none", () => {
    const { prompt } = authoringMessages("docx", "Draft a note", "Analysis", undefined, citations);

    expect(prompt).not.toContain("Source material:");
  });

  it("tells a spreadsheet run to tabulate data rather than list sources", () => {
    const { prompt } = authoringMessages("xlsx", "Build a workbook", "Analysis", undefined, citations);

    expect(prompt).toMatch(/Do not emit a table that merely lists the sources/);
    expect(prompt).toContain("dataType");
  });

  it("forbids inventing citations in the system prompt", () => {
    const { system } = authoringMessages("pptx", "Slides", "Analysis", undefined, citations);

    expect(system).toMatch(/Never invent/);
  });
});

describe("authoringRepairMessages", () => {
  it("quotes the validation failure and the rejected output", () => {
    const { prompt } = authoringRepairMessages(
      "docx",
      "Draft a note",
      "Analysis",
      undefined,
      citations,
      '{"purpose":"x"}',
      "recommendation: Required",
    );

    expect(prompt).toContain("recommendation: Required");
    expect(prompt).toContain('{"purpose":"x"}');
    // Still carries the original instructions, so the retry is not stranded
    // without the shape it is meant to produce.
    expect(prompt).toContain("S1: Inspection report QA-2291");
  });
});

describe("authoringRepairMessages when the response was truncated", () => {
  it("asks for a shorter document instead of a syntax fix", () => {
    const { prompt } = authoringRepairMessages(
      "xlsx", "Build a workbook", "Analysis", undefined, citations,
      '{"tables":[{"rows":[[1,2',
      "Response is not valid JSON",
      true,
    );

    expect(prompt).toMatch(/cut off before it finished/);
    expect(prompt).toMatch(/fewer table rows/);
  });

  it("omits the truncated output, which would only waste context", () => {
    const { prompt } = authoringRepairMessages(
      "xlsx", "Build a workbook", "Analysis", undefined, citations,
      '{"tables":[{"rows":[[1,2',
      "Response is not valid JSON",
      true,
    );

    expect(prompt).not.toContain('{"tables":[{"rows":[[1,2');
  });
});

describe("deliverable titles", () => {
  it("truncates a task longer than the schema's title limit", () => {
    // Tasks are free text and routinely exceed 160 characters; the generator
    // schema rejects anything longer.
    const longTask = "Read the inspection report and build a workbook ".repeat(6);
    const merged = mergeDocx(longTask, validDocx, citations);

    expect(merged.title.length).toBeLessThanOrEqual(160);
    expect(() => docxDeliverableInputSchema.parse(merged)).not.toThrow();
  });

  it("leaves a short title untouched", () => {
    expect(mergeDocx("Approval note", validDocx, citations).title).toBe("Approval note");
  });
});

describe("mergeDocx", () => {
  it("produces a document the generator schema accepts", () => {
    const merged = mergeDocx("Approval note", validDocx, citations);

    expect(() => docxDeliverableInputSchema.parse(merged)).not.toThrow();
    expect(merged.title).toBe("Approval note");
    expect(merged.citations).toHaveLength(2);
  });
});
