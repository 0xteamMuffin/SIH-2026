import type { ConfirmChannel, Options } from "amqplib";
import { AGENT_RUN_CANCELLED_TOPIC, AGENT_RUN_REQUESTED_TOPIC, parseAgentRunCancelled, parseAgentRunRequested, type AgentRunCancelledMessage, type AgentRunRequestedMessage } from "./agent-run-message.js";
import { KNOWLEDGE_JOB_REQUESTED_TOPIC, parseKnowledgeJobRequested, type KnowledgeJobRequestedMessage } from "./knowledge-job-message.js";
import { knowledgeQueueTopology, queueTopology } from "./rabbitmq.js";

export type AgentRunDestination = "run" | "retry" | "dead";
export type KnowledgeJobDestination = "jobs" | "retry" | "dead";

function confirmedPublish(channel: ConfirmChannel, exchange: string, routingKey: string, content: Buffer, options: Options.Publish) {
  return new Promise<void>((resolve, reject) => {
    channel.publish(exchange, routingKey, content, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function publishAgentRunRequested(
  channel: ConfirmChannel,
  message: AgentRunRequestedMessage,
  options: { destination?: AgentRunDestination; messageId?: string; retryCount?: number; error?: string } = {},
) {
  const validated = parseAgentRunRequested(message);
  const destination = options.destination ?? "run";
  const exchange = destination === "dead" ? queueTopology.deadExchange : queueTopology.exchange;
  const routingKey = destination === "run"
    ? queueTopology.runRoutingKey
    : destination === "retry" ? queueTopology.retryRoutingKey : queueTopology.deadRoutingKey;
  const publishOptions: Options.Publish = {
    persistent: true,
    contentType: "application/json",
    type: AGENT_RUN_REQUESTED_TOPIC,
    messageId: options.messageId,
    headers: {
      ...(options.retryCount === undefined ? {} : { "x-retry-count": options.retryCount }),
      ...(options.error === undefined ? {} : { "x-last-error": options.error.slice(0, 512) }),
    },
  };

  await confirmedPublish(channel, exchange, routingKey, Buffer.from(JSON.stringify(validated)), publishOptions);
}

export async function publishInvalidAgentRunToDeadQueue(channel: ConfirmChannel, content: Buffer, options: { messageId?: string; error: string }) {
  await confirmedPublish(channel, queueTopology.deadExchange, queueTopology.deadRoutingKey, content, {
    persistent: true,
    contentType: "application/json",
    type: AGENT_RUN_REQUESTED_TOPIC,
    messageId: options.messageId,
    headers: { "x-invalid-message": true, "x-last-error": options.error.slice(0, 512) },
  });
}

export async function publishAgentRunCancelled(channel: ConfirmChannel, message: AgentRunCancelledMessage, options: { messageId?: string } = {}) {
  const validated = parseAgentRunCancelled(message);
  await confirmedPublish(channel, queueTopology.controlExchange, "", Buffer.from(JSON.stringify(validated)), {
    persistent: true,
    contentType: "application/json",
    type: AGENT_RUN_CANCELLED_TOPIC,
    messageId: options.messageId,
  });
}

export async function publishKnowledgeJobRequested(
  channel: ConfirmChannel,
  message: KnowledgeJobRequestedMessage,
  options: { destination?: KnowledgeJobDestination; messageId?: string; retryCount?: number; error?: string } = {},
) {
  const validated = parseKnowledgeJobRequested(message);
  const destination = options.destination ?? "jobs";
  const routingKey = destination === "jobs"
    ? knowledgeQueueTopology.jobsRoutingKey
    : destination === "retry" ? knowledgeQueueTopology.retryRoutingKey : knowledgeQueueTopology.deadRoutingKey;
  await confirmedPublish(channel, knowledgeQueueTopology.exchange, routingKey, Buffer.from(JSON.stringify(validated)), {
    persistent: true,
    contentType: "application/json",
    type: KNOWLEDGE_JOB_REQUESTED_TOPIC,
    messageId: options.messageId,
    headers: {
      ...(options.retryCount === undefined ? {} : { "x-retry-count": options.retryCount }),
      ...(options.error === undefined ? {} : { "x-last-error": options.error.slice(0, 512) }),
    },
  });
}

export async function publishInvalidKnowledgeJobToDeadQueue(channel: ConfirmChannel, content: Buffer, options: { messageId?: string; error: string }) {
  await confirmedPublish(channel, knowledgeQueueTopology.exchange, knowledgeQueueTopology.deadRoutingKey, content, {
    persistent: true,
    contentType: "application/json",
    type: KNOWLEDGE_JOB_REQUESTED_TOPIC,
    messageId: options.messageId,
    headers: { "x-invalid-message": true, "x-last-error": options.error.slice(0, 512) },
  });
}
