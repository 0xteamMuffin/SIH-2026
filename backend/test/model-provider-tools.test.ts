import { DataClassification } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInference, type ToolDefinition } from "../src/infrastructure/models/model-provider.js";
import type { ModelProfile } from "../src/infrastructure/models/model-registry.js";

const localProfile: ModelProfile = {
  id: "local-tools",
  providerId: "local-provider",
  location: "local",
  baseUrl: "http://localhost:11434/v1",
  modelId: "local/model",
  capabilities: ["general"],
  supportsTools: true,
  priority: 100,
  enabled: true,
  sovereign: true,
  maxOutputTokens: 2_048,
};

const searchTool: ToolDefinition = {
  name: "knowledge.search",
  description: "Search internal documents.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Reads the JSON body from the single recorded fetch call. */
function sentBody(fetchMock: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(request.body)) as Record<string, unknown>;
}

describe("runInference tool calling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("advertises tools in the OpenAI function shape and defaults tool_choice to auto", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }),
    );

    await runInference(localProfile, DataClassification.CONFIDENTIAL, {
      messages: [{ role: "user", content: "find the SOP" }],
      tools: [searchTool],
    });

    const body = sentBody(fetchMock);
    expect(body["tool_choice"]).toBe("auto");
    expect(body["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "knowledge.search",
          description: "Search internal documents.",
          parameters: searchTool.parameters,
        },
      },
    ]);
  });

  it("omits the tools fields entirely when no tools are offered", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "hello" } }] }),
    );

    await runInference(localProfile, DataClassification.CONFIDENTIAL, {
      messages: [{ role: "user", content: "hello" }],
    });

    const body = sentBody(fetchMock);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("parses tool calls and reports null text when the model returns no prose", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "knowledge.search", arguments: '{"query":"retirement thickness"}' },
            }],
          },
        }],
      }),
    );

    const result = await runInference(localProfile, DataClassification.CONFIDENTIAL, {
      messages: [{ role: "user", content: "search" }],
      tools: [searchTool],
    });

    expect(result.text).toBeNull();
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "knowledge.search", argumentsJson: '{"query":"retirement thickness"}' },
    ]);
  });

  it("keeps tool-call arguments as the raw string so the caller can repair them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: "call_1", function: { name: "knowledge.search", arguments: "{not json" } }],
          },
        }],
      }),
    );

    const result = await runInference(localProfile, DataClassification.CONFIDENTIAL, {
      messages: [{ role: "user", content: "search" }],
      tools: [searchTool],
    });

    // Malformed arguments are a routine model failure, not a provider fault:
    // surfacing them lets the loop retry rather than aborting the run.
    expect(result.toolCalls[0]!.argumentsJson).toBe("{not json");
  });

  it("accepts a turn that carries both prose and tool calls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{
          message: {
            content: "Looking that up.",
            tool_calls: [{ id: "call_1", function: { name: "knowledge.search", arguments: "{}" } }],
          },
        }],
      }),
    );

    const result = await runInference(localProfile, DataClassification.CONFIDENTIAL, {
      messages: [{ role: "user", content: "search" }],
      tools: [searchTool],
    });

    expect(result.text).toBe("Looking that up.");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("rejects a turn with neither prose nor tool calls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "  " } }] }),
    );

    await expect(
      runInference(localProfile, DataClassification.CONFIDENTIAL, {
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toMatchObject({ status: 502, code: "MODEL_RESPONSE_EMPTY" });
  });

  it("refuses to offer tools to a profile that cannot use them", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      runInference({ ...localProfile, supportsTools: false }, DataClassification.CONFIDENTIAL, {
        messages: [{ role: "user", content: "search" }],
        tools: [searchTool],
      }),
    ).rejects.toMatchObject({ status: 422, code: "MODEL_TOOLS_UNSUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still serves a tool-less request to a profile that cannot use tools", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "plain answer" } }] }),
    );

    const result = await runInference({ ...localProfile, supportsTools: false }, DataClassification.CONFIDENTIAL, {
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.text).toBe("plain answer");
  });
});

describe("runInference message serialisation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("round-trips an assistant tool call and its result into the wire format", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "6.81 mm" } }] }),
    );

    await runInference(localProfile, DataClassification.CONFIDENTIAL, {
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "lowest reading?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call_1", name: "knowledge.search", argumentsJson: '{"query":"thickness"}' }],
        },
        { role: "tool", toolCallId: "call_1", content: '{"ok":true,"summary":"1 hit"}' },
      ],
      tools: [searchTool],
    });

    expect(sentBody(fetchMock)["messages"]).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "lowest reading?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "knowledge.search", arguments: '{"query":"thickness"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true,"summary":"1 hit"}' },
    ]);
  });

  it("omits tool_calls from an assistant message that has none", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );

    await runInference(localProfile, DataClassification.CONFIDENTIAL, {
      messages: [
        { role: "assistant", content: "earlier reply" },
        { role: "user", content: "continue" },
      ],
    });

    const messages = sentBody(fetchMock)["messages"] as Record<string, unknown>[];
    expect(messages[0]).toEqual({ role: "assistant", content: "earlier reply" });
    expect(messages[0]).not.toHaveProperty("tool_calls");
  });

  it("encodes image parts as data URLs for a vision profile", async () => {
    const visionProfile: ModelProfile = { ...localProfile, capabilities: ["vision"] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "a diagram" } }] }),
    );

    await runInference(visionProfile, DataClassification.CONFIDENTIAL, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", mimeType: "image/png", bytes: Buffer.from("fake-png") },
        ],
      }],
    });

    expect(sentBody(fetchMock)["messages"]).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}` } },
      ],
    }]);
  });

  it("blocks images on a profile without the vision capability", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      runInference(localProfile, DataClassification.CONFIDENTIAL, {
        messages: [{
          role: "user",
          content: [{ type: "image", mimeType: "image/png", bytes: Buffer.from("x") }],
        }],
      }),
    ).rejects.toMatchObject({ status: 422, code: "MODEL_VISION_UNSUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("runInference policy still applies to tool calls", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([DataClassification.INTERNAL, DataClassification.CONFIDENTIAL])(
    "blocks %s data from a remote profile before any request",
    async (classification) => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const remote: ModelProfile = { ...localProfile, location: "remote", sovereign: false };

      await expect(
        runInference(remote, classification, {
          messages: [{ role: "user", content: "confidential task" }],
          tools: [searchTool],
        }),
      ).rejects.toMatchObject({ status: 422, code: "EXTERNAL_INFERENCE_BLOCKED" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
