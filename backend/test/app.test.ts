import request from "supertest";
import type { RequestHandler } from "express";
import { describe, expect, it, vi } from "vitest";
import { app, createApp } from "../src/app.js";

const allowOperationalAccess: RequestHandler = (_request, _response, next) => next();
const allReady = {
  status: "ready" as const,
  dependencies: {
    postgresql: "ready" as const,
    minio: "ready" as const,
    rabbitmq: "ready" as const,
    qdrant: "ready" as const,
    sandbox: "ready" as const,
    docling: "ready" as const,
  },
};

describe("application boundary", () => {
  it("reports the configured operating mode", async () => {
    const readiness = vi.fn();
    const response = await request(createApp({ readiness })).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", mode: "development", sovereign: false });
    expect(readiness).not.toHaveBeenCalled();
  });

  it("reports readiness when required dependencies are available", async () => {
    const readiness = vi.fn().mockResolvedValue(allReady);
    const response = await request(createApp({ readiness, operationalAuth: [allowOperationalAccess] })).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(allReady);
    expect(readiness).toHaveBeenCalledOnce();
  });

  it("fails readiness when a required dependency is unavailable", async () => {
    const result = { ...allReady, status: "not_ready" as const, dependencies: { ...allReady.dependencies, postgresql: "unavailable" as const } };
    const response = await request(createApp({ readiness: vi.fn().mockResolvedValue(result), operationalAuth: [allowOperationalAccess] })).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual(result);
  });

  it("protects operational details while leaving health public", async () => {
    const application = createApp({ readiness: vi.fn().mockResolvedValue(allReady) });

    expect((await request(application).get("/health")).status).toBe(200);
    expect((await request(application).get("/ready")).status).toBe(401);
    expect((await request(application).get("/metrics")).status).toBe(401);
  });

  it("serves Prometheus exposition after operational authorization", async () => {
    const metrics = {
      contentType: "text/plain; version=0.0.4; charset=utf-8" as const,
      metrics: vi.fn().mockResolvedValue("# HELP workbench_test Test metric\n# TYPE workbench_test gauge\nworkbench_test 1\n"),
    };
    const response = await request(createApp({ operationalAuth: [allowOperationalAccess], metrics })).get("/metrics");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("workbench_test 1");
    expect(metrics.metrics).toHaveBeenCalledOnce();
  });

  it("preserves a valid incoming request ID", async () => {
    const requestId = "4f73156a-942c-4f91-8974-1d57e6cf2b22";
    const response = await request(createApp())
      .get("/health")
      .set("X-Request-ID", requestId);

    expect(response.headers["x-request-id"]).toBe(requestId);
  });

  it("replaces an invalid incoming request ID with a UUID", async () => {
    const response = await request(createApp())
      .get("/health")
      .set("X-Request-ID", "not-a-uuid");

    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  });

  it("allows configured CORS origins", async () => {
    const response = await request(createApp())
      .get("/health")
      .set("Origin", "https://app.test.local");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://app.test.local");
    expect(response.headers["access-control-expose-headers"]).toBe("X-Request-ID");
  });

  it("rejects unconfigured CORS origins", async () => {
    const response = await request(createApp())
      .get("/health")
      .set("Origin", "https://attacker.test");

    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.body).toEqual({ error: { code: "CORS_ORIGIN_DENIED", message: "Origin is not allowed" } });
  });

  it("rate limits login attempts with a JSON error", async () => {
    const application = createApp();
    await request(application).post("/api/auth/login").send({ email: "invalid" });
    await request(application).post("/api/auth/login").send({ email: "invalid" });
    const response = await request(application).post("/api/auth/login").send({ email: "invalid" });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rate limits general API requests without limiting health checks", async () => {
    const application = createApp();
    await request(application).get("/api/unknown");
    await request(application).get("/api/unknown");
    await request(application).get("/api/unknown");
    const limited = await request(application).get("/api/unknown");
    const health = await request(application).get("/health");

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    expect(health.status).toBe(200);
  });

  it("returns a JSON error for unknown routes", async () => {
    const response = await request(app).get("/api/unknown");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  it("returns a stable validation error", async () => {
    const response = await request(app).post("/api/auth/login").send({ email: "invalid" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: "INVALID_INPUT", message: "Request validation failed" } });
  });

  it("rejects malformed JSON", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("content-type", "application/json")
      .send('{"email":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: "INVALID_JSON", message: "Malformed JSON request" } });
  });
});
