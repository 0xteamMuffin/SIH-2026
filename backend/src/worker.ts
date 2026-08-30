import { env } from "./config/env.js";
import { consumeAgentRuns } from "./infrastructure/queue/agent-run-consumer.js";
import { consumeAgentRunCancellations } from "./infrastructure/queue/agent-run-cancellation-consumer.js";
import { runOutboxDispatcher } from "./infrastructure/queue/outbox-dispatcher.js";
import { recoverStaleRuns, runStaleRunRecovery } from "./infrastructure/queue/run-recovery.js";
import { closeRabbitMq, rabbitChannel } from "./infrastructure/queue/rabbitmq.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { failRun, processRun } from "./modules/agent/agent.service.js";

async function main() {
  const channel = await rabbitChannel();
  const startupRecovery = await recoverStaleRuns();
  if (startupRecovery.recovered > 0) logger.warn(startupRecovery, "Recovered stale agent runs at startup");
  const consumer = await consumeAgentRuns(channel, processRun, failRun);
  const cancellationConsumer = await consumeAgentRunCancellations(channel, consumer.abort);
  const dispatcherController = new AbortController();
  const dispatcher = runOutboxDispatcher(dispatcherController.signal);
  const recovery = runStaleRunRecovery(dispatcherController.signal);
  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Worker shutting down");
    dispatcherController.abort();
    const graceful = (async () => {
      await consumer.stop();
      await cancellationConsumer.stop();
      await Promise.allSettled([dispatcher, recovery]);
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
  logger.info({ prefetch: env.QUEUE_PREFETCH }, "Agent worker started");
}

main().catch(async (error) => {
  logger.fatal({ error }, "Worker failed to start");
  await closeRabbitMq().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
