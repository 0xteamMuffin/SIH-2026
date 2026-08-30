import { describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { decodeAgentRunRequested, parseAgentRunRequested } from "../src/infrastructure/queue/agent-run-message.js";
import { decodeKnowledgeJobRequested, parseKnowledgeJobRequested } from "../src/infrastructure/queue/knowledge-job-message.js";
import { publishAgentRunCancelled, publishAgentRunRequested, publishKnowledgeJobRequested } from "../src/infrastructure/queue/publisher.js";
import { assertKnowledgeRabbitTopology, assertRabbitTopology, knowledgeQueueTopology, queueTopology } from "../src/infrastructure/queue/rabbitmq.js";

describe("RabbitMQ topology", () => {
  it("declares durable primary, retry, and dead-letter queues", async () => {
    const channel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue(undefined),
      bindQueue: vi.fn().mockResolvedValue(undefined),
    };

    await assertRabbitTopology(channel as never);

    expect(channel.assertExchange).toHaveBeenCalledWith(queueTopology.exchange, "direct", { durable: true });
    expect(channel.assertExchange).toHaveBeenCalledWith(queueTopology.controlExchange, "fanout", { durable: true });
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

  it("broadcasts persistent cancellation control messages", async () => {
    const runId = "a8aa8f67-39f9-4491-813b-20e81f4bda13";
    const publish = vi.fn((_exchange, _routingKey, _content, _options, confirm) => {
      confirm(undefined, {});
      return true;
    });

    await publishAgentRunCancelled({ publish } as never, { runId }, { messageId: "cancel-1" });

    expect(publish).toHaveBeenCalledWith(
      queueTopology.controlExchange,
      "",
      Buffer.from(JSON.stringify({ runId })),
      expect.objectContaining({ persistent: true, type: "agent.run.cancelled", messageId: "cancel-1" }),
      expect.any(Function),
    );
  });

  it("declares an isolated durable knowledge topology", async () => {
    const channel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue(undefined),
      bindQueue: vi.fn().mockResolvedValue(undefined),
    };

    await assertKnowledgeRabbitTopology(channel as never);

    expect(channel.assertExchange).toHaveBeenCalledOnce();
    expect(channel.assertExchange).toHaveBeenCalledWith("workbench.knowledge", "direct", { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith(knowledgeQueueTopology.jobsQueue, expect.objectContaining({
      durable: true,
      arguments: expect.objectContaining({ "x-dead-letter-exchange": knowledgeQueueTopology.exchange, "x-dead-letter-routing-key": knowledgeQueueTopology.deadRoutingKey }),
    }));
    expect(channel.assertQueue).toHaveBeenCalledWith(knowledgeQueueTopology.retryQueue, expect.objectContaining({
      durable: true,
      arguments: expect.objectContaining({ "x-message-ttl": env.KNOWLEDGE_QUEUE_RETRY_DELAY_MS, "x-dead-letter-routing-key": knowledgeQueueTopology.jobsRoutingKey }),
    }));
    expect(channel.assertQueue).toHaveBeenCalledWith(knowledgeQueueTopology.deadQueue, { durable: true });
  });

  it("validates and publishes identifier-only knowledge jobs", async () => {
    const jobId = "f06544e7-6922-4e7c-a025-3f98e934e56f";
    const publish = vi.fn((_exchange, _routingKey, _content, _options, confirm) => {
      confirm(undefined, {});
      return true;
    });

    expect(decodeKnowledgeJobRequested(Buffer.from(JSON.stringify({ jobId })))).toEqual({ jobId });
    expect(() => parseKnowledgeJobRequested({ jobId, document: "must not enter the queue" })).toThrow();
    await publishKnowledgeJobRequested({ publish } as never, { jobId }, { messageId: "event-2" });

    expect(publish).toHaveBeenCalledWith(
      knowledgeQueueTopology.exchange,
      knowledgeQueueTopology.jobsRoutingKey,
      Buffer.from(JSON.stringify({ jobId })),
      expect.objectContaining({ persistent: true, type: "knowledge.job.requested", messageId: "event-2" }),
      expect.any(Function),
    );
  });
});
