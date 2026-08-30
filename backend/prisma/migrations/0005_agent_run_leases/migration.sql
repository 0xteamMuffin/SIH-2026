ALTER TABLE "agent_runs"
ADD COLUMN "lease_id" UUID,
ADD COLUMN "heartbeat_at" TIMESTAMP(3),
ADD COLUMN "lease_expires_at" TIMESTAMP(3);

CREATE INDEX "agent_runs_status_lease_expires_at_idx" ON "agent_runs"("status", "lease_expires_at");

DROP INDEX "outbox_events_topic_aggregate_id_key";
