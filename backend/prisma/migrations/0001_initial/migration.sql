-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'OPERATOR', 'REVIEWER');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('SOURCE', 'GENERATED_DOCX', 'CODE_OUTPUT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OPERATOR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OPERATOR',

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "task" TEXT NOT NULL,
    "task_capability" TEXT NOT NULL,
    "model_profile" TEXT NOT NULL,
    "model_reason" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "state" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "active_workspace_id" UUID,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_messages" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "turn" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_tool_calls" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "model_tool_call_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotency_key" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "run_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "artifact_id" UUID,
    "source_ref" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "workspace_id" UUID,
    "run_id" UUID,
    "event_type" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_object_key_key" ON "artifacts"("object_key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_active_workspace_id_key" ON "agent_runs"("active_workspace_id");

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_created_at_idx" ON "agent_runs"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "run_tool_calls_run_id_model_tool_call_id_key" ON "run_tool_calls"("run_id", "model_tool_call_id");

-- CreateIndex
CREATE UNIQUE INDEX "run_tool_calls_run_id_idempotency_key_key" ON "run_tool_calls"("run_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "audit_events_workspace_id_created_at_idx" ON "audit_events"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_tool_calls" ADD CONSTRAINT "run_tool_calls_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

