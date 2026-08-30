import { env } from "./config/env.js";
import { consumeKnowledgeJobs, type FailKnowledgeJob, type ProcessKnowledgeJob } from "./infrastructure/queue/knowledge-job-consumer.js";
import { knowledgeRabbitChannel } from "./infrastructure/queue/rabbitmq.js";
import { logger } from "./lib/logger.js";

export async function startKnowledgeWorker(processKnowledgeJob: ProcessKnowledgeJob, failKnowledgeJob: FailKnowledgeJob) {
  const channel = await knowledgeRabbitChannel();
  const consumer = await consumeKnowledgeJobs(channel, processKnowledgeJob, failKnowledgeJob);
  logger.info({ prefetch: env.KNOWLEDGE_QUEUE_PREFETCH }, "Knowledge worker started");
  return consumer;
}
