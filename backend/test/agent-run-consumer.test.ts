import { describe, expect, it, vi } from "vitest";
import { handleAgentRunDelivery } from "../src/infrastructure/queue/agent-run-consumer.js";
import { queueTopology } from "../src/infrastructure/queue/rabbitmq.js";

const runId = "a8aa8f67-39f9-4491-813b-20e81f4bda13";

function delivery(body: unknown, retryCount?: number) {
  return {
    content: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    properties: { messageId: "event-1", headers: retryCount === undefined ? {} : { "x-retry-count": retryCount } },
  };
}

function confirmedChannel(confirmError?: Error) {
  return {
    ack: vi.fn(),
    nack: vi.fn(),
    publish: vi.fn((_exchange, _routingKey, _content, _options, confirm) => {
      confirm(confirmError, {});
      return true;
    }),
  };
}

describe("agent run consumer policy", () => {
  it("acknowledges only after processing succeeds", async () => {
    const channel = confirmedChannel();
    const message = delivery({ runId });
    const processRun = vi.fn().mockResolvedValue(undefined);

    await handleAgentRunDelivery(channel as never, message as never, processRun, vi.fn());

    expect(processRun).toHaveBeenCalledWith(runId);
    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it("routes bounded failures through the retry queue before acknowledging", async () => {
    const channel = confirmedChannel();
    const message = delivery({ runId }, 1);

    await handleAgentRunDelivery(channel as never, message as never, vi.fn().mockRejectedValue(new Error("temporary")), vi.fn());

    expect(channel.publish).toHaveBeenCalledWith(
      queueTopology.exchange,
      queueTopology.retryRoutingKey,
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ "x-retry-count": 2 }) }),
      expect.any(Function),
    );
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it("fails exhausted runs and publishes them to the dead queue", async () => {
    const channel = confirmedChannel();
    const message = delivery({ runId }, 3);
    const failure = new Error("still failing");
    const failRun = vi.fn().mockResolvedValue(undefined);

    await handleAgentRunDelivery(channel as never, message as never, vi.fn().mockRejectedValue(failure), failRun);

    expect(failRun).toHaveBeenCalledWith(runId, failure);
    expect(channel.publish).toHaveBeenCalledWith(queueTopology.deadExchange, queueTopology.deadRoutingKey, expect.any(Buffer), expect.any(Object), expect.any(Function));
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it("dead-letters invalid payloads without execution", async () => {
    const channel = confirmedChannel();
    const message = delivery("not-json");
    const processRun = vi.fn();

    await handleAgentRunDelivery(channel as never, message as never, processRun, vi.fn());

    expect(processRun).not.toHaveBeenCalled();
    expect(channel.publish).toHaveBeenCalledWith(queueTopology.deadExchange, queueTopology.deadRoutingKey, message.content, expect.objectContaining({ headers: expect.objectContaining({ "x-invalid-message": true }) }), expect.any(Function));
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it("requeues the original delivery when retry publication is not confirmed", async () => {
    const channel = confirmedChannel(new Error("confirm failed"));
    const message = delivery({ runId });

    await handleAgentRunDelivery(channel as never, message as never, vi.fn().mockRejectedValue(new Error("temporary")), vi.fn());

    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(message, false, true);
  });
});
