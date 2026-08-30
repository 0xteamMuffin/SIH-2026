ALTER TABLE "artifacts"
ADD COLUMN "extraction_started_at" TIMESTAMP(3);

UPDATE "artifacts"
SET "extraction_status" = 'PENDING'
WHERE "kind" = 'SOURCE'
  AND "extraction_status" = 'NOT_REQUIRED';
