import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { agentRun, knowledgeJob, modelInvocation } = vi.hoisted(() => ({
  agentRun: { groupBy: vi.fn() },
  knowledgeJob: { groupBy: vi.fn() },
  modelInvocation: { groupBy: vi.fn() },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { agentRun, knowledgeJob, modelInvocation } }));

import { metricsRegistry, observeRequests } from "../src/modules/observability/metrics.js";

describe("Prometheus metrics", () => {
  beforeEach(() => {
    metricsRegistry.resetMetrics();
    agentRun.groupBy.mockResolvedValue([{ status: "RUNNING", _count: { _all: 2 } }]);
    knowledgeJob.groupBy.mockResolvedValue([{ status: "QUEUED", type: "INDEX_SOURCE", _count: { _all: 3 } }]);
    modelInvocation.groupBy.mockResolvedValue([{ status: "SUCCEEDED", _count: { _all: 4 } }]);
  });

  it("exports persisted operational gauges without record identifiers", async () => {
    const output = await metricsRegistry.metrics();

    expect(output).toContain('workbench_agent_runs{status="running"} 2');
    expect(output).toContain('workbench_knowledge_jobs{status="queued",type="index_source"} 3');
    expect(output).toContain('workbench_model_invocations{status="succeeded"} 4');
    expect(output).not.toMatch(/workspace|user_id|run_id|job_id/);
  });

  it("labels requests by bounded route templates rather than URL values", async () => {
    const application = express();
    application.use(observeRequests);
    application.get("/items/:id", (_request, response) => response.sendStatus(204));
    await request(application).get("/items/50000000-0000-4000-8000-000000000001");

    const output = await metricsRegistry.getSingleMetricAsString("workbench_http_requests_total");
    expect(output).toContain('route="/items/:id"');
    expect(output).not.toContain("50000000-0000-4000-8000-000000000001");
  });
});
