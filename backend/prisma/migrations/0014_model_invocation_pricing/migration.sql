ALTER TABLE "model_invocations"
ADD COLUMN "estimated_cost_micros" INTEGER,
ADD COLUMN "pricing_version" TEXT,
ADD COLUMN "pricing_currency" TEXT;

ALTER TABLE "model_invocations"
ADD CONSTRAINT "model_invocations_estimated_cost_nonnegative_check" CHECK ("estimated_cost_micros" IS NULL OR "estimated_cost_micros" >= 0),
ADD CONSTRAINT "model_invocations_pricing_currency_check" CHECK ("pricing_currency" IS NULL OR "pricing_currency" = 'USD'),
ADD CONSTRAINT "model_invocations_pricing_metadata_check" CHECK (("pricing_version" IS NULL) = ("pricing_currency" IS NULL));
