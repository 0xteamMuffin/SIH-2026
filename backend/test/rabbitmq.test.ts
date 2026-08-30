import { describe, expect, it, vi } from "vitest";
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
});
