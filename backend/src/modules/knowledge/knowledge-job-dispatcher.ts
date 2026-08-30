import { KnowledgeJobStatus, KnowledgeJobType, type PrismaClient } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { failKnowledgeJob, processIndexSourceJob } from "./index-source-job.processor.js";
import { failKnowledgeQueryJob, processKnowledgeQueryJob } from "./knowledge-query-processor.js";
import { failRemoveSourceJob, processRemoveSourceJob } from "./remove-source-job.processor.js";
import { processRebuildIndexJob } from "./rebuild-index-job.processor.js";

type KnowledgeJobLookup = Pick<PrismaClient, "knowledgeJob">;
type ProcessJob = (jobId: string) => Promise<void>;
type FailJob = (jobId: string, error: unknown) => Promise<void>;

export type KnowledgeJobDispatcherDependencies = {
  store: KnowledgeJobLookup;
  processIndexSourceJob: ProcessJob;
  processKnowledgeQueryJob: ProcessJob;
  processRemoveSourceJob: ProcessJob;
  processRebuildIndexJob: ProcessJob;
  failKnowledgeJob: FailJob;
  failKnowledgeQueryJob: FailJob;
  failRemoveSourceJob: FailJob;
};

const defaults: KnowledgeJobDispatcherDependencies = {
  store: prisma,
  processIndexSourceJob,
  processKnowledgeQueryJob,
  processRemoveSourceJob,
  processRebuildIndexJob,
  failKnowledgeJob,
  failKnowledgeQueryJob,
  failRemoveSourceJob,
};

async function activeJobType(jobId: string, store: KnowledgeJobLookup): Promise<KnowledgeJobType | undefined> {
  const job = await store.knowledgeJob.findUnique({
    where: { id: jobId },
    select: { type: true, status: true },
  });
  if (!job || (job.status !== KnowledgeJobStatus.QUEUED && job.status !== KnowledgeJobStatus.RUNNING)) return undefined;
  return job.type;
}

function unsupportedType(type: KnowledgeJobType): AppError {
  return new AppError(422, `Knowledge job type ${type} is not supported by this worker`, "KNOWLEDGE_JOB_TYPE_UNSUPPORTED");
}

export async function processKnowledgeJob(
  jobId: string,
  overrides: Partial<KnowledgeJobDispatcherDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaults, ...overrides };
  const type = await activeJobType(jobId, dependencies.store);
  if (!type) return;

  if (type === KnowledgeJobType.INDEX_SOURCE) return dependencies.processIndexSourceJob(jobId);
  if (type === KnowledgeJobType.REMOVE_SOURCE) return dependencies.processRemoveSourceJob(jobId);
  if (type === KnowledgeJobType.REBUILD_INDEX) return dependencies.processRebuildIndexJob(jobId);
  if (type === KnowledgeJobType.EXECUTE_QUERY) return dependencies.processKnowledgeQueryJob(jobId);
  await dependencies.failKnowledgeJob(jobId, unsupportedType(type));
}

export async function failExhaustedKnowledgeJob(
  jobId: string,
  error: unknown,
  overrides: Partial<KnowledgeJobDispatcherDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaults, ...overrides };
  const type = await activeJobType(jobId, dependencies.store);
  if (!type) return;

  if (type === KnowledgeJobType.EXECUTE_QUERY) {
    await dependencies.failKnowledgeQueryJob(jobId, error);
    return;
  }
  if (type === KnowledgeJobType.REMOVE_SOURCE) {
    await dependencies.failRemoveSourceJob(jobId, error);
    return;
  }
  await dependencies.failKnowledgeJob(
    jobId,
    type === KnowledgeJobType.INDEX_SOURCE || type === KnowledgeJobType.REBUILD_INDEX ? error : unsupportedType(type),
  );
}
