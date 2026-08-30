CREATE TYPE "ModelInvocationStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "model_invocations" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "ModelInvocationStatus" NOT NULL DEFAULT 'RUNNING',
    "latency_ms" INTEGER,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "total_tokens" INTEGER,
    "finish_reason" TEXT,
    "sanitized_error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "model_invocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "model_invocations_run_id_attempt_key" ON "model_invocations"("run_id", "attempt");
CREATE INDEX "model_invocations_run_id_started_at_idx" ON "model_invocations"("run_id", "started_at");

ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_run_id_fkey"
FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
