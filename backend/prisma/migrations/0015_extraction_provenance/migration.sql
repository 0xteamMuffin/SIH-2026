ALTER TABLE "artifacts"
ADD COLUMN "extraction_provenance_object_key" TEXT,
ADD COLUMN "extraction_provenance_sha256" TEXT,
ADD COLUMN "extraction_provenance_schema_version" INTEGER;

ALTER TABLE "artifacts"
ADD CONSTRAINT "artifacts_extraction_provenance_fields_check" CHECK (
    ("extraction_provenance_object_key" IS NULL
        AND "extraction_provenance_sha256" IS NULL
        AND "extraction_provenance_schema_version" IS NULL)
    OR
    ("extraction_provenance_object_key" IS NOT NULL
        AND "extraction_provenance_sha256" ~ '^[a-f0-9]{64}$'
        AND "extraction_provenance_schema_version" > 0)
);
