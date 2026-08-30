import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { app, createApp } from "../src/app.js";

describe("application boundary", () => {
  it("reports the configured operating mode", async () => {
    const isReady = vi.fn();
    const response = await request(createApp({ vectorStore: { isReady } })).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", mode: "development", sovereign: false });
    expect(isReady).not.toHaveBeenCalled();
  });

  it("reports readiness when Qdrant is available", async () => {
    const isReady = vi.fn().mockResolvedValue(true);
    const response = await request(createApp({ vectorStore: { isReady } })).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready", dependencies: { qdrant: "ready" } });
    expect(isReady).toHaveBeenCalledOnce();
  });

  it("fails readiness when Qdrant is unavailable", async () => {
    const isReady = vi.fn().mockResolvedValue(false);
    const response = await request(createApp({ vectorStore: { isReady } })).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "not_ready", dependencies: { qdrant: "unavailable" } });
  });

  it("fails readiness when the Qdrant check errors", async () => {
    const isReady = vi.fn().mockRejectedValue(new Error("connection failed"));
    const response = await request(createApp({ vectorStore: { isReady } })).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "not_ready", dependencies: { qdrant: "unavailable" } });
  });

  it("preserves a valid incoming request ID", async () => {
    const requestId = "4f73156a-942c-4f91-8974-1d57e6cf2b22";
    const response = await request(createApp({ vectorStore: { isReady: vi.fn() } }))
      .get("/health")
      .set("X-Request-ID", requestId);

    expect(response.headers["x-request-id"]).toBe(requestId);
  });

  it("replaces an invalid incoming request ID with a UUID", async () => {
    const response = await request(createApp({ vectorStore: { isReady: vi.fn() } }))
      .get("/health")
      .set("X-Request-ID", "not-a-uuid");

    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  });

  it("allows configured CORS origins", async () => {
    const response = await request(createApp({ vectorStore: { isReady: vi.fn() } }))
      .get("/health")
      .set("Origin", "https://app.test.local");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://app.test.local");
    expect(response.headers["access-control-expose-headers"]).toBe("X-Request-ID");
  });

  it("rejects unconfigured CORS origins", async () => {
    const response = await request(createApp({ vectorStore: { isReady: vi.fn() } }))
      .get("/health")
      .set("Origin", "https://attacker.test");

    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.body).toEqual({ error: { code: "CORS_ORIGIN_DENIED", message: "Origin is not allowed" } });
  });

  it("rate limits login attempts with a JSON error", async () => {
    const application = createApp({ vectorStore: { isReady: vi.fn() } });
    await request(application).post("/api/auth/login").send({ email: "invalid" });
    await request(application).post("/api/auth/login").send({ email: "invalid" });
    const response = await request(application).post("/api/auth/login").send({ email: "invalid" });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rate limits general API requests without limiting health checks", async () => {
    const application = createApp({ vectorStore: { isReady: vi.fn() } });
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
