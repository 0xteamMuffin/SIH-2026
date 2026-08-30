import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";

describe("application boundary", () => {
  it("reports the configured operating mode", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", mode: "development", sovereign: false });
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
