import { randomUUID } from "node:crypto";
import type { Express } from "express";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestLogger = pinoHttp({
  logger,
  genReqId(request, response) {
    const incomingId = request.headers["x-request-id"];
    const requestId = typeof incomingId === "string" && UUID_PATTERN.test(incomingId) ? incomingId : randomUUID();
    response.setHeader("X-Request-ID", requestId);
    return requestId;
  },
  customLogLevel(_request, response, error) {
    if (error || response.statusCode >= 500) return "error";
    if (response.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(_request, response) {
    return response.statusCode >= 400 ? "request failed" : "request completed";
  },
  customErrorMessage() {
    return "request errored";
  },
});

const rateLimitHandler = (_request: express.Request, response: express.Response) => {
  response.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
};

export function mountRequestHardening(application: Express) {
  application.set("trust proxy", env.TRUST_PROXY_HOPS);
  application.use(requestLogger);
  application.use(helmet());
  application.use(cors({
    credentials: false,
    exposedHeaders: ["X-Request-ID"],
    origin(origin, callback) {
      if (!origin || env.CORS_ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new AppError(403, "Origin is not allowed", "CORS_ORIGIN_DENIED"));
    },
  }));
  application.use(express.json({ limit: "2mb" }));
}

export function mountApiRateLimits(application: Express) {
  const commonOptions = {
    standardHeaders: "draft-8" as const,
    legacyHeaders: false,
    handler: rateLimitHandler,
  };

  // The built-in memory store is appropriate for one API instance. Configure a
  // distributed store (for example Redis) before running multiple API replicas.
  application.use("/api/auth/login", rateLimit({
    ...commonOptions,
    windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
    limit: env.LOGIN_RATE_LIMIT_MAX,
  }));
  application.use("/api", rateLimit({
    ...commonOptions,
    windowMs: env.API_RATE_LIMIT_WINDOW_MS,
    limit: env.API_RATE_LIMIT_MAX,
  }));
}
