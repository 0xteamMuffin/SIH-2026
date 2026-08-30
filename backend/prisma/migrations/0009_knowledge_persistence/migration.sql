CREATE TYPE "KnowledgeVisibility" AS ENUM ('WORKSPACE_PRIVATE', 'ORGANIZATION_SHARED');
CREATE TYPE "KnowledgeSourceStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETING', 'DELETED');
CREATE TYPE "KnowledgeIndexStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'RETIRING', 'RETIRED', 'DELETING', 'DELETED', 'FAILED');
CREATE TYPE "KnowledgeSourceIndexStatus" AS ENUM ('PENDING', 'INDEXING', 'READY', 'STALE', 'REMOVING', 'REMOVED', 'FAILED');
CREATE TYPE "KnowledgeJobType" AS ENUM ('INDEX_SOURCE', 'REMOVE_SOURCE', 'REBUILD_INDEX', 'EXECUTE_QUERY', 'RECONCILE_INDEX');
CREATE TYPE "KnowledgeJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "KnowledgeQueryStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "EmbeddingPurpose" AS ENUM ('INDEX', 'QUERY');
CREATE TYPE "EmbeddingInvocationStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "KnowledgeVectorDistance" AS ENUM ('COSINE', 'EUCLID', 'DOT', 'MANHATTAN');

CREATE TABLE "knowledge_sources" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "visibility" "KnowledgeVisibility" NOT NULL DEFAULT 'WORKSPACE_PRIVATE',
    "status" "KnowledgeSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_sources_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "knowledge_indexes" (
    "id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "collection_name" TEXT NOT NULL,
    "vector_name" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "distance" "KnowledgeVectorDistance" NOT NULL,
    "chunker_version" TEXT NOT NULL,
    "status" "KnowledgeIndexStatus" NOT NULL DEFAULT 'PROVISIONING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "activated_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "knowledge_indexes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_indexes_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "knowledge_indexes_dimensions_check" CHECK ("dimensions" > 0)
);

CREATE TABLE "knowledge_source_indexes" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "index_id" UUID NOT NULL,
    "source_revision" INTEGER NOT NULL,
    "index_revision" INTEGER NOT NULL,
    "status" "KnowledgeSourceIndexStatus" NOT NULL DEFAULT 'PENDING',
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "source_checksum" TEXT,
    "chunk_set_checksum" TEXT,
    "lease_id" UUID,
    "heartbeat_at" TIMESTAMP(3),
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "indexed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_source_indexes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_source_indexes_source_revision_check" CHECK ("source_revision" > 0),
    CONSTRAINT "knowledge_source_indexes_index_revision_check" CHECK ("index_revision" > 0),
    CONSTRAINT "knowledge_source_indexes_chunk_count_check" CHECK ("chunk_count" >= 0)
);

CREATE TABLE "knowledge_queries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "index_id" UUID NOT NULL,
    "index_revision" INTEGER NOT NULL,
    "data_classification" "DataClassification" NOT NULL DEFAULT 'INTERNAL',
    "status" "KnowledgeQueryStatus" NOT NULL DEFAULT 'QUEUED',
    "query_text" TEXT NOT NULL,
    "top_k" INTEGER NOT NULL DEFAULT 10,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_queries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_queries_index_revision_check" CHECK ("index_revision" > 0),
    CONSTRAINT "knowledge_queries_top_k_check" CHECK ("top_k" > 0)
);

CREATE TABLE "knowledge_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "index_id" UUID NOT NULL,
    "source_index_id" UUID,
    "query_id" UUID,
    "type" "KnowledgeJobType" NOT NULL,
    "status" "KnowledgeJobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotency_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_id" UUID,
    "heartbeat_at" TIMESTAMP(3),
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_jobs_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "knowledge_jobs_max_attempts_check" CHECK ("max_attempts" > 0),
    CONSTRAINT "knowledge_jobs_reference_check" CHECK (
        ("type" IN ('INDEX_SOURCE', 'REMOVE_SOURCE') AND "source_index_id" IS NOT NULL AND "query_id" IS NULL)
        OR ("type" = 'EXECUTE_QUERY' AND "source_index_id" IS NULL AND "query_id" IS NOT NULL)
        OR ("type" IN ('REBUILD_INDEX', 'RECONCILE_INDEX') AND "source_index_id" IS NULL AND "query_id" IS NULL)
    )
);

