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
    expect(validateToolInput("deliverable.createApprovalNote", { format: "docx" })).toEqual({ format: "docx" });
    expect(() => validateToolInput("code.persistOutput", { language: "python", code: "print(1)", explanation: "test", extra: true })).toThrow();
  });

  it("registers deterministic Office generators without approval", () => {
    const evidenceId = "10000000-0000-4000-8000-000000000001";
    expect(validateToolInput("deliverable.createPresentation", { format: "pptx", evidenceIds: [evidenceId] })).toEqual({ format: "pptx", evidenceIds: [evidenceId] });
    expect(validateToolInput("deliverable.createSpreadsheet", { format: "xlsx", evidenceIds: [evidenceId] })).toEqual({ format: "xlsx", evidenceIds: [evidenceId] });
    expect(toolRequiresApproval("deliverable.createPresentation")).toBe(false);
    expect(toolRequiresApproval("deliverable.createSpreadsheet")).toBe(false);
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
