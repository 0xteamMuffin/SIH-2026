import { describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { consumeKnowledgeJobs, handleKnowledgeJobDelivery } from "../src/infrastructure/queue/knowledge-job-consumer.js";
import { knowledgeQueueTopology } from "../src/infrastructure/queue/rabbitmq.js";

const jobId = "f06544e7-6922-4e7c-a025-3f98e934e56f";

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

describe("knowledge job consumer policy", () => {
  it("registers a manual-ack consumer on the knowledge jobs queue", async () => {
    const channel = {
      consume: vi.fn().mockResolvedValue({ consumerTag: "knowledge-worker-1" }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const consumer = await consumeKnowledgeJobs(channel as never, vi.fn(), vi.fn());

    expect(channel.consume).toHaveBeenCalledWith(knowledgeQueueTopology.jobsQueue, expect.any(Function), { noAck: false });
    await consumer.stop();
    expect(channel.cancel).toHaveBeenCalledWith("knowledge-worker-1");
  });

  it("uses manual acknowledgement after successful processing", async () => {
    const channel = confirmedChannel();
    const message = delivery({ jobId });
    const processKnowledgeJob = vi.fn().mockResolvedValue(undefined);

    await handleKnowledgeJobDelivery(channel as never, message as never, processKnowledgeJob, vi.fn());

    expect(processKnowledgeJob).toHaveBeenCalledWith(jobId);
    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it("routes bounded failures through the isolated retry queue", async () => {
    const channel = confirmedChannel();
    const message = delivery({ jobId }, 1);

    await handleKnowledgeJobDelivery(channel as never, message as never, vi.fn().mockRejectedValue(new Error("temporary")), vi.fn());

    expect(channel.publish).toHaveBeenCalledWith(
      knowledgeQueueTopology.exchange,
      knowledgeQueueTopology.retryRoutingKey,
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ "x-retry-count": 2, "x-last-error": "temporary" }) }),
      expect.any(Function),
    );
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it("marks exhausted jobs failed and routes them to the dead queue", async () => {
    const channel = confirmedChannel();
    const message = delivery({ jobId }, 3);
    const failure = new Error("still failing");
    const failKnowledgeJob = vi.fn().mockResolvedValue(undefined);

    await handleKnowledgeJobDelivery(channel as never, message as never, vi.fn().mockRejectedValue(failure), failKnowledgeJob);

    expect(failKnowledgeJob).toHaveBeenCalledWith(jobId, failure);
    expect(channel.publish).toHaveBeenCalledWith(knowledgeQueueTopology.exchange, knowledgeQueueTopology.deadRoutingKey, expect.any(Buffer), expect.any(Object), expect.any(Function));
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it("bounds untrusted retry headers at the configured maximum", async () => {
    const channel = confirmedChannel();
    const message = delivery({ jobId }, 1_000);
    const failKnowledgeJob = vi.fn().mockResolvedValue(undefined);

    await handleKnowledgeJobDelivery(channel as never, message as never, vi.fn().mockRejectedValue(new Error("failed")), failKnowledgeJob);

    expect(failKnowledgeJob).toHaveBeenCalledOnce();
    expect(channel.publish).toHaveBeenCalledWith(
      knowledgeQueueTopology.exchange,
      knowledgeQueueTopology.deadRoutingKey,
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ "x-retry-count": env.KNOWLEDGE_QUEUE_MAX_RETRIES }) }),
      expect.any(Function),
    );
  });

  it("dead-letters invalid payloads without invoking callbacks", async () => {
    const channel = confirmedChannel();
    const message = delivery({ jobId: "not-a-uuid" });
    const processKnowledgeJob = vi.fn();
    const failKnowledgeJob = vi.fn();

    await handleKnowledgeJobDelivery(channel as never, message as never, processKnowledgeJob, failKnowledgeJob);

    expect(processKnowledgeJob).not.toHaveBeenCalled();
    expect(failKnowledgeJob).not.toHaveBeenCalled();
    expect(channel.publish).toHaveBeenCalledWith(
      knowledgeQueueTopology.exchange,
      knowledgeQueueTopology.deadRoutingKey,
      message.content,
      expect.objectContaining({ headers: expect.objectContaining({ "x-invalid-message": true }) }),
      expect.any(Function),
    );
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it("requeues the original delivery when retry publication is not confirmed", async () => {
    const channel = confirmedChannel(new Error("confirm failed"));
    const message = delivery({ jobId });

    await handleKnowledgeJobDelivery(channel as never, message as never, vi.fn().mockRejectedValue(new Error("temporary")), vi.fn());

    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(message, false, true);
  });
});
