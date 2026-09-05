import { ToolRiskLevel } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { agentToolRegistry, toolRequiresApproval, validateToolInput, validateToolOutput } from "../src/modules/agent/agent-tool-registry.js";

describe("agent tool registry", () => {
  it("requires approval for sandbox execution", () => {
    expect(agentToolRegistry["sandbox.execute"]).toMatchObject({ risk: ToolRiskLevel.HIGH, requiresApproval: true });
    expect(toolRequiresApproval("sandbox.execute")).toBe(true);
    expect(toolRequiresApproval("artifact.read")).toBe(false);
  });

  it("validates and strips no unregistered sandbox input", () => {
    expect(() => validateToolInput("sandbox.execute", { language: "javascript", code: "1 + 1", network: true })).toThrow();
    // The approval note now carries the document body, so a bare format is
    // no longer a complete call.
    expect(() => validateToolInput("deliverable.createApprovalNote", { format: "docx" })).toThrow();
    expect(() => validateToolInput("code.persistOutput", { language: "python", code: "print(1)", explanation: "test", extra: true })).toThrow();
  });

  it("registers Office generators without approval", () => {
    expect(toolRequiresApproval("deliverable.createPresentation")).toBe(false);
    expect(toolRequiresApproval("deliverable.createSpreadsheet")).toBe(false);
    expect(toolRequiresApproval("deliverable.createApprovalNote")).toBe(false);
  });

  it("requires Office generators to carry the authored document body", () => {
    const evidenceId = "10000000-0000-4000-8000-000000000001";

    expect(() => validateToolInput("deliverable.createPresentation", { format: "pptx", evidenceIds: [evidenceId] })).toThrow();
    expect(() => validateToolInput("deliverable.createSpreadsheet", { format: "xlsx", evidenceIds: [evidenceId] })).toThrow();
  });

  it("accepts an authored spreadsheet with typed table data and a real formula", () => {
    const evidenceId = "10000000-0000-4000-8000-000000000001";
    const input = validateToolInput("deliverable.createSpreadsheet", {
      format: "xlsx",
      evidenceIds: [evidenceId],
      content: {
        sections: [{
          title: "Findings",
          summary: "Station 41 is the thinnest point.",
          findings: [{ title: "Station 41", detail: "6.81 mm.", severity: "high", citationIds: ["S1"] }],
        }],
        assumptions: ["Retirement thickness is 6.53 mm."],
        tables: [{
          name: "Readings",
          title: "Thickness by station",
          columns: [{ header: "Station", dataType: "integer" }, { header: "Thickness", dataType: "number" }],
          rows: [[41, 6.81]],
        }],
        calculations: [{ label: "Mean", formula: "AVERAGE(B2:B2)", unit: "mm", assumptions: [], citationIds: ["S1"] }],
      },
    });

    expect(input.content.tables[0].rows).toEqual([[41, 6.81]]);
    expect(input.content.sections[0].findings[0].severity).toBe("high");
  });

  it("rejects an authored table whose cells contradict their column type", () => {
    const evidenceId = "10000000-0000-4000-8000-000000000001";

    expect(() => validateToolInput("deliverable.createSpreadsheet", {
      format: "xlsx",
      evidenceIds: [evidenceId],
      content: {
        sections: [{ title: "S", summary: "S", findings: [{ title: "F", detail: "D", severity: "low", citationIds: ["S1"] }] }],
        assumptions: ["A"],
        tables: [{
          name: "Readings",
          title: "Thickness",
          columns: [{ header: "Station", dataType: "integer" }],
          rows: [["not a number"]],
        }],
        calculations: [{ label: "Mean", formula: "SUM(A2:A2)", unit: "mm", assumptions: [], citationIds: ["S1"] }],
      },
    })).toThrow();
  });

  it("rejects a formula using a function outside the allowlist", () => {
    const evidenceId = "10000000-0000-4000-8000-000000000001";

    expect(() => validateToolInput("deliverable.createSpreadsheet", {
      format: "xlsx",
      evidenceIds: [evidenceId],
      content: {
        sections: [{ title: "S", summary: "S", findings: [{ title: "F", detail: "D", severity: "low", citationIds: ["S1"] }] }],
        assumptions: ["A"],
        tables: [{ name: "T", title: "T", columns: [{ header: "A", dataType: "number" }], rows: [[1]] }],
        calculations: [{ label: "X", formula: "EXEC(A1)", unit: "mm", assumptions: [], citationIds: ["S1"] }],
      },
    })).toThrow();
  });

  it("accepts an authored approval note carrying a real severity", () => {
    const evidenceId = "10000000-0000-4000-8000-000000000001";
    const input = validateToolInput("deliverable.createApprovalNote", {
      format: "docx",
      evidenceIds: [evidenceId],
      content: {
        purpose: "Seek approval to return the line to service.",
        findings: [{ title: "Station 41", detail: "6.81 mm, above retirement thickness.", severity: "critical", citationIds: ["S1"] }],
        recommendation: "Approve with a reduced inspection interval.",
        conditions: ["Re-survey within 24 months."],
      },
    });

    expect(input.content.findings[0].severity).toBe("critical");
    expect(input.content.conditions).toEqual(["Re-survey within 24 months."]);
  });

  it("registers bounded knowledge search as a low-risk tool without client scope filters", () => {
    expect(agentToolRegistry["knowledge.search"]).toMatchObject({ risk: ToolRiskLevel.LOW, requiresApproval: false });
    expect(validateToolInput("knowledge.search", { query: "valve maintenance" })).toEqual({ query: "valve maintenance" });
    expect(() => validateToolInput("knowledge.search", { query: "valve maintenance", workspaceId: crypto.randomUUID() })).toThrow();
  });

  it("validates tool-specific outputs", () => {
    expect(validateToolOutput("sandbox.execute", { ok: true, summary: "complete", stdout: "2", stderr: "", exitCode: 0 })).toMatchObject({ exitCode: 0 });
    expect(() => validateToolOutput("artifact.read", { ok: true, summary: "read", data: { text: "missing character count" } })).toThrow();
  });
});
