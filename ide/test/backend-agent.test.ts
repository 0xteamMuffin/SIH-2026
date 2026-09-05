import { describe, expect, it } from "vitest";

import type { ApprovalBlock, DocumentBlock, StatusBlock, ToolCallBlock } from "@shared/types.js";

import { BackendAgentGateway, toBlocks } from "../src/main/services/backend-agent.js";
import type { BackendRun } from "../src/main/services/backend-client.js";

function run(overrides: Partial<BackendRun> = {}): BackendRun {
  return {
    id: "run-1",
    status: "RUNNING",
    task: "Draft an approval note",
    modelProfile: "remote-general",
    modelReason: "routed",
    taskCapability: "document",
    ...overrides,
  };
}

const statusOf = (blocks: ReturnType<typeof toBlocks>): StatusBlock =>
  blocks.at(-1) as StatusBlock;

describe("toBlocks run status", () => {
  it("ends every projection with exactly one status block", () => {
    for (const status of ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const) {
      const blocks = toBlocks(run({ status }));
      expect(blocks.filter((block) => block.kind === "status"), status).toHaveLength(1);
      expect(blocks.at(-1)?.kind, status).toBe("status");
    }
  });

  it("maps backend statuses onto the client's run states", () => {
    expect(statusOf(toBlocks(run({ status: "PENDING" }))).state).toBe("queued");
    expect(statusOf(toBlocks(run({ status: "RUNNING" }))).state).toBe("running");
    expect(statusOf(toBlocks(run({ status: "WAITING_APPROVAL" }))).state).toBe("awaiting-approval");
    expect(statusOf(toBlocks(run({ status: "CANCELLED" }))).state).toBe("cancelled");
  });

  it("names the model on completion so routing is visible", () => {
    const status = statusOf(toBlocks(run({ status: "COMPLETED", modelProfile: "local-general" })));

    expect(status.state).toBe("completed");
    expect(status.detail).toBe("local-general");
  });

  it("surfaces the backend's failure reason rather than a generic message", () => {
    const status = statusOf(toBlocks(run({ status: "FAILED", result: { error: "Sandbox exited 2" } })));

    expect(status.state).toBe("failed");
    expect(status.detail).toBe("Sandbox exited 2");
  });

  it("falls back to the error code when no message is given", () => {
    const status = statusOf(toBlocks(run({ status: "FAILED", result: { code: "RUN_DEADLINE_EXCEEDED" } })));

    expect(status.detail).toBe("RUN_DEADLINE_EXCEEDED");
  });
});

describe("toBlocks tool calls", () => {
  it("renders each call with a readable label", () => {
    const blocks = toBlocks(run({
      toolCalls: [{ toolName: "knowledge.search", status: "RUNNING" }],
    }));
    const tool = blocks.find((block) => block.kind === "tool") as ToolCallBlock;

    expect(tool.summary).toBe("Searching knowledge base");
    expect(tool.state).toBe("running");
  });

  it("prefers the backend's own summary once a call completes", () => {
    const blocks = toBlocks(run({
      toolCalls: [{
        toolName: "knowledge.search",
        status: "COMPLETED",
        output: { ok: true, summary: "Retrieved 3 knowledge citation(s)" },
      }],
    }));

    expect((blocks[0] as ToolCallBlock).summary).toBe("Retrieved 3 knowledge citation(s)");
  });

  it("hides the completed inference call, whose output is the answer itself", () => {
    const blocks = toBlocks(run({
      status: "COMPLETED",
      toolCalls: [{ toolName: "model.analyze", status: "COMPLETED", output: { ok: true, summary: "done" } }],
      result: { analysis: "The line is fit for service." },
    }));

    expect(blocks.some((block) => block.kind === "tool")).toBe(false);
  });

  it("still shows the inference call while it is running", () => {
    const blocks = toBlocks(run({ toolCalls: [{ toolName: "model.analyze", status: "RUNNING" }] }));

    expect((blocks[0] as ToolCallBlock).summary).toBe("Analysing");
  });

  it("falls back to the raw name for a tool it has no label for", () => {
    const blocks = toBlocks(run({ toolCalls: [{ toolName: "fs.grep", status: "RUNNING" }] }));

    // A tool added to the backend must still appear, not vanish.
    expect((blocks[0] as ToolCallBlock).summary).toBe("fs.grep");
  });

  it("marks a failed call and carries its reason", () => {
    const blocks = toBlocks(run({
      toolCalls: [{ toolName: "sandbox.execute", status: "FAILED", output: { summary: "exit 2" } }],
    }));
    const tool = blocks[0] as ToolCallBlock;

    expect(tool.state).toBe("failed");
    expect(tool.summary).toContain("exit 2");
  });

  it("distinguishes a rejected call from a failed one", () => {
    const blocks = toBlocks(run({ toolCalls: [{ toolName: "sandbox.execute", status: "REJECTED" }] }));

    expect((blocks[0] as ToolCallBlock).state).toBe("rejected");
  });
});

