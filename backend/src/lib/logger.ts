import pino, { type DestinationStream, type LevelWithSilent, type LoggerOptions } from "pino";
import { env } from "../config/env.js";

const options = (level: LevelWithSilent): LoggerOptions => ({
  level,
  base: undefined,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "res.headers['set-cookie']",
      "headers.authorization",
      "headers.cookie",
      "headers['x-api-key']",
      "password",
      "*.password",
      "token",
      "*.token",
    ],
    censor: "[Redacted]",
  },
});

export function createLogger(destination?: DestinationStream, level: LevelWithSilent = env.LOG_LEVEL) {
  return destination ? pino(options(level), destination) : pino(options(level));
}

export const logger = createLogger();