CREATE TABLE "embedding_invocations" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "index_id" UUID NOT NULL,
    "source_index_id" UUID,
    "query_id" UUID,
    "purpose" "EmbeddingPurpose" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "batch" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "EmbeddingInvocationStatus" NOT NULL DEFAULT 'RUNNING',
    "input_count" INTEGER NOT NULL,
    "input_characters" INTEGER NOT NULL,
    "input_tokens" INTEGER,
    "dimensions" INTEGER NOT NULL,
    "latency_ms" INTEGER,
    "sanitized_error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "embedding_invocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "embedding_invocations_batch_check" CHECK ("batch" >= 0),
    CONSTRAINT "embedding_invocations_attempt_check" CHECK ("attempt" > 0),
    CONSTRAINT "embedding_invocations_input_count_check" CHECK ("input_count" > 0),
    CONSTRAINT "embedding_invocations_input_characters_check" CHECK ("input_characters" >= 0),
    CONSTRAINT "embedding_invocations_input_tokens_check" CHECK ("input_tokens" IS NULL OR "input_tokens" >= 0),
    CONSTRAINT "embedding_invocations_dimensions_check" CHECK ("dimensions" > 0),
    CONSTRAINT "embedding_invocations_latency_check" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0),
    CONSTRAINT "embedding_invocations_reference_check" CHECK (
        ("purpose" = 'INDEX' AND "source_index_id" IS NOT NULL AND "query_id" IS NULL)
        OR ("purpose" = 'QUERY' AND "source_index_id" IS NULL AND "query_id" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "knowledge_sources_artifact_id_key" ON "knowledge_sources"("artifact_id");
CREATE INDEX "knowledge_sources_workspace_id_visibility_status_idx" ON "knowledge_sources"("workspace_id", "visibility", "status");

CREATE UNIQUE INDEX "knowledge_indexes_fingerprint_key" ON "knowledge_indexes"("fingerprint");
CREATE UNIQUE INDEX "knowledge_indexes_collection_name_key" ON "knowledge_indexes"("collection_name");
CREATE INDEX "knowledge_indexes_status_created_at_idx" ON "knowledge_indexes"("status", "created_at");

CREATE UNIQUE INDEX "knowledge_source_indexes_source_id_index_id_key" ON "knowledge_source_indexes"("source_id", "index_id");
CREATE INDEX "knowledge_source_indexes_index_id_status_idx" ON "knowledge_source_indexes"("index_id", "status");
CREATE INDEX "knowledge_source_indexes_status_lease_expires_at_idx" ON "knowledge_source_indexes"("status", "lease_expires_at");

CREATE INDEX "knowledge_queries_workspace_id_created_at_idx" ON "knowledge_queries"("workspace_id", "created_at");
CREATE INDEX "knowledge_queries_status_created_at_idx" ON "knowledge_queries"("status", "created_at");

CREATE UNIQUE INDEX "knowledge_jobs_query_id_key" ON "knowledge_jobs"("query_id");
CREATE UNIQUE INDEX "knowledge_jobs_idempotency_key_key" ON "knowledge_jobs"("idempotency_key");
CREATE INDEX "knowledge_jobs_status_available_at_idx" ON "knowledge_jobs"("status", "available_at");
CREATE INDEX "knowledge_jobs_status_lease_expires_at_idx" ON "knowledge_jobs"("status", "lease_expires_at");
CREATE INDEX "knowledge_jobs_workspace_id_created_at_idx" ON "knowledge_jobs"("workspace_id", "created_at");
CREATE INDEX "knowledge_jobs_index_id_created_at_idx" ON "knowledge_jobs"("index_id", "created_at");

CREATE UNIQUE INDEX "embedding_invocations_job_id_batch_attempt_key" ON "embedding_invocations"("job_id", "batch", "attempt");
CREATE INDEX "embedding_invocations_index_id_started_at_idx" ON "embedding_invocations"("index_id", "started_at");
CREATE INDEX "embedding_invocations_source_index_id_started_at_idx" ON "embedding_invocations"("source_index_id", "started_at");
CREATE INDEX "embedding_invocations_query_id_started_at_idx" ON "embedding_invocations"("query_id", "started_at");

ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_artifact_id_fkey"
FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_created_by_fkey"
FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "knowledge_source_indexes" ADD CONSTRAINT "knowledge_source_indexes_source_id_fkey"
FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_source_indexes" ADD CONSTRAINT "knowledge_source_indexes_index_id_fkey"
FOREIGN KEY ("index_id") REFERENCES "knowledge_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_queries" ADD CONSTRAINT "knowledge_queries_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_queries" ADD CONSTRAINT "knowledge_queries_requested_by_fkey"
FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "knowledge_queries" ADD CONSTRAINT "knowledge_queries_index_id_fkey"
FOREIGN KEY ("index_id") REFERENCES "knowledge_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_index_id_fkey"
FOREIGN KEY ("index_id") REFERENCES "knowledge_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_source_index_id_fkey"
FOREIGN KEY ("source_index_id") REFERENCES "knowledge_source_indexes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_query_id_fkey"
FOREIGN KEY ("query_id") REFERENCES "knowledge_queries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "embedding_invocations" ADD CONSTRAINT "embedding_invocations_job_id_fkey"
FOREIGN KEY ("job_id") REFERENCES "knowledge_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "embedding_invocations" ADD CONSTRAINT "embedding_invocations_index_id_fkey"
FOREIGN KEY ("index_id") REFERENCES "knowledge_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "embedding_invocations" ADD CONSTRAINT "embedding_invocations_source_index_id_fkey"
FOREIGN KEY ("source_index_id") REFERENCES "knowledge_source_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "embedding_invocations" ADD CONSTRAINT "embedding_invocations_query_id_fkey"
FOREIGN KEY ("query_id") REFERENCES "knowledge_queries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
