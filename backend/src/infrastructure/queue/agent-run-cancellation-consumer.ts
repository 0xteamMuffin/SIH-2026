import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { logger } from "../../lib/logger.js";
import { decodeAgentRunCancelled } from "./agent-run-message.js";
import { queueTopology } from "./rabbitmq.js";

export type AbortAgentRun = (runId: string) => void;

export function handleAgentRunCancellationDelivery(channel: ConfirmChannel, delivery: ConsumeMessage, abortRun: AbortAgentRun) {
  try {
    abortRun(decodeAgentRunCancelled(delivery.content).runId);
  } catch (error) {
    logger.warn({ error }, "Ignored invalid agent run cancellation message");
  } finally {
    channel.ack(delivery);
  }
}

export async function consumeAgentRunCancellations(channel: ConfirmChannel, abortRun: AbortAgentRun) {
  const queue = await channel.assertQueue("", { durable: false, exclusive: true, autoDelete: true });
  await channel.bindQueue(queue.queue, queueTopology.controlExchange, "");
  const consumer = await channel.consume(queue.queue, (delivery) => {
    if (delivery) handleAgentRunCancellationDelivery(channel, delivery, abortRun);
  }, { noAck: false });

  return {
    async stop() {
      await channel.cancel(consumer.consumerTag);
    },
  };
}
