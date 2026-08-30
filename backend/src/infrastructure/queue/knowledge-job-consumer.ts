import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { decodeKnowledgeJobRequested, type KnowledgeJobRequestedMessage } from "./knowledge-job-message.js";
import { publishInvalidKnowledgeJobToDeadQueue, publishKnowledgeJobRequested } from "./publisher.js";
import { knowledgeQueueTopology } from "./rabbitmq.js";

export type ProcessKnowledgeJob = (jobId: string) => Promise<void>;
export type FailKnowledgeJob = (jobId: string, error: unknown) => Promise<void>;

function retryCount(message: ConsumeMessage) {
  const value: unknown = message.properties.headers?.["x-retry-count"];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, env.KNOWLEDGE_QUEUE_MAX_RETRIES)
    : 0;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unknown worker failure";

async function routeInvalidMessage(channel: ConfirmChannel, delivery: ConsumeMessage, error: unknown) {
  try {
    await publishInvalidKnowledgeJobToDeadQueue(channel, delivery.content, { messageId: delivery.properties.messageId, error: errorMessage(error) });
    channel.ack(delivery);
  } catch (publishError) {
    logger.error({ error: publishError }, "Failed to dead-letter invalid knowledge job message");
    channel.nack(delivery, false, true);
  }
}

export async function handleKnowledgeJobDelivery(
  channel: ConfirmChannel,
  delivery: ConsumeMessage,
  processKnowledgeJob: ProcessKnowledgeJob,
  failKnowledgeJob: FailKnowledgeJob,
) {
  let message: KnowledgeJobRequestedMessage;
  try {
    message = decodeKnowledgeJobRequested(delivery.content);
  } catch (error) {
    await routeInvalidMessage(channel, delivery, error);
    return;
  }

  try {
    await processKnowledgeJob(message.jobId);
    channel.ack(delivery);
  } catch (error) {
    const attempts = retryCount(delivery);
    try {
      if (attempts < env.KNOWLEDGE_QUEUE_MAX_RETRIES) {
        await publishKnowledgeJobRequested(channel, message, { destination: "retry", messageId: delivery.properties.messageId, retryCount: attempts + 1, error: errorMessage(error) });
      } else {
        await failKnowledgeJob(message.jobId, error);
        await publishKnowledgeJobRequested(channel, message, { destination: "dead", messageId: delivery.properties.messageId, retryCount: attempts, error: errorMessage(error) });
      }
      channel.ack(delivery);
    } catch (routingError) {
      logger.error({ error: routingError, jobId: message.jobId }, "Failed to route unsuccessful knowledge job delivery");
      channel.nack(delivery, false, true);
    }
  }
}

export async function consumeKnowledgeJobs(
  channel: ConfirmChannel,
  processKnowledgeJob: ProcessKnowledgeJob,
  failKnowledgeJob: FailKnowledgeJob,
) {
  const active = new Set<Promise<void>>();
  const consumer = await channel.consume(knowledgeQueueTopology.jobsQueue, (delivery) => {
    if (!delivery) return;
    const task = handleKnowledgeJobDelivery(channel, delivery, processKnowledgeJob, failKnowledgeJob)
      .catch((error) => logger.error({ error }, "Knowledge job delivery failed unexpectedly"))
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
