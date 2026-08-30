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
