import { describe, expect, it, vi } from "vitest";
import { handleAgentRunCancellationDelivery } from "../src/infrastructure/queue/agent-run-cancellation-consumer.js";

describe("agent run cancellation consumer", () => {
  it("aborts the matching active run and acknowledges the command", () => {
    const runId = "a8aa8f67-39f9-4491-813b-20e81f4bda13";
    const delivery = { content: Buffer.from(JSON.stringify({ runId })) };
    const channel = { ack: vi.fn() };
    const abortRun = vi.fn();

    handleAgentRunCancellationDelivery(channel as never, delivery as never, abortRun);

    expect(abortRun).toHaveBeenCalledWith(runId);
    expect(channel.ack).toHaveBeenCalledWith(delivery);
  });
});
