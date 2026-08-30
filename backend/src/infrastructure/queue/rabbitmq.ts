import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

export const queueTopology = {
  exchange: env.AGENT_QUEUE_PREFIX,
  runQueue: `${env.AGENT_QUEUE_PREFIX}.runs`,
  runRoutingKey: "run",
  retryQueue: `${env.AGENT_QUEUE_PREFIX}.retry`,
  retryRoutingKey: "retry",
  deadExchange: `${env.AGENT_QUEUE_PREFIX}.dead-letter`,
  deadQueue: `${env.AGENT_QUEUE_PREFIX}.dead`,
  deadRoutingKey: "dead",
} as const;

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;

export async function assertRabbitTopology(target: ConfirmChannel) {
  await target.assertExchange(queueTopology.exchange, "direct", { durable: true });
  await target.assertExchange(queueTopology.deadExchange, "direct", { durable: true });
  await target.assertQueue(queueTopology.runQueue, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": queueTopology.deadExchange,
      "x-dead-letter-routing-key": queueTopology.deadRoutingKey,
    },
  });
  await target.bindQueue(queueTopology.runQueue, queueTopology.exchange, queueTopology.runRoutingKey);
  await target.assertQueue(queueTopology.retryQueue, {
    durable: true,
    arguments: {
      "x-message-ttl": env.QUEUE_RETRY_DELAY_MS,
      "x-dead-letter-exchange": queueTopology.exchange,
      "x-dead-letter-routing-key": queueTopology.runRoutingKey,
    },
  });
  await target.bindQueue(queueTopology.retryQueue, queueTopology.exchange, queueTopology.retryRoutingKey);
  await target.assertQueue(queueTopology.deadQueue, { durable: true });
  await target.bindQueue(queueTopology.deadQueue, queueTopology.deadExchange, queueTopology.deadRoutingKey);
}

export async function rabbitChannel() {
  if (channel) return channel;
  connection = await connect(env.AMQP_URL);
  connection.on("error", (error) => logger.error({ error }, "RabbitMQ connection error"));
  connection.on("close", () => { connection = undefined; channel = undefined; logger.warn("RabbitMQ connection closed"); });
  channel = await connection.createConfirmChannel();
  await assertRabbitTopology(channel);
  await channel.prefetch(env.QUEUE_PREFETCH);
  return channel;
}

export async function closeRabbitMq() {
  const activeChannel = channel;
  const activeConnection = connection;
  channel = undefined;
  connection = undefined;
  if (activeChannel) await activeChannel.close();
  if (activeConnection) await activeConnection.close();
}
