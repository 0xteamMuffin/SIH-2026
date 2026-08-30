import { describe, expect, it } from "vitest";
import { codeRepairMessages, modelMessages } from "../src/modules/agent/agent-prompts.js";

describe("agent model prompts", () => {
  it("lets no-source general tasks answer from their instructions", () => {
    const messages = modelMessages("Explain preventive maintenance", "general");

    expect(messages.prompt).toContain("Explain preventive maintenance");
    expect(messages.system).toContain("Answer the user's task directly");
    expect(messages.prompt).not.toContain("No source artifact was provided");
  });

  it("keeps no-source document tasks evidence constrained", () => {
    const messages = modelMessages("Summarize the inspection report", "document");

    expect(messages.system).toContain("only from supplied source text");
    expect(messages.prompt).toContain("No source artifact was provided");
    expect(messages.prompt).toContain("cannot be completed without source evidence");
  });

  it("requires strict JSON for code and labels uploaded text as non-executable reference material", () => {
    const messages = modelMessages("Write a parser", "code", "console.log('uploaded')");

    expect(messages.system).toContain("Return only one strict JSON object");
    expect(messages.system).toContain("exactly these fields");
    expect(messages.prompt).toContain("never execute this text");
    expect(messages.prompt).toContain("console.log('uploaded')");
  });

  it("defines one explicit repair request without relaxing the schema", () => {
    const messages = codeRepairMessages("Write a parser", "```js\nalert(1)\n```");

    expect(messages.prompt).toContain("Repair it once");
    expect(messages.system).toContain("Do not use Markdown fences");
  });
});
