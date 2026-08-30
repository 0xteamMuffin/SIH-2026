-- CreateEnum
CREATE TYPE "DataClassification" AS ENUM ('PUBLIC', 'SYNTHETIC', 'INTERNAL', 'CONFIDENTIAL');

-- AlterTable
ALTER TABLE "artifacts" ADD COLUMN "classification" "DataClassification" NOT NULL DEFAULT 'INTERNAL';

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN "data_classification" "DataClassification" NOT NULL DEFAULT 'INTERNAL';
