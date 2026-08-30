CREATE TYPE "ArtifactLifecycleStatus" AS ENUM ('ACTIVE', 'DELETING', 'DELETED');
CREATE TYPE "ArtifactDeletionJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

ALTER TABLE "artifacts"
ADD COLUMN "version_set_id" UUID,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "previous_version_id" UUID,
ADD COLUMN "lifecycle_status" "ArtifactLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "retention_until" TIMESTAMP(3),
ADD COLUMN "deletion_requested_at" TIMESTAMP(3),
ADD COLUMN "deleted_at" TIMESTAMP(3);

UPDATE "artifacts" SET "version_set_id" = "id" WHERE "version_set_id" IS NULL;
ALTER TABLE "artifacts" ALTER COLUMN "version_set_id" SET NOT NULL;

CREATE TABLE "artifact_deletion_jobs" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "status" "ArtifactDeletionJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 4,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_id" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifact_deletion_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_deletion_jobs_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "artifact_deletion_jobs_max_attempts_check" CHECK ("max_attempts" > 0)
);

ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_version_check" CHECK ("version" > 0);

CREATE UNIQUE INDEX "artifacts_previous_version_id_key" ON "artifacts"("previous_version_id");
CREATE UNIQUE INDEX "artifacts_version_set_id_version_key" ON "artifacts"("version_set_id", "version");
CREATE INDEX "artifacts_workspace_id_lifecycle_status_created_at_idx" ON "artifacts"("workspace_id", "lifecycle_status", "created_at");
CREATE UNIQUE INDEX "artifact_deletion_jobs_artifact_id_key" ON "artifact_deletion_jobs"("artifact_id");
CREATE INDEX "artifact_deletion_jobs_status_available_at_idx" ON "artifact_deletion_jobs"("status", "available_at");
CREATE INDEX "artifact_deletion_jobs_status_lease_expires_at_idx" ON "artifact_deletion_jobs"("status", "lease_expires_at");
CREATE INDEX "agent_runs_source_artifact_id_status_idx" ON "agent_runs"("source_artifact_id", "status");

ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_previous_version_id_fkey"
FOREIGN KEY ("previous_version_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_source_artifact_id_fkey"
FOREIGN KEY ("source_artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "artifact_deletion_jobs" ADD CONSTRAINT "artifact_deletion_jobs_artifact_id_fkey"
FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "artifact_deletion_jobs" ADD CONSTRAINT "artifact_deletion_jobs_requested_by_fkey"
FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
