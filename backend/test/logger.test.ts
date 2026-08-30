import { describe, expect, it } from "vitest";
import { createLogger } from "../src/lib/logger.js";

describe("logger", () => {
  it("redacts request credentials and application secrets", () => {
    let output = "";
    const logger = createLogger({ write: (message) => { output += message; } }, "info");

    logger.info({
      req: { headers: { authorization: "Bearer secret", cookie: "session=secret", "x-api-key": "secret" } },
      res: { headers: { "set-cookie": "session=secret" } },
      password: "secret",
      credentials: { password: "secret", token: "secret" },
      safe: "visible",
    });

    const record = JSON.parse(output);
    expect(record.req.headers).toEqual({
      authorization: "[Redacted]",
      cookie: "[Redacted]",
      "x-api-key": "[Redacted]",
    });
    expect(record.res.headers["set-cookie"]).toBe("[Redacted]");
    expect(record.password).toBe("[Redacted]");
    expect(record.credentials).toEqual({ password: "[Redacted]", token: "[Redacted]" });
    expect(record.safe).toBe("visible");
    expect(output).not.toContain("secret");
  });
});
