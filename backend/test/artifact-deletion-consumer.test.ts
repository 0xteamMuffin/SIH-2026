import { describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { handleArtifactDeletionDelivery } from "../src/infrastructure/queue/artifact-deletion-consumer.js";
import { artifactDeletionQueueTopology } from "../src/infrastructure/queue/rabbitmq.js";

const deletionJobId = "40000000-0000-4000-8000-000000000001";

function delivery(body: unknown, retryCount?: number) {
  return {
    content: Buffer.from(JSON.stringify(body)),
    properties: { messageId: "event-1", headers: retryCount === undefined ? {} : { "x-retry-count": retryCount } },
  };
}

function channel() {
  return {
    ack: vi.fn(),
    nack: vi.fn(),
    publish: vi.fn((_exchange, _routingKey, _content, _options, confirm) => { confirm(undefined, {}); return true; }),
  };
}

describe("artifact deletion consumer", () => {
  it("acknowledges only after successful processing", async () => {
    const target = channel();
    const message = delivery({ deletionJobId });
    const processDeletion = vi.fn().mockResolvedValue(undefined);

    await handleArtifactDeletionDelivery(target as never, message as never, processDeletion, vi.fn());

    expect(processDeletion).toHaveBeenCalledWith(deletionJobId);
    expect(target.ack).toHaveBeenCalledWith(message);
  });

  it("routes transient failures through the durable retry queue", async () => {
    const target = channel();
    const message = delivery({ deletionJobId }, 1);

    await handleArtifactDeletionDelivery(target as never, message as never, vi.fn().mockRejectedValue(new Error("MinIO unavailable")), vi.fn());

    expect(target.publish).toHaveBeenCalledWith(
      artifactDeletionQueueTopology.exchange,
      artifactDeletionQueueTopology.retryRoutingKey,
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ "x-retry-count": 2 }) }),
      expect.any(Function),
    );
    expect(target.ack).toHaveBeenCalledWith(message);
  });

  it("marks an exhausted job failed before dead-lettering", async () => {
    const target = channel();
    const message = delivery({ deletionJobId }, env.KNOWLEDGE_QUEUE_MAX_RETRIES);
    const failure = new Error("still unavailable");
    const failDeletion = vi.fn().mockResolvedValue(undefined);

    await handleArtifactDeletionDelivery(target as never, message as never, vi.fn().mockRejectedValue(failure), failDeletion);

    expect(failDeletion).toHaveBeenCalledWith(deletionJobId, failure);
    expect(target.publish).toHaveBeenCalledWith(artifactDeletionQueueTopology.exchange, artifactDeletionQueueTopology.deadRoutingKey, expect.any(Buffer), expect.any(Object), expect.any(Function));
  });
});
