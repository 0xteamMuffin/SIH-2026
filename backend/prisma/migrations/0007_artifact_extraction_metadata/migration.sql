CREATE TYPE "ArtifactExtractionStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

ALTER TABLE "artifacts"
ADD COLUMN "sha256" TEXT,
ADD COLUMN "detected_mime_type" TEXT,
ADD COLUMN "extraction_status" "ArtifactExtractionStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN "extracted_object_key" TEXT,
ADD COLUMN "extraction_metadata" JSONB,
ADD COLUMN "extraction_error" TEXT,
ADD COLUMN "extracted_at" TIMESTAMP(3);

CREATE INDEX "artifacts_workspace_id_extraction_status_idx" ON "artifacts"("workspace_id", "extraction_status");
