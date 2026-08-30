import { env } from "./config/env.js";
import { consumeAgentRuns } from "./infrastructure/queue/agent-run-consumer.js";
import { consumeAgentRunCancellations } from "./infrastructure/queue/agent-run-cancellation-consumer.js";
import { consumeArtifactDeletions } from "./infrastructure/queue/artifact-deletion-consumer.js";
import { runOutboxDispatcher } from "./infrastructure/queue/outbox-dispatcher.js";
import { recoverStaleRuns, runStaleRunRecovery } from "./infrastructure/queue/run-recovery.js";
import { artifactDeletionRabbitChannel, closeRabbitMq, rabbitChannel } from "./infrastructure/queue/rabbitmq.js";
import { startKnowledgeWorker } from "./knowledge-worker.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { failRun, processRun } from "./modules/agent/agent.service.js";
import { failArtifactDeletionJob, processArtifactDeletionJob, reconcileArtifactDeletions, runArtifactDeletionReconciliation } from "./modules/artifacts/artifact-deletion.processor.js";
import { ensureActiveKnowledgeIndex } from "./modules/knowledge/knowledge-index-provisioner.js";
import { failExhaustedKnowledgeJob, processKnowledgeJob } from "./modules/knowledge/knowledge-job-dispatcher.js";

async function main() {
  await ensureActiveKnowledgeIndex();
  const channel = await rabbitChannel();
  const startupRecovery = await recoverStaleRuns();
  if (startupRecovery.recovered > 0) logger.warn(startupRecovery, "Recovered stale agent runs at startup");
  const consumer = await consumeAgentRuns(channel, processRun, failRun);
  const cancellationConsumer = await consumeAgentRunCancellations(channel, consumer.abort);
  const knowledgeConsumer = await startKnowledgeWorker(processKnowledgeJob, failExhaustedKnowledgeJob);
  const artifactRecovery = await reconcileArtifactDeletions();
  if (artifactRecovery.recovered > 0 || artifactRecovery.repaired > 0) logger.warn(artifactRecovery, "Reconciled artifact deletions at startup");
  const artifactDeletionConsumer = await consumeArtifactDeletions(await artifactDeletionRabbitChannel(), processArtifactDeletionJob, failArtifactDeletionJob);
  const dispatcherController = new AbortController();
  const dispatcher = runOutboxDispatcher(dispatcherController.signal);
  const recovery = runStaleRunRecovery(dispatcherController.signal);
  const artifactReconciliation = runArtifactDeletionReconciliation(dispatcherController.signal);
  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Worker shutting down");
    dispatcherController.abort();
    const graceful = (async () => {
      await Promise.allSettled([
        consumer.stop(),
        cancellationConsumer.stop(),
        knowledgeConsumer.stop(),
        artifactDeletionConsumer.stop(),
        dispatcher,
        recovery,
        artifactReconciliation,
      ]);
    })();
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error("Worker shutdown timed out")), env.WORKER_SHUTDOWN_TIMEOUT_MS); });
    try {
      await Promise.race([graceful, timeout]);
    } catch (error) {
      timedOut = true;
      logger.warn({ error }, "Worker stopped before active jobs drained");
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    await closeRabbitMq().catch((error) => logger.warn({ error }, "RabbitMQ shutdown failed"));
    await prisma.$disconnect();
    process.exitCode = timedOut ? 1 : exitCode;
    if (timedOut) process.exit(1);
  };

  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  channel.once("error", (error) => logger.error({ error }, "RabbitMQ worker channel error"));
  channel.once("close", () => {
    if (!shuttingDown) void shutdown("RabbitMQ channel closed", 1);
  });
  logger.info({ agentPrefetch: env.QUEUE_PREFETCH, knowledgePrefetch: env.KNOWLEDGE_QUEUE_PREFETCH }, "Worker started");
}

main().catch(async (error) => {
  logger.fatal({ error }, "Worker failed to start");
  await closeRabbitMq().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
