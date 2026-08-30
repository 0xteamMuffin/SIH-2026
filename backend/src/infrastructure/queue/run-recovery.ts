import { RunStatus } from "@prisma/client";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { AGENT_RUN_RECOVERED_TOPIC } from "./agent-run-message.js";

type RecoveryTransaction = {
  agentRun: { updateMany(args: object): Promise<{ count: number }> };
  outboxEvent: { create(args: object): Promise<unknown> };
};

type RecoveryStore = {
  agentRun: { findMany(args: object): Promise<Array<{ id: string }>> };
  $transaction<T>(work: (transaction: RecoveryTransaction) => Promise<T>): Promise<T>;
};

const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, milliseconds);
  signal.addEventListener("abort", done, { once: true });
});

export async function recoverStaleRuns(store: RecoveryStore = prisma as unknown as RecoveryStore, now = new Date()) {
  const staleRuns = await store.agentRun.findMany({
    where: { status: RunStatus.RUNNING, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
    select: { id: true },
    take: env.OUTBOX_BATCH_SIZE,
  });
  let recovered = 0;
  for (const run of staleRuns) {
    const transitioned = await store.$transaction(async (transaction) => {
      const update = await transaction.agentRun.updateMany({
        where: { id: run.id, status: RunStatus.RUNNING, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        data: { status: RunStatus.PENDING, startedAt: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null },
      });
      if (update.count === 0) return false;
      await transaction.outboxEvent.create({ data: { topic: AGENT_RUN_RECOVERED_TOPIC, aggregateId: run.id, payload: { runId: run.id } } });
      return true;
    });
    if (transitioned) recovered += 1;
  }
  return { selected: staleRuns.length, recovered };
}

export async function runStaleRunRecovery(signal: AbortSignal) {
  while (!signal.aborted) {
    await wait(env.RUN_RECOVERY_POLL_INTERVAL_MS, signal);
    if (signal.aborted) break;
    try {
      const result = await recoverStaleRuns();
      if (result.recovered > 0) logger.warn(result, "Recovered stale agent runs");
    } catch (error) {
      logger.error({ error }, "Stale agent run recovery cycle failed");
    }
  }
}
