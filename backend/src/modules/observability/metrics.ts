import { Counter, Gauge, Registry, collectDefaultMetrics } from "@prometheus-io/client";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: "workbench_" });

const requests = new Counter({
  name: "workbench_http_requests_total",
  help: "Completed HTTP requests.",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [metricsRegistry],
});

new Gauge({
  name: "workbench_agent_runs",
  help: "Agent runs currently persisted by status.",
  labelNames: ["status"] as const,
  registers: [metricsRegistry],
  async collect() {
    this.reset();
    for (const row of await prisma.agentRun.groupBy({ by: ["status"], _count: { _all: true } })) {
      this.set({ status: row.status.toLowerCase() }, row._count._all);
    }
  },
});

new Gauge({
  name: "workbench_knowledge_jobs",
  help: "Knowledge jobs currently persisted by status and type.",
  labelNames: ["status", "type"] as const,
  registers: [metricsRegistry],
  async collect() {
    this.reset();
    for (const row of await prisma.knowledgeJob.groupBy({ by: ["status", "type"], _count: { _all: true } })) {
      this.set({ status: row.status.toLowerCase(), type: row.type.toLowerCase() }, row._count._all);
    }
  },
});

new Gauge({
  name: "workbench_model_invocations",
  help: "Model invocations currently persisted by status.",
  labelNames: ["status"] as const,
  registers: [metricsRegistry],
  async collect() {
    this.reset();
    for (const row of await prisma.modelInvocation.groupBy({ by: ["status"], _count: { _all: true } })) {
      this.set({ status: row.status.toLowerCase() }, row._count._all);
    }
  },
});

export function observeRequests(request: Request, response: Response, next: NextFunction) {
  response.once("finish", () => {
    const route = typeof request.route?.path === "string" ? request.route.path : "unmatched";
    requests.inc({ method: request.method, route, status_code: String(response.statusCode) });
  });
  next();
}