describe("toBlocks approvals", () => {
  const pending = {
    id: "approval-1",
    toolName: "sandbox.execute",
    toolInput: { language: "python", code: "print(1)" },
    riskLevel: "HIGH" as const,
    status: "PENDING" as const,
  };

  it("surfaces a pending approval with the exact input to review", () => {
    const blocks = toBlocks(run({ status: "WAITING_APPROVAL", approvals: [pending] }));
    const approval = blocks.find((block) => block.kind === "approval") as ApprovalBlock;

    expect(approval.approvalId).toBe("approval-1");
    expect(approval.riskLevel).toBe("HIGH");
    expect(approval.input).toEqual(pending.toolInput);
  });

  it("drops an approval once it has been decided", () => {
    for (const status of ["APPROVED", "REJECTED", "CANCELLED"] as const) {
      const blocks = toBlocks(run({ approvals: [{ ...pending, status }] }));
      expect(blocks.some((block) => block.kind === "approval"), status).toBe(false);
    }
  });
});

describe("toBlocks results", () => {
  it("renders the analysis as prose", () => {
    const blocks = toBlocks(run({ status: "COMPLETED", result: { analysis: "  Fit for service.  " } }));

    expect(blocks.some((block) => block.kind === "text" && block.text === "Fit for service.")).toBe(true);
  });

  it("omits an empty analysis rather than rendering a blank bubble", () => {
    const blocks = toBlocks(run({ status: "COMPLETED", result: { analysis: "   " } }));

    expect(blocks.some((block) => block.kind === "text")).toBe(false);
  });

  it("exposes a generated artifact as a previewable document", () => {
    const blocks = toBlocks(run({
      status: "COMPLETED",
      result: {
        artifact: {
          id: "artifact-1",
          filename: "approval-note-run-1.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          kind: "GENERATED_DOCX",
          sizeBytes: 4096,
        },
      },
    }));
    const document = blocks.find((block) => block.kind === "document") as DocumentBlock;

    expect(document.document.kind).toBe("wordprocessing");
    expect(document.document.byteSize).toBe(4096);
    // Artifact-sourced, so the preview is fetched from the backend rather than
    // from a local path that does not exist on this machine.
    expect(document.document.source).toEqual({ type: "artifact", artifactId: "artifact-1" });
  });

  it("classifies a generated file by MIME when its name has no useful extension", () => {
    const blocks = toBlocks(run({
      status: "COMPLETED",
      result: {
        artifact: {
          id: "artifact-2",
          filename: "workbook",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          kind: "GENERATED_XLSX",
        },
      },
    }));

    expect((blocks.find((block) => block.kind === "document") as DocumentBlock).document.kind).toBe("spreadsheet");
  });

  it("orders a turn as steps, then answer, then status", () => {
    const blocks = toBlocks(run({
      status: "COMPLETED",
      toolCalls: [{ toolName: "artifact.read", status: "COMPLETED", output: { summary: "Read 4kB" } }],
      result: { analysis: "Done." },
    }));

    expect(blocks.map((block) => block.kind)).toEqual(["tool", "text", "status"]);
  });
});

describe("runTurn workspace binding", () => {
  function harness(sessionWorkspace: string) {
    const created: Array<{ workspaceId: string; conversationId?: string }> = [];
    const client = {
      createRun: async (input: { workspaceId: string; task: string; conversationId?: string }) => {
        created.push(input);
        return run({ status: "COMPLETED", result: { analysis: "done" } });
      },
    };
    const session = {
      requireClient: () => client,
      requireWorkspaceId: () => sessionWorkspace,
    };
    return { created, gateway: new BackendAgentGateway({ session: session as never, documents: {} as never }) };
  }

  const turn = (chatId: string, extra: Record<string, unknown> = {}) => ({
    chatId,
    prompt: "summarise that",
    attachments: [],
    classification: "INTERNAL" as const,
    signal: new AbortController().signal,
    publish: () => {},
    bindWorkspace: () => {},
    ...extra,
  });

  it("binds a chat's first turn to the session's workspace", async () => {
    const { created, gateway } = harness("workspace-a");
    const bound: string[] = [];

    await gateway.runTurn(turn("chat-1", { bindWorkspace: (id: string) => bound.push(id) }) as never);

    expect(created[0]?.workspaceId).toBe("workspace-a");
    expect(bound).toEqual(["workspace-a"]);
  });

  it("keeps a later turn in the chat's own workspace, not the session's", async () => {
    // The session's selected workspace can move between turns. Following it
    // would file the follow-up somewhere the earlier answer is not, and the
    // backend scopes a thread's history by workspace — so the chat would look
    // to itself like it had never said anything.
    const { created, gateway } = harness("workspace-moved-on");

    await gateway.runTurn(turn("chat-1", { workspaceId: "workspace-a" }) as never);

    expect(created[0]?.workspaceId).toBe("workspace-a");
    expect(created[0]?.conversationId).toBe("chat-1");
  });
});
