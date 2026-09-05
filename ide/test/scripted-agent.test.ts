import { describe, expect, it } from "vitest";

import type { MessageBlock, StatusBlock } from "@shared/types.js";

import { ScriptedAgentGateway } from "../src/main/services/scripted-agent.js";

/** Runs a turn to completion and returns the final published block list. */
async function runTurn(prompt: string, signal?: AbortSignal): Promise<MessageBlock[]> {
  let published: MessageBlock[] = [];

  await new ScriptedAgentGateway().runTurn({
    chatId: "chat-1",
    prompt,
    signal: signal ?? new AbortController().signal,
    publish: (blocks) => {
      published = structuredClone(blocks);
    },
  });

  return published;
}

function finalStatus(blocks: MessageBlock[]): StatusBlock | undefined {
  const last = blocks.at(-1);
  return last?.kind === "status" ? last : undefined;
}

describe("ScriptedAgentGateway", () => {
  it("finishes with exactly one status block, in the completed state", async () => {
    const blocks = await runTurn("fix the alarm threshold");

    expect(blocks.filter((block) => block.kind === "status")).toHaveLength(1);
    expect(finalStatus(blocks)?.state).toBe("completed");
  });

  it("emits a renderable diff for a code-change prompt", async () => {
    const blocks = await runTurn("fix the alarm threshold");
    const diff = blocks.find((block) => block.kind === "diff");

    expect(diff).toBeDefined();
    expect(diff?.patch.hunks.length).toBeGreaterThan(0);
    expect(diff?.patch.additions).toBeGreaterThan(0);
    expect(diff?.patch.deletions).toBeGreaterThan(0);
  });

  it("emits document blocks for a document prompt", async () => {
    const blocks = await runTurn("summarise the batch record pdf");

    expect(blocks.filter((block) => block.kind === "document").length).toBeGreaterThan(0);
  });

  it("emits a browser block carrying the pasted URL", async () => {
    const blocks = await runTurn("open https://example.com/docs please");
    const browser = blocks.find((block) => block.kind === "browser");

    expect(browser?.url).toBe("https://example.com/docs");
  });

  it("falls back to an explanation when nothing else matches", async () => {
    const blocks = await runTurn("hello");

    expect(blocks.some((block) => block.kind === "text")).toBe(true);
    expect(blocks.some((block) => block.kind === "diff")).toBe(false);
  });

  it("stops early and reports cancelled when aborted mid-turn", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const blocks = await runTurn("fix the alarm threshold", controller.signal);

    expect(finalStatus(blocks)?.state).toBe("cancelled");
  });

  it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const blocks = await runTurn("fix the alarm threshold", controller.signal);

    expect(finalStatus(blocks)?.state).toBe("cancelled");
  });
});
