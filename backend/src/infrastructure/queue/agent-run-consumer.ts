import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { decodeAgentRunRequested, type AgentRunRequestedMessage } from "./agent-run-message.js";
import { publishAgentRunRequested, publishInvalidAgentRunToDeadQueue } from "./publisher.js";
import { queueTopology } from "./rabbitmq.js";

export type ProcessAgentRun = (runId: string) => Promise<void>;
export type FailAgentRun = (runId: string, error: unknown) => Promise<void>;

function retryCount(message: ConsumeMessage) {
  const value: unknown = message.properties.headers?.["x-retry-count"];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unknown worker failure";

async function routeInvalidMessage(channel: ConfirmChannel, delivery: ConsumeMessage, error: unknown) {
  try {
    await publishInvalidAgentRunToDeadQueue(channel, delivery.content, { messageId: delivery.properties.messageId, error: errorMessage(error) });
    channel.ack(delivery);
  } catch (publishError) {
    logger.error({ error: publishError }, "Failed to dead-letter invalid agent run message");
    channel.nack(delivery, false, true);
  }
}

export async function handleAgentRunDelivery(
  channel: ConfirmChannel,
  delivery: ConsumeMessage,
  processRun: ProcessAgentRun,
  failRun: FailAgentRun,
) {
  let message: AgentRunRequestedMessage;
  try {
    message = decodeAgentRunRequested(delivery.content);
  } catch (error) {
    await routeInvalidMessage(channel, delivery, error);
    return;
  }

  try {
    await processRun(message.runId);
    channel.ack(delivery);
  } catch (error) {
    const attempts = retryCount(delivery);
    try {
      if (attempts < env.QUEUE_MAX_RETRIES) {
        await publishAgentRunRequested(channel, message, { destination: "retry", messageId: delivery.properties.messageId, retryCount: attempts + 1, error: errorMessage(error) });
      } else {
        await failRun(message.runId, error);
        await publishAgentRunRequested(channel, message, { destination: "dead", messageId: delivery.properties.messageId, retryCount: attempts, error: errorMessage(error) });
      }
      channel.ack(delivery);
    } catch (routingError) {
      logger.error({ error: routingError, runId: message.runId }, "Failed to route unsuccessful agent run delivery");
      channel.nack(delivery, false, true);
    }
  }
}

export async function consumeAgentRuns(channel: ConfirmChannel, processRun: ProcessAgentRun, failRun: FailAgentRun) {
  const active = new Set<Promise<void>>();
  const consumer = await channel.consume(queueTopology.runQueue, (delivery) => {
    if (!delivery) return;
    const task = handleAgentRunDelivery(channel, delivery, processRun, failRun)
      .catch((error) => logger.error({ error }, "Agent run delivery failed unexpectedly"))
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
