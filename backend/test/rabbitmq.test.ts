import { describe, expect, it, vi } from "vitest";
import { decodeAgentRunRequested, parseAgentRunRequested } from "../src/infrastructure/queue/agent-run-message.js";
import { publishAgentRunRequested } from "../src/infrastructure/queue/publisher.js";
import { assertRabbitTopology, queueTopology } from "../src/infrastructure/queue/rabbitmq.js";

describe("RabbitMQ topology", () => {
  it("declares durable primary, retry, and dead-letter queues", async () => {
    const channel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue(undefined),
      bindQueue: vi.fn().mockResolvedValue(undefined),
    };

    await assertRabbitTopology(channel as never);

    expect(channel.assertExchange).toHaveBeenCalledWith(queueTopology.exchange, "direct", { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith(queueTopology.runQueue, expect.objectContaining({ durable: true }));
    expect(channel.assertQueue).toHaveBeenCalledWith(queueTopology.retryQueue, expect.objectContaining({
      arguments: expect.objectContaining({ "x-dead-letter-exchange": queueTopology.exchange }),
    }));
    expect(channel.assertQueue).toHaveBeenCalledWith(queueTopology.deadQueue, { durable: true });
  });

  it("validates identifier-only agent run messages", () => {
    const runId = "a8aa8f67-39f9-4491-813b-20e81f4bda13";

    expect(decodeAgentRunRequested(Buffer.from(JSON.stringify({ runId })))).toEqual({ runId });
    expect(() => parseAgentRunRequested({ runId, task: "must not enter the queue" })).toThrow();
    expect(() => decodeAgentRunRequested(Buffer.from("not-json"))).toThrow("valid JSON");
  });

  it("publishes persistent messages and waits for their confirm", async () => {
    const runId = "a8aa8f67-39f9-4491-813b-20e81f4bda13";
    const publish = vi.fn((_exchange, _routingKey, _content, _options, confirm) => {
      confirm(undefined, {});
      return true;
    });

    await publishAgentRunRequested({ publish } as never, { runId }, { messageId: "event-1" });

    expect(publish).toHaveBeenCalledWith(
      queueTopology.exchange,
      queueTopology.runRoutingKey,
      Buffer.from(JSON.stringify({ runId })),
      expect.objectContaining({ persistent: true, type: "agent.run.requested", messageId: "event-1" }),
      expect.any(Function),
    );
  });
});
