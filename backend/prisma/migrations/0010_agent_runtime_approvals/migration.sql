ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'WAITING_APPROVAL' AFTER 'RUNNING';

CREATE TYPE "RunToolCallStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED');
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "ToolRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "EvidenceKind" AS ENUM ('SOURCE', 'MODEL_OUTPUT');

ALTER TABLE "agent_runs"
ADD COLUMN "max_turns" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN "max_tool_calls" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN "deadline_at" TIMESTAMP(3);

UPDATE "agent_runs"
SET "deadline_at" = CASE
  WHEN "status" IN ('PENDING', 'RUNNING') THEN CURRENT_TIMESTAMP + INTERVAL '15 minutes'
  ELSE COALESCE("completed_at", "started_at", "created_at") + INTERVAL '15 minutes'
END
WHERE "deadline_at" IS NULL;

ALTER TABLE "agent_runs" ALTER COLUMN "deadline_at" SET NOT NULL;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_max_turns_check" CHECK ("max_turns" > 0);
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_max_tool_calls_check" CHECK ("max_tool_calls" > 0);

ALTER TABLE "run_tool_calls" ADD COLUMN "risk_level" "ToolRiskLevel" NOT NULL DEFAULT 'LOW';
ALTER TABLE "run_tool_calls" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "run_tool_calls" ALTER COLUMN "status" TYPE "RunToolCallStatus" USING (
  CASE
    WHEN "status" = 'RUNNING' THEN 'RUNNING'::"RunToolCallStatus"
    WHEN "status" = 'COMPLETED' THEN 'COMPLETED'::"RunToolCallStatus"
    WHEN "status" = 'FAILED' THEN 'FAILED'::"RunToolCallStatus"
    WHEN "status" = 'WAITING_APPROVAL' THEN 'WAITING_APPROVAL'::"RunToolCallStatus"
    WHEN "status" = 'REJECTED' THEN 'REJECTED'::"RunToolCallStatus"
    WHEN "status" = 'CANCELLED' THEN 'CANCELLED'::"RunToolCallStatus"
    ELSE 'PENDING'::"RunToolCallStatus"
  END
);
ALTER TABLE "run_tool_calls" ALTER COLUMN "status" SET DEFAULT 'PENDING';

ALTER TABLE "evidence" ADD COLUMN "kind" "EvidenceKind" NOT NULL DEFAULT 'SOURCE';
UPDATE "evidence" SET "kind" = 'MODEL_OUTPUT' WHERE "artifact_id" IS NULL OR "source_ref" = 'model-analysis';

CREATE TABLE "tool_approvals" (
  "id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "tool_call_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "tool_name" TEXT NOT NULL,
  "tool_input" JSONB NOT NULL,
  "risk_level" "ToolRiskLevel" NOT NULL,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by" UUID,
  "decision_note" TEXT,
  "decided_at" TIMESTAMP(3),
  CONSTRAINT "tool_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_approvals_decision_check" CHECK (
    ("status" = 'PENDING' AND "decided_by" IS NULL AND "decided_at" IS NULL)
    OR ("status" <> 'PENDING' AND ("status" = 'CANCELLED' OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)))
  )
);

CREATE UNIQUE INDEX "tool_approvals_tool_call_id_key" ON "tool_approvals"("tool_call_id");
CREATE INDEX "tool_approvals_workspace_id_status_requested_at_idx" ON "tool_approvals"("workspace_id", "status", "requested_at");
CREATE INDEX "tool_approvals_run_id_status_idx" ON "tool_approvals"("run_id", "status");

ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "run_tool_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION prevent_tool_approval_target_update() RETURNS trigger AS $$
BEGIN
  IF NEW."run_id" IS DISTINCT FROM OLD."run_id"
    OR NEW."tool_call_id" IS DISTINCT FROM OLD."tool_call_id"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."tool_name" IS DISTINCT FROM OLD."tool_name"
    OR NEW."tool_input" IS DISTINCT FROM OLD."tool_input"
    OR NEW."risk_level" IS DISTINCT FROM OLD."risk_level" THEN
    RAISE EXCEPTION 'tool approval target is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tool_approvals_immutable_target"
BEFORE UPDATE ON "tool_approvals"
FOR EACH ROW EXECUTE FUNCTION prevent_tool_approval_target_update();
