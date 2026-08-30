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
  });

  it("validates tool-specific outputs", () => {
    expect(validateToolOutput("sandbox.execute", { ok: true, summary: "complete", stdout: "2", stderr: "", exitCode: 0 })).toMatchObject({ exitCode: 0 });
    expect(() => validateToolOutput("artifact.read", { ok: true, summary: "read", data: { text: "missing character count" } })).toThrow();
  });
});
