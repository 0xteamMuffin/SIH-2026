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

/** Validation issues named in an error message. */
const MAX_REPORTED_ISSUES = 3;

/**
 * Describes a validation failure.
 *
 * Authenticated callers get the offending fields, because "task: String must
 * contain at least 1 character(s)" is actionable where a bare rejection is
 * not. Unauthenticated callers get nothing beyond the fact of failure: on the
 * login and refresh endpoints, field-level feedback is a free map of the
 * request schema for anyone probing the API.
 */
function validationError(error: ZodError, isAuthenticated: boolean): AppError {
  if (!isAuthenticated) return new AppError(400, "Request validation failed", "INVALID_INPUT");

  const detail = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
  return new AppError(400, detail ? `Request validation failed — ${detail}` : "Request validation failed", "INVALID_INPUT");
}

export function errorHandler(error: unknown, request: Request, response: Response, _next: NextFunction) {
  let appError: AppError;
  if (error instanceof AppError) appError = error;
  else if (error instanceof ZodError) appError = validationError(error, Boolean(request.user));
  else if (error instanceof SyntaxError && "status" in error && error.status === 400) appError = new AppError(400, "Malformed JSON request", "INVALID_JSON");
  else {
    response.err = error instanceof Error ? error : new Error("Unknown request error");
    appError = new AppError(500, "Internal server error", "INTERNAL_ERROR");
  }
  response.status(appError.status).json({ error: { code: appError.code, message: appError.message } });
}
