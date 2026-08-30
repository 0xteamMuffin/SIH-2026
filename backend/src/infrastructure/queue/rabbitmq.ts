import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

export const queueTopology = {
  exchange: env.AGENT_QUEUE_PREFIX,
  runQueue: `${env.AGENT_QUEUE_PREFIX}.runs`,
  runRoutingKey: "run",
  retryQueue: `${env.AGENT_QUEUE_PREFIX}.retry`,
  retryRoutingKey: "retry",
  controlExchange: `${env.AGENT_QUEUE_PREFIX}.control`,
  deadExchange: `${env.AGENT_QUEUE_PREFIX}.dead-letter`,
  deadQueue: `${env.AGENT_QUEUE_PREFIX}.dead`,
  deadRoutingKey: "dead",
} as const;

export const knowledgeQueueTopology = {
  exchange: "workbench.knowledge",
  jobsQueue: "workbench.knowledge.jobs",
  jobsRoutingKey: "jobs",
  retryQueue: "workbench.knowledge.retry",
  retryRoutingKey: "retry",
  deadQueue: "workbench.knowledge.dead",
  deadRoutingKey: "dead",
} as const;

export const artifactDeletionQueueTopology = {
  exchange: "workbench.artifacts",
  jobsQueue: "workbench.artifacts.deletions",
  jobsRoutingKey: "deletions",
  retryQueue: "workbench.artifacts.deletions.retry",
  retryRoutingKey: "deletions.retry",
  deadQueue: "workbench.artifacts.deletions.dead",
  deadRoutingKey: "deletions.dead",
} as const;

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;
let knowledgeChannel: ConfirmChannel | undefined;
let artifactDeletionChannel: ConfirmChannel | undefined;

export async function assertRabbitTopology(target: ConfirmChannel) {
  await target.assertExchange(queueTopology.exchange, "direct", { durable: true });
  await target.assertExchange(queueTopology.deadExchange, "direct", { durable: true });
  await target.assertExchange(queueTopology.controlExchange, "fanout", { durable: true });
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

export async function assertKnowledgeRabbitTopology(target: ConfirmChannel) {
  await target.assertExchange(knowledgeQueueTopology.exchange, "direct", { durable: true });
  await target.assertQueue(knowledgeQueueTopology.jobsQueue, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": knowledgeQueueTopology.exchange,
      "x-dead-letter-routing-key": knowledgeQueueTopology.deadRoutingKey,
    },
  });
  await target.bindQueue(knowledgeQueueTopology.jobsQueue, knowledgeQueueTopology.exchange, knowledgeQueueTopology.jobsRoutingKey);
  await target.assertQueue(knowledgeQueueTopology.retryQueue, {
    durable: true,
    arguments: {
      "x-message-ttl": env.KNOWLEDGE_QUEUE_RETRY_DELAY_MS,
      "x-dead-letter-exchange": knowledgeQueueTopology.exchange,
      "x-dead-letter-routing-key": knowledgeQueueTopology.jobsRoutingKey,
    },
  });
  await target.bindQueue(knowledgeQueueTopology.retryQueue, knowledgeQueueTopology.exchange, knowledgeQueueTopology.retryRoutingKey);
  await target.assertQueue(knowledgeQueueTopology.deadQueue, { durable: true });
  await target.bindQueue(knowledgeQueueTopology.deadQueue, knowledgeQueueTopology.exchange, knowledgeQueueTopology.deadRoutingKey);
}

export async function assertArtifactDeletionRabbitTopology(target: ConfirmChannel) {
  await target.assertExchange(artifactDeletionQueueTopology.exchange, "direct", { durable: true });
  await target.assertQueue(artifactDeletionQueueTopology.jobsQueue, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": artifactDeletionQueueTopology.exchange,
      "x-dead-letter-routing-key": artifactDeletionQueueTopology.deadRoutingKey,
    },
  });
  await target.bindQueue(artifactDeletionQueueTopology.jobsQueue, artifactDeletionQueueTopology.exchange, artifactDeletionQueueTopology.jobsRoutingKey);
  await target.assertQueue(artifactDeletionQueueTopology.retryQueue, {
    durable: true,
    arguments: {
      "x-message-ttl": env.KNOWLEDGE_QUEUE_RETRY_DELAY_MS,
      "x-dead-letter-exchange": artifactDeletionQueueTopology.exchange,
      "x-dead-letter-routing-key": artifactDeletionQueueTopology.jobsRoutingKey,
    },
  });
  await target.bindQueue(artifactDeletionQueueTopology.retryQueue, artifactDeletionQueueTopology.exchange, artifactDeletionQueueTopology.retryRoutingKey);
  await target.assertQueue(artifactDeletionQueueTopology.deadQueue, { durable: true });
  await target.bindQueue(artifactDeletionQueueTopology.deadQueue, artifactDeletionQueueTopology.exchange, artifactDeletionQueueTopology.deadRoutingKey);
}

async function rabbitConnection() {
  if (connection) return connection;
  connection = await connect(env.AMQP_URL);
  connection.on("error", (error) => logger.error({ error }, "RabbitMQ connection error"));
  connection.on("close", () => {
    connection = undefined;
    channel = undefined;
    knowledgeChannel = undefined;
    artifactDeletionChannel = undefined;
    logger.warn("RabbitMQ connection closed");
  });
  return connection;
}

export async function rabbitChannel() {
  if (channel) return channel;
  channel = await (await rabbitConnection()).createConfirmChannel();
  await assertRabbitTopology(channel);
  await channel.prefetch(env.QUEUE_PREFETCH);
  return channel;
}

export async function knowledgeRabbitChannel() {
  if (knowledgeChannel) return knowledgeChannel;
  knowledgeChannel = await (await rabbitConnection()).createConfirmChannel();
  await assertKnowledgeRabbitTopology(knowledgeChannel);
  await knowledgeChannel.prefetch(env.KNOWLEDGE_QUEUE_PREFETCH);
  return knowledgeChannel;
}

export async function artifactDeletionRabbitChannel() {
  if (artifactDeletionChannel) return artifactDeletionChannel;
  artifactDeletionChannel = await (await rabbitConnection()).createConfirmChannel();
  await assertArtifactDeletionRabbitTopology(artifactDeletionChannel);
  await artifactDeletionChannel.prefetch(env.KNOWLEDGE_QUEUE_PREFETCH);
  return artifactDeletionChannel;
}

export async function closeRabbitMq() {
  const activeChannel = channel;
  const activeKnowledgeChannel = knowledgeChannel;
  const activeArtifactDeletionChannel = artifactDeletionChannel;
  const activeConnection = connection;
  channel = undefined;
  knowledgeChannel = undefined;
  artifactDeletionChannel = undefined;
  connection = undefined;
  if (activeChannel) await activeChannel.close();
  if (activeKnowledgeChannel) await activeKnowledgeChannel.close();
  if (activeArtifactDeletionChannel) await activeArtifactDeletionChannel.close();
  if (activeConnection) await activeConnection.close();
}
