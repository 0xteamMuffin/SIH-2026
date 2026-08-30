import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { decodeArtifactDeletionRequested } from "./artifact-deletion-message.js";
import { publishArtifactDeletionRequested, publishInvalidArtifactDeletionToDeadQueue } from "./publisher.js";
import { artifactDeletionQueueTopology } from "./rabbitmq.js";

export type ProcessArtifactDeletion = (jobId: string) => Promise<void>;
export type FailArtifactDeletion = (jobId: string, error: unknown) => Promise<void>;

function retryCount(message: ConsumeMessage): number {
  const value: unknown = message.properties.headers?.["x-retry-count"];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, env.KNOWLEDGE_QUEUE_MAX_RETRIES)
    : 0;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unknown artifact deletion failure";

export async function handleArtifactDeletionDelivery(
  channel: ConfirmChannel,
  delivery: ConsumeMessage,
  processDeletion: ProcessArtifactDeletion,
  failDeletion: FailArtifactDeletion,
): Promise<void> {
  let message;
  try {
    message = decodeArtifactDeletionRequested(delivery.content);
  } catch (error) {
    try {
      await publishInvalidArtifactDeletionToDeadQueue(channel, delivery.content, { messageId: delivery.properties.messageId, error: errorMessage(error) });
      channel.ack(delivery);
    } catch (publishError) {
      logger.error({ error: publishError }, "Failed to dead-letter invalid artifact deletion message");
      channel.nack(delivery, false, true);
    }
    return;
  }

  try {
    await processDeletion(message.deletionJobId);
    channel.ack(delivery);
  } catch (error) {
    const attempts = retryCount(delivery);
    try {
      if (attempts < env.KNOWLEDGE_QUEUE_MAX_RETRIES) {
        await publishArtifactDeletionRequested(channel, message, { destination: "retry", messageId: delivery.properties.messageId, retryCount: attempts + 1, error: errorMessage(error) });
      } else {
        await failDeletion(message.deletionJobId, error);
        await publishArtifactDeletionRequested(channel, message, { destination: "dead", messageId: delivery.properties.messageId, retryCount: attempts, error: errorMessage(error) });
      }
      channel.ack(delivery);
    } catch (routingError) {
      logger.error({ error: routingError, deletionJobId: message.deletionJobId }, "Failed to route unsuccessful artifact deletion delivery");
      channel.nack(delivery, false, true);
    }
  }
}

export async function consumeArtifactDeletions(
  channel: ConfirmChannel,
  processDeletion: ProcessArtifactDeletion,
  failDeletion: FailArtifactDeletion,
) {
  const active = new Set<Promise<void>>();
  const consumer = await channel.consume(artifactDeletionQueueTopology.jobsQueue, (delivery) => {
    if (!delivery) return;
    const task = handleArtifactDeletionDelivery(channel, delivery, processDeletion, failDeletion)
      .catch((error) => logger.error({ error }, "Artifact deletion delivery failed unexpectedly"))
      .finally(() => active.delete(task));
    active.add(task);
  }, { noAck: false });
  return {
    async stop() {
      await channel.cancel(consumer.consumerTag);
      await Promise.allSettled([...active]);
    },
  };
}
