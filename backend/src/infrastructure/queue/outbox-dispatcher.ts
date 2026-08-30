import type { OutboxEvent, PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { AGENT_RUN_REQUESTED_TOPIC } from "./agent-run-message.js";
import { publishAgentRunRequested } from "./publisher.js";
import { rabbitChannel } from "./rabbitmq.js";

type OutboxStore = Pick<PrismaClient, "outboxEvent">;
type PublishOutboxEvent = (event: OutboxEvent) => Promise<void>;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unknown outbox publication failure";

export function outboxBackoffMs(attempts: number) {
  return Math.min(1_000 * 2 ** Math.min(attempts, 16), env.OUTBOX_MAX_BACKOFF_MS);
}

async function publishEvent(event: OutboxEvent) {
  const channel = await rabbitChannel();
  await publishAgentRunRequested(channel, { runId: event.aggregateId }, { messageId: event.id });
}

export async function dispatchOutboxBatch(store: OutboxStore = prisma, publish: PublishOutboxEvent = publishEvent, now = new Date()) {
  const events = await store.outboxEvent.findMany({
    where: { topic: AGENT_RUN_REQUESTED_TOPIC, publishedAt: null, availableAt: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: env.OUTBOX_BATCH_SIZE,
  });
  let published = 0;
  for (const event of events) {
    try {
      await publish(event);
      await store.outboxEvent.updateMany({ where: { id: event.id, publishedAt: null }, data: { publishedAt: new Date(), lastError: null } });
      published += 1;
    } catch (error) {
      const attempts = event.attempts + 1;
      await store.outboxEvent.updateMany({
        where: { id: event.id, publishedAt: null },
        data: { attempts, availableAt: new Date(now.getTime() + outboxBackoffMs(attempts)), lastError: errorMessage(error).slice(0, 2_000) },
      });
      logger.warn({ error, outboxEventId: event.id, attempts }, "Outbox publication deferred");
    }
  }
  return { selected: events.length, published };
}

const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, milliseconds);
  signal.addEventListener("abort", done, { once: true });
});

export async function runOutboxDispatcher(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      await dispatchOutboxBatch();
    } catch (error) {
      logger.error({ error }, "Outbox dispatch cycle failed");
    }
    if (!signal.aborted) await wait(env.OUTBOX_POLL_INTERVAL_MS, signal);
  }
}
