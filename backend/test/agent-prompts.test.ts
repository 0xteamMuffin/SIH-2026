import { describe, expect, it } from "vitest";
import { modelMessages } from "../src/modules/agent/agent-prompts.js";

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
});
