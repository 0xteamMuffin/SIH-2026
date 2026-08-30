import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "REQUEST_FAILED") {
    super(message);
  }
}

export function notFoundHandler(_request: Request, _response: Response, next: NextFunction) {
  next(new AppError(404, "Route not found", "NOT_FOUND"));
}

export function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction) {
  let appError: AppError;
  if (error instanceof AppError) appError = error;
  else if (error instanceof ZodError) appError = new AppError(400, "Request validation failed", "INVALID_INPUT");
  else if (error instanceof SyntaxError && "status" in error && error.status === 400) appError = new AppError(400, "Malformed JSON request", "INVALID_JSON");
  else {
    response.err = error instanceof Error ? error : new Error("Unknown request error");
    appError = new AppError(500, "Internal server error", "INTERNAL_ERROR");
  }
  response.status(appError.status).json({ error: { code: appError.code, message: appError.message } });
}
