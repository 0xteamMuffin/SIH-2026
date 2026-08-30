import { KnowledgeJobStatus, KnowledgeJobType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  failExhaustedKnowledgeJob,
  processKnowledgeJob,
  type KnowledgeJobDispatcherDependencies,
} from "../src/modules/knowledge/knowledge-job-dispatcher.js";

const jobId = "f06544e7-6922-4e7c-a025-3f98e934e56f";

function dependencies(type: KnowledgeJobType, status = KnowledgeJobStatus.QUEUED) {
  return {
    store: {
      knowledgeJob: {
        findUnique: vi.fn().mockResolvedValue({ type, status }),
      },
    },
    processIndexSourceJob: vi.fn().mockResolvedValue(undefined),
    processKnowledgeQueryJob: vi.fn().mockResolvedValue(undefined),
    failKnowledgeJob: vi.fn().mockResolvedValue(undefined),
    failKnowledgeQueryJob: vi.fn().mockResolvedValue(undefined),
  } as unknown as KnowledgeJobDispatcherDependencies;
}

describe("knowledge job dispatcher", () => {
  it.each([
    [KnowledgeJobType.INDEX_SOURCE, "processIndexSourceJob"],
    [KnowledgeJobType.EXECUTE_QUERY, "processKnowledgeQueryJob"],
  ] as const)("dispatches %s to its processor", async (type, processor) => {
    const input = dependencies(type);

    await processKnowledgeJob(jobId, input);

    expect(input[processor]).toHaveBeenCalledWith(jobId);
  });

  it.each([
    [KnowledgeJobType.INDEX_SOURCE, "failKnowledgeJob"],
    [KnowledgeJobType.EXECUTE_QUERY, "failKnowledgeQueryJob"],
  ] as const)("routes exhausted %s failures to the matching terminal handler", async (type, handler) => {
    const input = dependencies(type);
    const error = new Error("retries exhausted");

    await failExhaustedKnowledgeJob(jobId, error, input);

    expect(input[handler]).toHaveBeenCalledWith(jobId, error);
  });

  it("terminally fails unsupported job types without processing them", async () => {
    const input = dependencies(KnowledgeJobType.RECONCILE_INDEX);

    await processKnowledgeJob(jobId, input);

    expect(input.failKnowledgeJob).toHaveBeenCalledWith(jobId, expect.objectContaining({ code: "KNOWLEDGE_JOB_TYPE_UNSUPPORTED" }));
    expect(input.processIndexSourceJob).not.toHaveBeenCalled();
    expect(input.processKnowledgeQueryJob).not.toHaveBeenCalled();
  });

  it("uses a permanent unsupported-type error after retries", async () => {
    const input = dependencies(KnowledgeJobType.REBUILD_INDEX);

    await failExhaustedKnowledgeJob(jobId, new Error("transient failure"), input);

    expect(input.failKnowledgeJob).toHaveBeenCalledWith(jobId, expect.objectContaining({ code: "KNOWLEDGE_JOB_TYPE_UNSUPPORTED" }));
  });

  it.each([KnowledgeJobStatus.SUCCEEDED, KnowledgeJobStatus.FAILED, KnowledgeJobStatus.CANCELLED])(
    "ignores duplicate deliveries for terminal status %s",
    async (status) => {
      const input = dependencies(KnowledgeJobType.INDEX_SOURCE, status);

      await processKnowledgeJob(jobId, input);
      await failExhaustedKnowledgeJob(jobId, new Error("late failure"), input);

      expect(input.processIndexSourceJob).not.toHaveBeenCalled();
      expect(input.failKnowledgeJob).not.toHaveBeenCalled();
    },
  );

  it("ignores deliveries for deleted jobs", async () => {
    const input = dependencies(KnowledgeJobType.INDEX_SOURCE);
    vi.mocked(input.store.knowledgeJob.findUnique).mockResolvedValue(null);

    await processKnowledgeJob(jobId, input);
    await failExhaustedKnowledgeJob(jobId, new Error("late failure"), input);

    expect(input.processIndexSourceJob).not.toHaveBeenCalled();
    expect(input.failKnowledgeJob).not.toHaveBeenCalled();
  });
});
